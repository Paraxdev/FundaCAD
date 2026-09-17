//! The engine worker: one request loop shared by every transport.
//!
//! Replaces the request handling of `sidecar/server.py` (`handle`,
//! `_serialized`, `_dispatch`, `_cancel_running`, `_apply_doc_ops`). Heavy ops
//! run one at a time on a job thread; `cancel` and `ping` answer on the read
//! path so they are heard while a job runs. The geometry itself is behind
//! [`Jobs`], so this crate builds and tests without OpenCASCADE.

mod doc_state;
pub mod stdio;
pub mod supervise;
pub mod sysmem;
#[cfg(feature = "ws")]
pub mod ws;

pub use doc_state::DocState;
pub use supervise::{Budget, Clocks};

use fundacad_protocol::{
    envelope, send_reply, CancelToken, JobResult, Limits, Message, ReplyOptions,
};
use serde_json::{json, Map, Value};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Where replies go. A stream's messages must reach the client back to back,
/// so a transport sends the whole iterator under one lock.
pub trait Outbox: Send + Sync + 'static {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()>;
}

/// What a running job reports, read by the progress ticker.
#[derive(Debug, Default)]
pub struct Progress {
    feature: AtomicI64,
    meshed: AtomicI64,
    mesh_total: AtomicI64,
    beats: AtomicU64,
}

impl Progress {
    pub fn feature(&self, index: i64) {
        self.feature.store(index, Ordering::Relaxed);
        self.tick();
    }

    /// Meshing phase: `meshed` of `total` bodies. (-1, -1) leaves it.
    pub fn meshing(&self, meshed: i64, total: i64) {
        self.feature.store(-1, Ordering::Relaxed);
        self.meshed.store(meshed, Ordering::Relaxed);
        self.mesh_total.store(total, Ordering::Relaxed);
        self.tick();
    }

    /// Proof of life for the stall watchdog, from a phase with no feature or
    /// body counter to report (an export write, a pair sweep).
    pub fn tick(&self) {
        self.beats.fetch_add(1, Ordering::Relaxed);
    }

    fn reset(&self) {
        self.feature.store(-1, Ordering::Relaxed);
        self.meshed.store(-1, Ordering::Relaxed);
        self.mesh_total.store(-1, Ordering::Relaxed);
    }
}

pub struct JobContext {
    pub cancel: CancelToken,
    pub progress: Arc<Progress>,
}

/// The geometry side of the engine.
pub trait Jobs: Send + 'static {
    /// Rebuild `doc` and mesh it. `known` maps body id to the etag the client
    /// already holds, `fresh` bypasses every cache (`computeAll`).
    fn rebuild(
        &mut self,
        doc: &Value,
        tolerance: f64,
        known: &Map<String, Value>,
        fresh: bool,
        ctx: &JobContext,
    ) -> JobResult;

    /// Any other heavy op. The default refuses it the way server.py refuses an
    /// op it does not know.
    fn run(&mut self, op: &str, _req: &Map<String, Value>, _ctx: &JobContext) -> JobResult {
        error_result(&format!("unknown op: {op}"))
    }
}

pub fn error_result(message: &str) -> JobResult {
    let mut m = Map::new();
    m.insert("error".into(), json!({ "message": message }));
    JobResult::Json(m)
}

struct Running {
    id: Value,
    client: u64,
    cancel: CancelToken,
    serial: u64,
}

/// How an engine supervises its jobs.
#[derive(Debug, Clone, Copy, Default)]
pub struct EngineOptions {
    /// How long a cancelled job may keep running before it is answered as
    /// cancelled and abandoned. None leaves that to a supervising process.
    pub cancel_grace: Option<Duration>,
    pub clocks: Clocks,
    /// Answer `testSleep`, see [`supervise::test_sleep`].
    pub test_ops: bool,
}

