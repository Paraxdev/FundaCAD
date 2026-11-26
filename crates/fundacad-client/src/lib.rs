//! The native app's link to the engine: one supervised worker process over stdio (docs/ENGINE.md 2.1), a document
//! the app edits, and every rebuild handed back as plain buffers on an event channel.

mod doc;
mod mesh;
pub mod transfer;
mod worker;

pub use doc::set_param;
pub use mesh::{Body, Edges, Mesh, Timing};
pub use worker::WorkerCommand;

use doc::Held;
use fundacad_protocol::{message_id, Message};
use mesh::{Assembly, BodyCache, ReplyError, Step};
use serde_json::{json, Map, Value};
use std::any::Any;
use std::collections::HashMap;
use std::io::{self, ErrorKind, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use worker::{FromWorker, Worker};

const RESTART_FLOOR: Duration = Duration::from_millis(500);
const RESTART_CEILING: Duration = Duration::from_secs(10);
/// A worker that stayed up this long crashed for a new reason, not in a loop.
const HEALTHY_AFTER: Duration = Duration::from_secs(30);

pub type Doc = Map<String, Value>;

#[derive(Debug, Clone)]
pub enum Event {
    Mesh(Arc<Mesh>),
    /// A `building` frame: `phase` per `fundacad_protocol::build_phase`, -1 where a counter does not apply.
    Progress {
        revision: u64,
        phase: i64,
        feature: i64,
        meshed: i64,
        mesh_total: i64,
    },
    /// A rebuild failed. The last mesh stays the current one.
    Failed {
        revision: u64,
        message: String,
        feature_id: Option<String>,
    },
    /// The worker died and a new one is starting; any rebuild it was running is sent again.
    WorkerRestarted {
        cause: String,
        stderr_tail: Vec<String>,
    },
    WorkerStartFailed(String),
}

pub struct Options {
    pub tolerance: f64,
    /// Where an opened document's blobs are unpacked, also handed to the worker. None uses a folder of this client's
    /// own in the temp dir, removed when the client drops.
    pub blob_dir: Option<PathBuf>,
    /// Called after every event is queued, so a UI loop can wake without polling.
    pub notify: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Default for Options {
    fn default() -> Options {
        Options { tolerance: 0.1, blob_dir: None, notify: None }
    }
}

type EditFn = Box<dyn FnOnce(&mut Doc) -> Result<(), String> + Send>;
/// What an edit did: the revision it took, None when the document did not change.
pub type Edited = Result<Option<u64>, String>;

/// Why a one-shot request gave no result. `cancelled` is a stop the user asked for, which the app does not report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub message: String,
    pub cancelled: bool,
}

/// A one-shot request's `result`, or why there is none.
pub type Answer = Result<Map<String, Value>, Refused>;

fn refused(message: impl Into<String>) -> Refused {
    Refused { message: message.into(), cancelled: false }
}

enum Cmd {
    Load(Doc, Sender<u64>),
    Edit(EditFn, Sender<Edited>),
    Rebuild,
    Request { op: String, fields: Map<String, Value>, with_doc: bool, reply: Sender<Answer> },
    CancelRequests,
    KillWorker,
    Shutdown,
}

pub(crate) enum Input {
    Cmd(Cmd),
    Worker(FromWorker),
}

/// One rebuild runs at a time. Edits made while it runs fold into the next one, so a drag rebuilds the latest value
/// as soon as the worker is free and never queues up stale ones. A worker that dies is restarted and the rebuild it
/// was on is sent again, once.
///
/// Revisions: [`Client::load`] and every [`Client::edit`] that changes the document take the next one and return it.
/// Nothing else moves it, so a resend after a resync or a restart, and [`Client::rebuild`], carry the revision the
/// document is at. [`Mesh::revision`] and [`Event::Failed`] name the revision that was built. A mesh built from a
/// document that a later load replaced is dropped.
///
/// The worker builds only the features before the rollback marker that are not suppressed, as `doc::built` cuts
/// them. The document the client keeps, and edits, is whole.
pub struct Client {
    tx: Sender<Input>,
    blob_dir: PathBuf,
    own_blob_dir: bool,
    driver: Option<JoinHandle<()>>,
}

const STOPPED: &str = "the engine link stopped";

impl Client {
    /// Starts the worker and the thread that drives it. Fails only when the first worker cannot start.
    pub fn spawn(cmd: WorkerCommand, opts: Options) -> io::Result<(Client, Receiver<Event>)> {
        static CLIENTS: AtomicU64 = AtomicU64::new(0);
        let own_blob_dir = opts.blob_dir.is_none();
        let blob_dir = opts.blob_dir.clone().unwrap_or_else(|| {
            let n = CLIENTS.fetch_add(1, Ordering::Relaxed);
            std::env::temp_dir().join("fundacad-client-blobs").join(format!("{}-{n}", std::process::id()))
        });
        std::fs::create_dir_all(&blob_dir)?;
        let cmd = cmd.env("FUNDACAD_BLOB_DIR", &blob_dir);
        let (tx, rx) = mpsc::channel();
        let (etx, erx) = mpsc::channel();
        let worker = Worker::spawn(&cmd, 1, tx.clone())?;
        let mut d = Driver {
            cmd,
            tx: tx.clone(),
            events: etx,
            notify: opts.notify,
            tolerance: opts.tolerance,
            worker: Some(worker),
            worker_started: Instant::now(),
            generation: 1,
            restart_at: None,
            restart_delay: RESTART_FLOOR,
            doc: None,
            loads: 0,
            revision: 0,
            held: None,
            dirty: false,
            edit_at: None,
            flight: None,
            crashed_on: None,
            cache: BodyCache::default(),
            next_id: 0,
            requests: HashMap::new(),
        };
        let driver = std::thread::Builder::new().name("engine-link".into()).spawn(move || d.run(rx));
        let driver = match driver {
            Ok(h) => h,
            Err(e) => {
                if own_blob_dir {
                    let _ = std::fs::remove_dir_all(&blob_dir);
                }
                return Err(e);
            }
        };
        Ok((Client { tx, blob_dir, own_blob_dir, driver: Some(driver) }, erx))
    }

    /// Reads a document from disk and rebuilds it whole, returning its revision. The read happens on the calling
    /// thread.
    pub fn open(&self, path: &Path) -> Result<u64, String> {
        let text = fundacad_format::read_document(path, &self.blob_dir)?;
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(doc)) => self.load(doc),
            Ok(_) => Err(format!("{} is not a document", path.display())),
            Err(e) => Err(format!("{} does not read: {e}", path.display())),
        }
    }

    /// Replaces the document and rebuilds it whole, returning its revision.
    pub fn load(&self, doc: Doc) -> Result<u64, String> {
        let (tx, rx) = mpsc::channel();
        self.send(Cmd::Load(doc, tx));
        rx.recv().map_err(|_| STOPPED.to_owned())
    }

    /// Sets one parameter, recomputes the ones that depend on it and rebuilds.
    pub fn set_param(&self, name: &str, value: f64) -> Edited {
        let name = name.to_owned();
        self.edit(move |d| doc::set_param(d, &name, value))
    }

    /// Any change to the document, run on the driver thread while the caller waits. A document that changed takes
    /// the next revision and rebuilds. An error or a panic from `f` leaves the document as it was.
    pub fn edit(&self, f: impl FnOnce(&mut Doc) -> Result<(), String> + Send + 'static) -> Edited {
        let (tx, rx) = mpsc::channel();
        self.send(Cmd::Edit(Box::new(f), tx));
        rx.recv().unwrap_or_else(|_| Err(STOPPED.to_owned()))
    }

    /// Builds the document again at the revision it is at, sent whole.
    pub fn rebuild(&self) {
        self.send(Cmd::Rebuild);
    }

    /// Any one-shot op (`import`, `blobRead`, `inspect` ...), answered while rebuilds go on beside it. The caller waits
    /// for the reply, so it runs off the UI thread.
    pub fn request(&self, op: &str, fields: Map<String, Value>) -> Answer {
        self.ask(op, fields, false)
    }

    /// An `export` of the open document. `fields` carry the format, the path and the options [`transfer::export`]
    /// builds. Bodies come from the document cut at the rollback marker, a sketch or face goes whole as in FundaCAD 1,
    /// since the engine reads a flat source straight from the document and a suppressed sketch still exports.
    pub fn export(&self, fields: Map<String, Value>) -> Answer {
        self.ask("export", fields, true)
    }

    fn ask(&self, op: &str, fields: Map<String, Value>, with_doc: bool) -> Answer {
        let (tx, rx) = mpsc::channel();
        self.send(Cmd::Request { op: op.to_owned(), fields, with_doc, reply: tx });
        rx.recv().unwrap_or_else(|_| Err(refused(STOPPED)))
    }

    /// Asks the engine to stop every one-shot request still waiting, each then answers as cancelled.
    pub fn cancel_requests(&self) {
        self.send(Cmd::CancelRequests);
    }

    /// Kills the worker as a crash would, for tests and the harness.
    pub fn kill_worker(&self) {
        self.send(Cmd::KillWorker);
    }

    fn send(&self, c: Cmd) {
        let _ = self.tx.send(Input::Cmd(c));
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.send(Cmd::Shutdown);
        if let Some(d) = self.driver.take() {
            let _ = d.join();
        }
        if self.own_blob_dir {
            let _ = std::fs::remove_dir_all(&self.blob_dir);
        }
    }
}

