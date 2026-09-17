//! The engine worker: one request loop shared by every transport.
//!
//! Replaces the request handling of `sidecar/server.py` (`handle`,
//! `_serialized`, `_dispatch`, `_cancel_running`, `_apply_doc_ops`). Heavy ops
//! run one at a time on a job thread; `cancel` and `ping` answer on the read
//! path so they are heard while a job runs. The geometry itself is behind
//! [`Jobs`], so this crate builds and tests without OpenCASCADE.

mod doc_state;
pub mod stdio;

pub use doc_state::DocState;

use fundacad_protocol::{
    envelope, send_reply, CancelToken, JobResult, Limits, Message, ReplyOptions,
};
use serde_json::{json, Map, Value};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
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
}

impl Progress {
    pub fn feature(&self, index: i64) {
        self.feature.store(index, Ordering::Relaxed);
    }

    /// Meshing phase: `meshed` of `total` bodies. (-1, -1) leaves it.
    pub fn meshing(&self, meshed: i64, total: i64) {
        self.feature.store(-1, Ordering::Relaxed);
        self.meshed.store(meshed, Ordering::Relaxed);
        self.mesh_total.store(total, Ordering::Relaxed);
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
    cancel: CancelToken,
}

/// One engine: a job thread and the read path in front of it.
pub struct Engine {
    jobs: mpsc::Sender<Map<String, Value>>,
    running: Arc<Mutex<Option<Running>>>,
    out: Arc<dyn Outbox>,
}

const PROGRESS_EVERY: Duration = Duration::from_secs(1);

impl Engine {
    pub fn start<J: Jobs>(mut jobs: J, out: Arc<dyn Outbox>) -> Engine {
        let (tx, rx) = mpsc::channel::<Map<String, Value>>();
        let running: Arc<Mutex<Option<Running>>> = Arc::default();
        let (job_out, job_running) = (out.clone(), running.clone());
        std::thread::Builder::new()
            .name("engine-jobs".into())
            .spawn(move || {
                let mut docs = DocState::default();
                for req in rx {
                    run_one(&mut jobs, &mut docs, req, &job_out, &job_running);
                }
            })
            .expect("spawn the engine job thread");
        Engine {
            jobs: tx,
            running,
            out,
        }
    }

    /// One incoming message, on the transport's read path.
    pub fn handle(&self, msg: Message) {
        let Message::Text(text) = msg else {
            self.reply(envelope::err(&Value::Null, "requests are JSON text", None));
            return;
        };
        let req: Map<String, Value> = match serde_json::from_str(&text) {
            Ok(Value::Object(m)) => m,
            Ok(_) => {
                self.reply(envelope::bad_json("a request is a JSON object"));
                return;
            }
            Err(e) => {
                self.reply(envelope::bad_json(&e.to_string()));
                return;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        match req.get("op").and_then(Value::as_str) {
            Some("cancel") => {
                let hit = self.cancel(req.get("target"));
                self.reply(envelope::cancel_ack(&id, hit));
            }
            Some("ping") => self.reply(envelope::ok(&id, &json!({ "pong": true }))),
            _ => {
                if self.jobs.send(req).is_err() {
                    self.reply(envelope::err(&id, "the engine job thread is gone", None));
                }
            }
        }
    }

    /// Cancels the running job, only if it is `target` when one is given.
    fn cancel(&self, target: Option<&Value>) -> bool {
        let guard = self.running.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(r) if target.map_or(true, |t| t.is_null() || *t == r.id) => {
                r.cancel.cancel();
                true
            }
            _ => false,
        }
    }

    fn reply(&self, text: String) {
        let _ = self.out.send(&mut std::iter::once(Message::Text(text)));
    }
}

fn run_one<J: Jobs>(
    jobs: &mut J,
    docs: &mut DocState,
    req: Map<String, Value>,
    out: &Arc<dyn Outbox>,
    running: &Arc<Mutex<Option<Running>>>,
) {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let cancel = CancelToken::new();
    *running.lock().unwrap_or_else(|p| p.into_inner()) = Some(Running {
        id: id.clone(),
        cancel: cancel.clone(),
    });

    let progress = Arc::new(Progress::default());
    progress.reset();
    let ctx = JobContext {
        cancel: cancel.clone(),
        progress: progress.clone(),
    };
    let ticking = Arc::new(AtomicBool::new(op == "rebuild" || op == "computeAll"));
    let ticker = spawn_ticker(id.clone(), progress, ticking.clone(), out.clone());

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
        other => jobs.run(other, &req, &ctx),
    };

    ticking.store(false, Ordering::SeqCst);
    let _ = ticker.join();
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
    *running.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

fn truthy(v: Option<&Value>) -> bool {
    fundacad_protocol::pyjson::truthy(v)
}

fn spawn_ticker(
    id: Value,
    progress: Arc<Progress>,
    ticking: Arc<AtomicBool>,
    out: Arc<dyn Outbox>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let step = Duration::from_millis(50);
        let mut waited = Duration::ZERO;
        while ticking.load(Ordering::SeqCst) {
            std::thread::sleep(step);
            waited += step;
            if waited < PROGRESS_EVERY {
                continue;
            }
            waited = Duration::ZERO;
            if !ticking.load(Ordering::SeqCst) {
                break;
            }
            let frame = envelope::building(
                &id,
                progress.feature.load(Ordering::Relaxed),
                progress.meshed.load(Ordering::Relaxed),
                progress.mesh_total.load(Ordering::Relaxed),
            );
            let _ = out.send(&mut std::iter::once(Message::Text(frame)));
        }
    })
}

#[cfg(test)]
mod tests;
