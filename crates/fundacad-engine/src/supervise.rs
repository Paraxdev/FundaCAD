//! How long a job may run, and what ends one that overstays. A job thread cannot be killed, so it is abandoned: the
//! request is answered, the thread finishes with nowhere to send, and a fresh job thread takes the queue.

use crate::JobContext;
use fundacad_protocol::JobResult;
use serde_json::{Map, Value};
use std::time::{Duration, Instant};

pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);
pub const JOB_TIMEOUT: Duration = Duration::from_secs(25);
const GENERATE_SHAPE_TIMEOUT: Duration = Duration::from_secs(180);
const EXPORT_SEC_PER_BODY: f64 = 0.09;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Budget {
    /// Reaped only after this long without a progress beat.
    Stall(Duration),
    /// Reaped this long after it started, ticking or not.
    Wall(Duration),
}

/// The base clocks, `FUNDACAD_STALL_TIMEOUT` and `FUNDACAD_JOB_TIMEOUT` in seconds when set, so a protocol test can
/// watch a reap without waiting a minute.
#[derive(Debug, Clone, Copy)]
pub struct Clocks {
    pub stall: Duration,
    pub job: Duration,
}

impl Clocks {
    pub fn from_env() -> Clocks {
        let secs = |name: &str, default: Duration| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|s| s.is_finite() && *s > 0.0)
                .map_or(default, Duration::from_secs_f64)
        };
        Clocks { stall: secs("FUNDACAD_STALL_TIMEOUT", STALL_TIMEOUT), job: secs("FUNDACAD_JOB_TIMEOUT", JOB_TIMEOUT) }
    }

    /// Which clock, stall or wall, `op` runs under, and for how long.
    pub fn budget(&self, op: &str, req: &Map<String, Value>) -> Budget {
        match op {
            "listFonts" | "tessellateText" | "migrateGeometry" => Budget::Wall(self.job),
            "generateShape" => Budget::Wall(GENERATE_SHAPE_TIMEOUT.max(self.job)),
            "export" | "exportWith" => Budget::Stall(self.export_budget(req.get("document"))),
            "import" => Budget::Stall(self.import_budget(req.get("path"))),
            TEST_SLEEP_OP if truthy(req.get("wall")) => Budget::Wall(self.job),
            _ => Budget::Stall(self.stall),
        }
    }

    /// The write is one silent kernel call, so the budget scales with the bodies it writes.
    fn export_budget(&self, doc: Option<&Value>) -> Duration {
        let n: usize = doc.and_then(|d| d.get("features")).and_then(Value::as_array).map_or(0, |feats| {
            feats
                .iter()
                .filter(|f| f.is_object())
                .map(|f| f.get("parts").and_then(Value::as_array).map_or(0, Vec::len).max(1))
                .sum()
        });
        self.stall.max(Duration::from_secs_f64(EXPORT_SEC_PER_BODY * n as f64))
    }

    /// A read that cannot tick, so a budget from the file size.
    fn import_budget(&self, path: Option<&Value>) -> Duration {
        let mib = path
            .and_then(Value::as_str)
            .and_then(|p| std::fs::metadata(p).ok())
            .map_or(0.0, |m| m.len() as f64 / (1024.0 * 1024.0));
        Duration::from_secs_f64(90f64.max(60.0 + 1.5 * mib))
    }
}

impl Default for Clocks {
    fn default() -> Clocks {
        Clocks { stall: STALL_TIMEOUT, job: JOB_TIMEOUT }
    }
}

fn truthy(v: Option<&Value>) -> bool {
    fundacad_protocol::pyjson::truthy(v)
}

/// Why a job was ended from outside.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Breach {
    Stalled(Duration),
    TimedOut,
    IgnoredCancel,
}

impl Breach {
    /// The result the request is answered with, server.py's wording.
    pub fn result(self) -> Map<String, Value> {
        self.result_in(None)
    }