struct Flight {
    id: String,
    revision: u64,
    /// Which load the document came from, so a reply for a replaced document is dropped.
    load: u64,
    edit_at: Instant,
    sent_at: Instant,
    full: bool,
    assembly: Assembly,
    bytes: usize,
    frames: usize,
    decode: Duration,
}

struct Driver {
    cmd: WorkerCommand,
    tx: Sender<Input>,
    events: Sender<Event>,
    notify: Option<Arc<dyn Fn() + Send + Sync>>,
    tolerance: f64,
    worker: Option<Worker>,
    worker_started: Instant,
    generation: u64,
    restart_at: Option<Instant>,
    restart_delay: Duration,
    doc: Option<Doc>,
    loads: u64,
    /// The document's revision, one up for every load and every edit that changed it.
    revision: u64,
    /// What the worker holds, None when the next rebuild must send the document whole.
    held: Option<Held>,
    /// The document changed since the last rebuild was sent.
    dirty: bool,
    /// The first change not yet sent.
    edit_at: Option<Instant>,
    flight: Option<Flight>,
    /// The revision a worker last died on, which is sent again only once.
    crashed_on: Option<u64>,
    cache: BodyCache,
    next_id: u64,
    requests: HashMap<String, Sender<Answer>>,
}

impl Driver {
    fn run(&mut self, rx: Receiver<Input>) {
        loop {
            let input = match self.restart_at {
                Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                    Ok(i) => i,
                    Err(RecvTimeoutError::Timeout) => {
                        self.restart_at = None;
                        self.start_worker();
                        self.pump();
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(i) => i,
                    Err(_) => break,
                },
            };
            if matches!(input, Input::Cmd(Cmd::Shutdown)) {
                break;
            }
            if let Err(p) = catch_unwind(AssertUnwindSafe(|| self.input(input))) {
                self.abandon(format!("the engine link hit a bug: {}", panic_text(&*p)));
            }
            if let Err(p) = catch_unwind(AssertUnwindSafe(|| self.pump())) {
                self.dirty = false;
                self.abandon(format!("the engine link hit a bug: {}", panic_text(&*p)));
            }
        }
        if let Some(mut w) = self.worker.take() {
            w.kill();
            w.reap();
        }
    }