impl EngineOptions {
    pub fn from_env() -> EngineOptions {
        EngineOptions {
            cancel_grace: None,
            clocks: Clocks::from_env(),
            test_ops: supervise::test_ops_enabled(),
        }
    }
}

/// Makes the jobs of a replacement job thread.
pub type Respawn<J> = Arc<dyn Fn() -> J + Send + Sync>;

/// What every job thread of one engine shares. There is one live job thread;
/// an abandoned one keeps only its running job and never takes another.
struct Pool<J> {
    rx: Mutex<mpsc::Receiver<Queued>>,
    running: Arc<Mutex<Option<Running>>>,
    respawn: Option<Respawn<J>>,
    opts: EngineOptions,
    serial: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn spawn_job_thread<J: Jobs>(pool: Arc<Pool<J>>, mut jobs: J) {
    let spawned = std::thread::Builder::new()
        .name("engine-jobs".into())
        .spawn(move || {
            let mut docs = DocState::default();
            let abandoned = Arc::new(AtomicBool::new(false));
            while !abandoned.load(Ordering::SeqCst) {
                let Ok(q) = lock(&pool.rx).recv() else { return };
                if q.closed.load(Ordering::SeqCst) {
                    continue;
                }
                run_one(&pool, &mut jobs, &mut docs, q, &abandoned);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[engine] cannot start a job thread: {e}");
    }
}

/// Leaves the job thread running `serial` to finish on its own and hands the
/// queue to a fresh one, server.py's `_kill_pool` plus `_new_pool`.
fn abandon<J: Jobs>(pool: &Arc<Pool<J>>, abandoned: &AtomicBool, serial: u64) {
    let Some(make) = pool.respawn.clone() else { return };
    abandoned.store(true, Ordering::SeqCst);
    clear_running(pool, serial);
    spawn_job_thread(pool.clone(), make());
}

fn clear_running<J>(pool: &Pool<J>, serial: u64) {
    let mut running = lock(&pool.running);
    if running.as_ref().is_some_and(|r| r.serial == serial) {
        *running = None;
    }
}

struct Queued {
    req: Map<String, Value>,
    client: u64,
    out: Arc<dyn Outbox>,
    closed: Arc<AtomicBool>,
}

/// One engine: a job thread and the read path in front of it. Every client of
/// an engine shares its job thread, held document and caches, so the jobs of
/// all connections run one at a time, as under server.py's `_JOB_LOCK`.
pub struct Engine {
    jobs: mpsc::Sender<Queued>,
    running: Arc<Mutex<Option<Running>>>,
    out: Arc<dyn Outbox>,
    next_client: AtomicU64,
    never_closed: Arc<AtomicBool>,
}

const PROGRESS_EVERY: Duration = Duration::from_secs(1);

impl Engine {
    /// An engine with the default clocks and no respawn: a job that overstays
    /// is answered, and the jobs behind it wait for its thread.
    pub fn start<J: Jobs>(jobs: J, out: Arc<dyn Outbox>) -> Engine {
        Engine::start_with(jobs, None, EngineOptions::default(), out)
    }

    /// `respawn` makes the jobs of the job thread that replaces one abandoned
    /// after a stall, a timeout or an ignored cancel.
    pub fn start_with<J: Jobs>(
        jobs: J,
        respawn: Option<Respawn<J>>,
        opts: EngineOptions,
        out: Arc<dyn Outbox>,
    ) -> Engine {
        let (tx, rx) = mpsc::channel::<Queued>();
        let running: Arc<Mutex<Option<Running>>> = Arc::default();
        let pool = Arc::new(Pool {
            rx: Mutex::new(rx),
            running: running.clone(),
            respawn,
            opts,
            serial: AtomicU64::new(1),
        });
        spawn_job_thread(pool, jobs);
        Engine {
            jobs: tx,
            running,
            out,
            next_client: AtomicU64::new(1),
            never_closed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A client whose replies go to `out`. Its cancel reaches only its own
    /// jobs, and dropping it drops its queued jobs and cancels its running one,
    /// as closing a connection does in server.py's `handle`.
    pub fn client(self: &Arc<Self>, out: Arc<dyn Outbox>) -> Client {
        Client {
            engine: self.clone(),
            id: self.next_client.fetch_add(1, Ordering::Relaxed),
            out,
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// One incoming message, answered to the outbox the engine started with.
    pub fn handle(&self, msg: Message) {
        self.handle_for(0, &self.out, &self.never_closed, msg);
    }

    fn handle_for(
        &self,
        client: u64,
        out: &Arc<dyn Outbox>,
        closed: &Arc<AtomicBool>,
        msg: Message,
    ) {
        let reply = |text: String| {
            let _ = out.send(&mut std::iter::once(Message::Text(text)));
        };
        let Message::Text(text) = msg else {
            reply(envelope::err(&Value::Null, "requests are JSON text", None));
            return;
        };
        let req: Map<String, Value> = match serde_json::from_str(&text) {
            Ok(Value::Object(m)) => m,
            Ok(_) => {
                reply(envelope::bad_json("a request is a JSON object"));
                return;
            }
            Err(e) => {
                reply(envelope::bad_json(&e.to_string()));
                return;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        match req.get("op").and_then(Value::as_str) {
            Some("cancel") => {
                let hit = self.cancel(client, req.get("target"));
                reply(envelope::cancel_ack(&id, hit));
            }
            Some("ping") => reply(envelope::ok(&id, &json!({ "pong": true }))),
            _ => {
                let queued = Queued {
                    req,
                    client,
                    out: out.clone(),
                    closed: closed.clone(),
                };
                if self.jobs.send(queued).is_err() {
                    reply(envelope::err(&id, "the engine job thread is gone", None));
                }
            }
        }
    }

    /// Cancels `client`'s running job, only if it is `target` when one is given.
    fn cancel(&self, client: u64, target: Option<&Value>) -> bool {
        let guard = self.running.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(r) if r.client == client && target.map_or(true, |t| t.is_null() || *t == r.id) => {
                r.cancel.cancel();
                true
            }
            _ => false,
        }
    }
}

/// One connection's handle on a shared [`Engine`].
pub struct Client {
    engine: Arc<Engine>,
    id: u64,
    out: Arc<dyn Outbox>,
    closed: Arc<AtomicBool>,
}

impl Client {
    pub fn handle(&self, msg: Message) {
        self.engine
            .handle_for(self.id, &self.out, &self.closed, msg);
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        self.engine.cancel(self.id, None);
    }
}

fn run_one<J: Jobs>(
    pool: &Arc<Pool<J>>,
    jobs: &mut J,
    docs: &mut DocState,
    q: Queued,
    abandoned: &Arc<AtomicBool>,
) {
    let Queued {
        req, client, out, ..
    } = q;
    let out = &out;
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let cancel = CancelToken::new();
    let serial = pool.serial.fetch_add(1, Ordering::SeqCst);
    *lock(&pool.running) = Some(Running {
        id: id.clone(),
        client,
        cancel: cancel.clone(),
        serial,
    });

    let progress = Arc::new(Progress::default());
    progress.reset();
    let ctx = JobContext {
        cancel: cancel.clone(),
        progress: progress.clone(),
    };
    let claimed = Arc::new(AtomicBool::new(false));
    let ticking = Arc::new(AtomicBool::new(true));
    let on_breach = {
        let pool = pool.clone();
        let abandoned = abandoned.clone();
        move || abandon(&pool, &abandoned, serial)
    };
    let watchdog = spawn_watchdog(
        WatchedJob {
            id: id.clone(),
            frames: op == "rebuild" || op == "computeAll",
            progress,
            ticking: ticking.clone(),
            claimed: claimed.clone(),
            cancel: cancel.clone(),
            out: out.clone(),
            watchdog: supervise::Watchdog::new(
                pool.opts.clocks.budget(&op, &req),
                pool.opts.cancel_grace,
            ),
        },
        on_breach,
    );

    let result = match op.as_str() {
        "rebuild" | "computeAll" => {
            let tolerance = req.get("tolerance").and_then(Value::as_f64).unwrap_or(0.1);
            let empty = Map::new();
            let known = req
                .get("known")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let fresh = op == "computeAll";
            match docs.apply(&req, fresh) {
                Some(doc) => jobs.rebuild(doc, tolerance, known, fresh, &ctx),
                None => {
                    let mut m = Map::new();
                    m.insert("resync".into(), Value::Bool(true));
                    JobResult::Json(m)
                }
            }
        }
        "" => error_result("a request needs an op"),
        supervise::TEST_SLEEP_OP if pool.opts.test_ops => supervise::test_sleep(&req, &ctx),
        other => jobs.run(other, &req, &ctx),
    };

    let answered_elsewhere = claimed.swap(true, Ordering::SeqCst);
    ticking.store(false, Ordering::SeqCst);
    let _ = watchdog.join();
    if answered_elsewhere {
        clear_running(pool, serial);
        return;
    }
    let result = if cancel.is_cancelled() {
        let mut m = Map::new();
        if let Value::Object(c) = envelope::cancelled_result() {
            m = c;
        }
        JobResult::Json(m)
    } else {
        result
    };
    let opts = ReplyOptions {
        binary: truthy(req.get("binary")),
        chunked: truthy(req.get("chunked")),
    };
    let mut reply = send_reply(id, result, opts, Some(cancel), Limits::default());
    let _ = out.send(&mut reply);
    clear_running(pool, serial);
}

fn truthy(v: Option<&Value>) -> bool {
    fundacad_protocol::pyjson::truthy(v)
}

struct WatchedJob {
    id: Value,
    /// Whether to stream `building` frames, which only a rebuild does.
    frames: bool,
    progress: Arc<Progress>,
    ticking: Arc<AtomicBool>,
    /// Set by whoever answers the request first, the job or its watchdog.
    claimed: Arc<AtomicBool>,
    cancel: CancelToken,
    out: Arc<dyn Outbox>,
    watchdog: supervise::Watchdog,
}

/// Streams a rebuild's progress and ends a job that stalls, overstays its wall
/// clock or ignores a cancel past its grace, server.py `_run_stall` and `_run`.
fn spawn_watchdog(
    mut job: WatchedJob,
    on_breach: impl FnOnce() + Send + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let step = Duration::from_millis(50);
        let mut waited = Duration::ZERO;
        while job.ticking.load(Ordering::SeqCst) {
            std::thread::sleep(step);
            waited += step;
            let breach = job.watchdog.poll(
                job.progress.beats.load(Ordering::Relaxed),
                job.cancel.is_cancelled(),
                std::time::Instant::now(),
            );
            if let Some(breach) = breach {
                if job.claimed.swap(true, Ordering::SeqCst) {
                    return;
                }
                if !matches!(breach, supervise::Breach::IgnoredCancel) {
                    eprintln!("[engine] {} {breach:?}, abandoning its job thread", job.id);
                }
                job.cancel.cancel();
                let text = envelope::reply_for(&job.id, &breach.result());
                let _ = job.out.send(&mut std::iter::once(Message::Text(text)));
                on_breach();
                return;
            }
            if !job.frames || waited < PROGRESS_EVERY {
                continue;
            }
            waited = Duration::ZERO;
            if !job.ticking.load(Ordering::SeqCst) {
                break;
            }
            let frame = envelope::building(
                &job.id,
                job.progress.feature.load(Ordering::Relaxed),
                job.progress.meshed.load(Ordering::Relaxed),
                job.progress.mesh_total.load(Ordering::Relaxed),
            );
            let _ = job.out.send(&mut std::iter::once(Message::Text(frame)));
        }
    })
}

#[cfg(test)]
mod tests;