    /// [`Breach::result`], naming what a stalled job was inside when known, so
    /// a report of a stall that cannot be reproduced still says where it was.
    pub fn result_in(self, doing: Option<&str>) -> Map<String, Value> {
        let message = match self {
            Breach::Stalled(d) => {
                let mut m = format!(
                    "one operation stalled for over {} s, the geometry kernel was restarted; progress up to the last checkpoint is kept",
                    d.as_secs()
                );
                if let Some(at) = doing {
                    m.push_str(&format!(" (it was stuck in {at})"));
                }
                m
            }
            Breach::TimedOut => "operation timed out, geometry too complex or degenerate".into(),
            Breach::IgnoredCancel => {
                if let Value::Object(m) = fundacad_protocol::envelope::cancelled_result() {
                    return m;
                }
                "cancelled".into()
            }
        };
        let mut error = Map::new();
        error.insert("message".into(), Value::String(message));
        let mut m = Map::new();
        m.insert("error".into(), Value::Object(error));
        m
    }
}

/// One job's clocks, polled by its watchdog.
pub struct Watchdog {
    budget: Budget,
    cancel_grace: Option<Duration>,
    started: Instant,
    last_beat: u64,
    last_beat_at: Instant,
    cancelled_at: Option<Instant>,
}

impl Watchdog {
    pub fn new(budget: Budget, cancel_grace: Option<Duration>) -> Watchdog {
        let now = Instant::now();
        Watchdog { budget, cancel_grace, started: now, last_beat: 0, last_beat_at: now, cancelled_at: None }
    }

    pub fn poll(&mut self, beats: u64, cancelled: bool, now: Instant) -> Option<Breach> {
        if beats != self.last_beat {
            self.last_beat = beats;
            self.last_beat_at = now;
        }
        if cancelled {
            let at = *self.cancelled_at.get_or_insert(now);
            if self.cancel_grace.is_some_and(|g| now.duration_since(at) >= g) {
                return Some(Breach::IgnoredCancel);
            }
        }
        match self.budget {
            Budget::Stall(d) if now.duration_since(self.last_beat_at) > d => Some(Breach::Stalled(d)),
            Budget::Wall(d) if now.duration_since(self.started) > d => Some(Breach::TimedOut),
            _ => None,
        }
    }
}

/// A job that only waits, so the protocol suites have something long to cancel and silent to reap without a 356 MiB
/// STEP file. Answered only when `FUNDACAD_ENGINE_TEST_OPS=1` is set when the engine starts.
pub const TEST_SLEEP_OP: &str = "testSleep";

pub fn test_ops_enabled() -> bool {
    std::env::var("FUNDACAD_ENGINE_TEST_OPS").is_ok_and(|v| v == "1")
}

/// `{"seconds": s, "tick": bool}`: sleeps `s`, beating every 100 ms when `tick`,
/// and stops early on cancel unless `"deaf": true`.
pub fn test_sleep(req: &Map<String, Value>, ctx: &JobContext) -> JobResult {
    let seconds = req.get("seconds").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.0, 600.0);
    let tick = truthy(req.get("tick"));
    let deaf = truthy(req.get("deaf"));
    let end = Instant::now() + Duration::from_secs_f64(seconds);
    while Instant::now() < end {
        if !deaf && ctx.cancel.is_cancelled() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
        if tick {
            ctx.progress.tick();
        }
    }
    let mut m = Map::new();
    m.insert("slept".into(), Value::from(seconds));
    JobResult::Json(m)
}

/// `FUNDACAD_TEST_HOLD="import=20000,rebuild=6000"`: how long a job of `op` is held before it runs, in ms.
pub fn hold_ms(spec: &str, op: &str) -> Option<u64> {
    spec.split(',').filter_map(|p| p.trim().split_once('=')).find(|(o, _)| *o == op).and_then(|(_, ms)| ms.parse().ok())
}

/// Holds a job at its start for the time `FUNDACAD_TEST_HOLD` gives its op, so an end to end check can switch
/// documents while a long job runs. Beats while it waits and stops on cancel.
pub fn test_hold(op: &str, ctx: &JobContext) {
    let Some(ms) = std::env::var("FUNDACAD_TEST_HOLD").ok().and_then(|s| hold_ms(&s, op)) else { return };
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end && !ctx.cancel.is_cancelled() {
        std::thread::sleep(Duration::from_millis(50));
        ctx.progress.tick();
    }
}