    fn input(&mut self, input: Input) {
        match input {
            Input::Cmd(c) => self.command(c),
            Input::Worker(FromWorker::Frame(g, m, n)) if g == self.generation => self.frame(m, n),
            Input::Worker(FromWorker::Ended(g, why)) if g == self.generation => self.worker_ended(why),
            Input::Worker(_) => {}
        }
    }

    /// Drops the rebuild in flight and everything the worker is assumed to hold, after a bug in this crate.
    fn abandon(&mut self, message: String) {
        let revision = self.flight.take().map_or(self.revision, |f| f.revision);
        self.held = None;
        self.cache.clear();
        let _ = writeln!(io::stderr(), "[client] {message}");
        self.emit(Event::Failed { revision, message, feature_id: None });
    }

    fn emit(&self, e: Event) {
        let _ = self.events.send(e);
        if let Some(n) = &self.notify {
            n();
        }
    }

    fn wanted(&mut self) {
        self.dirty = true;
        self.edit_at.get_or_insert_with(Instant::now);
    }

    fn command(&mut self, c: Cmd) {
        match c {
            Cmd::Load(d, reply) => {
                self.doc = Some(d);
                self.loads += 1;
                self.held = None;
                self.revision += 1;
                self.wanted();
                let _ = reply.send(self.revision);
            }
            Cmd::Edit(f, reply) => {
                let r = self.edit(f);
                let _ = reply.send(r);
            }
            Cmd::Rebuild => {
                self.held = None;
                self.wanted();
            }
            Cmd::Request { op, fields, with_doc, reply } => self.request(op, fields, with_doc, reply),
            Cmd::CancelRequests => self.cancel_requests(),
            Cmd::KillWorker => {
                if let Some(w) = self.worker.as_mut() {
                    w.kill();
                }
            }
            Cmd::Shutdown => {}
        }
    }

    fn edit(&mut self, f: EditFn) -> Edited {
        let Some(d) = self.doc.as_mut() else { return Err("no document is open".into()) };
        let before = d.clone();
        let r = catch_unwind(AssertUnwindSafe(|| f(d)))
            .unwrap_or_else(|p| Err(format!("the edit panicked: {}", panic_text(&*p))));
        if let Err(e) = r {
            *d = before;
            return Err(e);
        }
        if *d == before {
            return Ok(None);
        }
        self.revision += 1;
        self.wanted();
        Ok(Some(self.revision))
    }

    fn request(&mut self, op: String, mut fields: Map<String, Value>, with_doc: bool, reply: Sender<Answer>) {
        if with_doc {
            let Some(d) = self.doc.as_ref() else {
                let _ = reply.send(Err(refused("no document is open")));
                return;
            };
            let flat = fields.contains_key("sketch") || fields.contains_key("face");
            let sent = if flat { d.clone() } else { doc::built(d).into_owned() };
            fields.insert("document".into(), Value::Object(sent));
        }
        let Some(worker) = self.worker.as_mut() else {
            let _ = reply.send(Err(refused("the engine is restarting, try again in a moment")));
            return;
        };
        self.next_id += 1;
        let id = format!("rq{}", self.next_id);
        fields.insert("op".into(), json!(op));
        fields.insert("id".into(), json!(id));
        let text = serde_json::to_string(&fields).expect("a JSON map serializes");
        match worker.send(text) {
            Ok(()) => {
                self.requests.insert(id, reply);
            }
            Err(e) => {
                let _ = reply.send(Err(refused(format!("the engine did not take the request: {e}"))));
            }
        }
    }

    fn cancel_requests(&mut self) {
        let Some(worker) = self.worker.as_mut() else { return };
        let targets: Vec<String> = self.requests.keys().cloned().collect();
        for target in targets {
            self.next_id += 1;
            let text = json!({"op": "cancel", "id": format!("cx{}", self.next_id), "target": target}).to_string();
            let _ = worker.send(text);
        }
    }

    /// A one-shot request's reply. Progress frames are skipped, the app shows its own busy state.
    fn answer(&mut self, id: &str, m: Message) {
        let Message::Text(t) = m else { return };
        let v: Value = match serde_json::from_str(&t) {
            Ok(v) => v,
            Err(e) => {
                if let Some(r) = self.requests.remove(id) {
                    let _ = r.send(Err(refused(format!("unreadable reply: {e}"))));
                }
                return;
            }
        };
        if v.get("status").is_some() {
            return;
        }
        let Some(r) = self.requests.remove(id) else { return };
        let answer = if v.get("ok").and_then(Value::as_bool) == Some(true) {
            match v.get("result") {
                Some(Value::Object(m)) => Ok(m.clone()),
                _ => Ok(Map::new()),
            }
        } else {
            let message = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("the engine refused it");
            Err(Refused {
                message: message.to_owned(),
                cancelled: v.get("cancelled").and_then(Value::as_bool) == Some(true),
            })
        };
        let _ = r.send(answer);
    }

    /// Sends the next rebuild when the worker is free and the document moved.
    fn pump(&mut self) {
        if self.flight.is_some() || !self.dirty || self.worker.is_none() {
            return;
        }
        let Some(doc) = self.doc.as_ref() else { return };
        let doc = doc::built(doc);
        let doc = doc.as_ref();
        self.next_id += 1;
        let id = format!("fc{}", self.next_id);
        let common = |req: &mut Map<String, Value>| {
            req.insert("tolerance".into(), json!(self.tolerance));
            req.insert("known".into(), self.cache.known());
            req.insert("binary".into(), json!(true));
            req.insert("chunked".into(), json!(true));
        };
        let delta = self.held.as_ref().and_then(|h| Some((h.revision, h.delta_to(doc)?)));
        let mut req = Map::new();
        req.insert("op".into(), json!("rebuild"));
        req.insert("id".into(), json!(id));
        let full = delta.is_none();
        match delta {
            Some((base, ops)) => {
                req.insert("baseRevision".into(), json!(base));
                req.insert("revision".into(), json!(self.revision));
                req.insert("ops".into(), ops);
            }
            None => {
                req.insert("document".into(), Value::Object(doc.clone()));
                req.insert("revision".into(), json!(self.revision));
            }
        }
        common(&mut req);
        let text = serde_json::to_string(&req).expect("a JSON map serializes");
        let held = Held::of(doc, self.revision);
        let edit_at = self.edit_at.take().unwrap_or_else(Instant::now);
        let worker = self.worker.as_mut().expect("checked above");
        if let Err(e) = worker.send(text) {
            // Refused before a byte was written: over the frame limit.
            if e.kind() == ErrorKind::InvalidInput {
                self.dirty = false;
                let message = format!("the document is too large to send to the engine: {e}");
                return self.emit(Event::Failed { revision: self.revision, message, feature_id: None });
            }
            // The reader reports the worker's end, which restarts it and sends this again.
            self.edit_at = Some(edit_at);
            return;
        }
        self.held = Some(held);
        self.dirty = false;
        self.flight = Some(Flight {
            id,
            revision: self.revision,
            load: self.loads,
            edit_at,
            sent_at: Instant::now(),
            full,
            assembly: Assembly::default(),
            bytes: 0,
            frames: 0,
            decode: Duration::ZERO,
        });
    }

    /// Ends the current rebuild without a mesh and has the document sent again, at the revision it is at.
    fn retry(&mut self, whole: bool) {
        if let Some(f) = self.flight.take() {
            self.edit_at = Some(self.edit_at.map_or(f.edit_at, |e| e.min(f.edit_at)));
        }
        if whole {
            self.held = None;
        }
        self.dirty = true;
    }

    fn frame(&mut self, m: Message, n: usize) {
        if let Some(id) = message_id(&m).as_ref().and_then(Value::as_str) {
            if self.requests.contains_key(id) {
                let id = id.to_owned();
                return self.answer(&id, m);
            }
        }
        let Some(f) = self.flight.as_mut() else { return };
        if message_id(&m).as_ref().and_then(Value::as_str) != Some(f.id.as_str()) {
            return;
        }
        f.bytes += n;
        f.frames += 1;
        let t0 = Instant::now();
        match m {
            Message::Binary(bytes) => {
                let step = f.assembly.take_binary(&bytes, &self.cache);
                f.decode += t0.elapsed();
                match step {
                    Ok(Step::More) => {}
                    Ok(Step::Done) => self.finish(),
                    Err(e) => self.bad_reply(e),
                }
            }
            Message::Text(t) => {
                let v: Value = match serde_json::from_str(&t) {
                    Ok(v) => v,
                    Err(e) => return self.bad_reply(ReplyError::Corrupt(format!("unreadable reply: {e}"))),
                };
                if v.get("status").and_then(Value::as_str) == Some("building") {
                    let at = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(-1);
                    let p = Event::Progress {
                        revision: f.revision,
                        phase: at("phase"),
                        feature: at("feature"),
                        meshed: at("meshed"),
                        mesh_total: at("meshTotal"),
                    };
                    return self.emit(p);
                }
                if v.get("status").is_some() {
                    return;
                }
                if v.get("ok").and_then(Value::as_bool) != Some(true) {
                    if v.get("cancelled").and_then(Value::as_bool) == Some(true) {
                        return self.retry(true);
                    }
                    let revision = f.revision;
                    self.flight = None;
                    let err = v.get("error");
                    let s = |k: &str| err.and_then(|e| e.get(k)).and_then(Value::as_str).map(str::to_owned);
                    let message = s("message").unwrap_or_else(|| "the rebuild failed".into());
                    return self.emit(Event::Failed { revision, message, feature_id: s("feature_id") });
                }
                let result = match v.get("result") {
                    Some(Value::Object(r)) => r.clone(),
                    _ => Map::new(),
                };
                if result.get("resync").and_then(Value::as_bool) == Some(true) {
                    return self.retry(true);
                }
                let step = f.assembly.take_text(result, &self.cache);
                f.decode += t0.elapsed();
                match step {
                    Ok(()) => self.finish(),
                    Err(e) => self.bad_reply(e),
                }
            }
        }
    }

    fn bad_reply(&mut self, e: ReplyError) {
        match e {
            ReplyError::StaleStub(_) => {
                self.cache.clear();
                self.retry(false);
            }
            ReplyError::Corrupt(message) => {
                let revision = self.flight.take().map_or(self.revision, |f| f.revision);
                self.held = None;
                self.emit(Event::Failed { revision, message, feature_id: None });
            }
        }
    }

    fn finish(&mut self) {
        let Some(f) = self.flight.take() else { return };
        if f.load != self.loads {
            return;
        }
        let a = f.assembly;
        if let (Some(ids), Some(doc)) = (a.result.get("bodyIds"), self.doc.as_mut()) {
            doc.insert("bodyIds".into(), ids.clone());
        }
        self.cache.replace(&a.bodies);
        self.crashed_on = None;
        let now = Instant::now();
        let mesh = Mesh {
            revision: f.revision,
            bodies: a.bodies,
            fresh: a.fresh,
            result: a.result,
            timing: Timing {
                total: now - f.edit_at,
                queued: f.sent_at - f.edit_at,
                engine: now - f.sent_at - f.decode,
                decode: f.decode,
                bytes: f.bytes,
                frames: f.frames,
                full_send: f.full,
            },
        };
        let _ = writeln!(io::stderr(), "[client] {mesh}");
        self.emit(Event::Mesh(Arc::new(mesh)));
    }

    fn worker_ended(&mut self, why: String) {
        let Some(w) = self.worker.take() else { return };
        let (how, tail) = w.reap();
        let _ = writeln!(io::stderr(), "[client] worker ended: {how} ({why})");
        self.held = None;
        for (_, r) in self.requests.drain() {
            let _ = r.send(Err(refused("the geometry kernel stopped while working on this")));
        }
        if let Some(f) = self.flight.take() {
            if self.crashed_on == Some(f.revision) {
                self.emit(Event::Failed {
                    revision: f.revision,
                    message: "the geometry kernel crashed on this operation".into(),
                    feature_id: None,
                });
            } else {
                self.crashed_on = Some(f.revision);
                self.flight = Some(f);
                self.retry(true);
            }
        }
        self.emit(Event::WorkerRestarted { cause: how, stderr_tail: tail });
        if self.worker_started.elapsed() > HEALTHY_AFTER {
            self.restart_delay = RESTART_FLOOR;
        }
        self.restart_at = Some(Instant::now() + self.restart_delay);
        self.restart_delay = (self.restart_delay * 2).min(RESTART_CEILING);
    }

    fn start_worker(&mut self) {
        self.generation += 1;
        match Worker::spawn(&self.cmd, self.generation, self.tx.clone()) {
            Ok(w) => {
                self.worker = Some(w);
                self.worker_started = Instant::now();
            }
            Err(e) => {
                self.emit(Event::WorkerStartFailed(e.to_string()));
                self.restart_at = Some(Instant::now() + self.restart_delay);
                self.restart_delay = (self.restart_delay * 2).min(RESTART_CEILING);
            }
        }
    }
}

fn panic_text(p: &(dyn Any + Send)) -> String {
    p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default()
}
