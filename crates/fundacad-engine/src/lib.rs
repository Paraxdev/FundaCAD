//! The engine worker: one request loop shared by every transport. Heavy ops run one at a time on a job thread, while
//! `cancel` and `ping` answer on the read path so they are heard during a job. Geometry sits behind [`Jobs`], so this
//! crate builds and tests without OpenCASCADE.

mod doc_state;
pub mod live;
pub mod stdio;
pub mod supervise;
pub mod sysmem;
#[cfg(feature = "ws")]
pub mod ws;

pub use doc_state::DocState;
pub use supervise::{Budget, Clocks};

use fundacad_protocol::{envelope, import_stage, send_reply, CancelToken, JobResult, Limits, Message, ReplyOptions};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

static BUILD: std::sync::OnceLock<Value> = std::sync::OnceLock::new();

/// The source this executable was built from, answered in `ping` so a client holding two engines can tell whether they
/// build alike. Set by the executable: a build script here would recompile fundacad-geom on every commit.
pub fn set_build(json: &str) {
    if let Ok(build @ Value::Object(_)) = serde_json::from_str(json) {
        let _ = BUILD.set(build);
    }
}

pub fn build() -> Option<&'static Value> {
    BUILD.get()
}

fn pong() -> Value {
    let mut pong = json!({ "pong": true });
    if let Some(build) = BUILD.get() {
        pong["build"] = build.clone();
    }
    pong
}

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
    stage: AtomicI64,
    stage_done: AtomicI64,
    stage_total: AtomicI64,
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

    /// An import's [`fundacad_protocol::import_stage`], `done` of `total`, or
    /// a total of -1 when the stage has no fraction. Not proof of life: a
    /// sampler thread reports it while the kernel call it watches may be wedged.
    pub fn stage(&self, stage: i64, done: i64, total: i64) {
        self.stage_done.store(done, Ordering::Relaxed);
        self.stage_total.store(total, Ordering::Relaxed);
        self.stage.store(stage, Ordering::Relaxed);
    }

    /// Proof of life for the stall watchdog, from a phase with no feature or
    /// body counter to report (an export write, a pair sweep).
    pub fn tick(&self) {
        self.beats.fetch_add(1, Ordering::Relaxed);
    }

    pub fn beats(&self) -> u64 {
        self.beats.load(Ordering::Relaxed)
    }

    fn reset(&self) {
        self.feature.store(-1, Ordering::Relaxed);
        self.meshed.store(-1, Ordering::Relaxed);
        self.mesh_total.store(-1, Ordering::Relaxed);
        self.stage(-1, -1, -1);
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

    /// Any other heavy op. The default refuses it as an unknown op.
    fn run(&mut self, op: &str, _req: &Map<String, Value>, _ctx: &JobContext) -> JobResult {
        error_result(&format!("unknown op: {op}"))
    }

    /// What the running job is inside, for the reply to a job reaped as stalled.
    fn doing() -> Option<String>
    where
        Self: Sized,
    {
        None
    }

    /// No document holds anything here any more: free what was kept for them.
    fn release(&mut self) {}
}

pub fn error_result(message: &str) -> JobResult {
    let mut m = Map::new();
    m.insert("error".into(), json!({ "message": message }));
    JobResult::Json(m)
}

struct Running {
    id: Value,
    client: u64,
    doc: String,
    op: String,
    cancel: CancelToken,
    serial: u64,
}

/// A request not yet taken by the job thread, so its own client can withdraw
/// it and another client can be told what it is waiting behind.
struct Waiting {
    ticket: u64,
    client: u64,
    doc: String,
    id: Value,
    op: String,
    out: Arc<dyn Outbox>,
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
    /// End the process with [`EXIT_BREACH`] after answering a stalled or overstaying job, instead of abandoning its
    /// thread: a kernel call that never returns keeps OpenCASCADE's shared thread pool, and every later job stalls too.
    pub exit_on_breach: bool,
}

/// The exit code of a worker that ended itself over a stalled job, which its
/// supervisor restarts without reporting a crash.
pub const EXIT_BREACH: i32 = 75;

impl EngineOptions {
    pub fn from_env() -> EngineOptions {
        EngineOptions {
            cancel_grace: None,
            clocks: Clocks::from_env(),
            test_ops: supervise::test_ops_enabled(),
            exit_on_breach: false,
        }
    }
}

/// Makes the jobs of a replacement job thread.
pub type Respawn<J> = Arc<dyn Fn() -> J + Send + Sync>;

/// What every job thread of one engine shares. There is one live job thread;
/// an abandoned one keeps only its running job and never takes another.
struct Pool<J> {
    rx: Mutex<mpsc::Receiver<Work>>,
    running: Arc<Mutex<Option<Running>>>,
    waiting: Arc<Mutex<Vec<Waiting>>>,
    ended: Arc<Mutex<Vec<Ended>>>,
    respawn: Option<Respawn<J>>,
    opts: EngineOptions,
    serial: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn spawn_job_thread<J: Jobs>(pool: Arc<Pool<J>>, mut jobs: J) {
    let spawned = std::thread::Builder::new().name("engine-jobs".into()).spawn(move || {
        let mut docs = Docs::new();
        let abandoned = Arc::new(AtomicBool::new(false));
        while !abandoned.load(Ordering::SeqCst) {
            let work = lock(&pool.rx).recv();
            // Before any job: a job queued ahead of the End marker must not keep an ended document's memory.
            forget_ended(&pool, &mut jobs, &mut docs);
            match work {
                Err(_) => return,
                Ok(Work::End) => {}
                Ok(Work::Job(q)) if q.closed.load(Ordering::SeqCst) => {}
                Ok(Work::Job(q)) => run_one(&pool, &mut jobs, &mut docs, q, &abandoned),
            }
        }
    });
    if let Err(e) = spawned {
        eprintln!("[engine] cannot start a job thread: {e}");
    }
}

/// Answers job `serial` between freeing its slot and starting a fresh job thread, so a later cancel misses it and no
/// queued reply overtakes it.
fn abandon<J: Jobs>(pool: &Arc<Pool<J>>, abandoned: &AtomicBool, serial: u64, answer: impl FnOnce()) {
    let Some(make) = pool.respawn.clone() else { return answer() };
    abandoned.store(true, Ordering::SeqCst);
    clear_running(pool, serial);
    answer();
    spawn_job_thread(pool.clone(), make());
}

fn clear_running<J>(pool: &Pool<J>, serial: u64) {
    let mut running = lock(&pool.running);
    if running.as_ref().is_some_and(|r| r.serial == serial) {
        *running = None;
    }
}

enum Work {
    Job(Queued),
    /// Wakes an idle job thread to drop what it holds for ended documents.
    End,
}

/// A client's ended document, or every document of the client.
type Ended = (u64, Option<String>);

fn ends(ended: &[Ended], client: u64, doc: &str) -> bool {
    ended.iter().any(|(c, d)| *c == client && d.as_deref().map_or(true, |d| d == doc))
}

fn forget_ended<J: Jobs>(pool: &Pool<J>, jobs: &mut J, docs: &mut Docs) {
    let ended = std::mem::take(&mut *lock(&pool.ended));
    if ended.is_empty() {
        return;
    }
    docs.retain(|(client, doc), held| held.holds() && !ends(&ended, *client, doc));
    if docs.is_empty() {
        jobs.release();
    }
}

/// The document a request belongs to, `""` for a client that names none.
fn doc_of(req: &Map<String, Value>) -> String {
    req.get("doc").and_then(Value::as_str).unwrap_or("").to_owned()
}

struct Queued {
    req: Map<String, Value>,
    client: u64,
    out: Arc<dyn Outbox>,
    closed: Arc<AtomicBool>,
    ticket: u64,
    /// Whether the client was sent a `queued` frame, and so is owed `started`.
    announced: bool,
}

/// Each client's held documents, so a delta is never applied to a document another client or another of the client's
/// documents sent under the same revision number.
type Docs = HashMap<(u64, String), DocState>;

/// One engine: a job thread and the read path in front of it. All clients share the job thread and caches, so every
/// connection's jobs run one at a time; progress, cancel and the held document stay with the requesting client.
pub struct Engine {
    jobs: mpsc::Sender<Work>,
    running: Arc<Mutex<Option<Running>>>,
    /// Locked before `running` wherever both are held.
    waiting: Arc<Mutex<Vec<Waiting>>>,
    ended: Arc<Mutex<Vec<Ended>>>,
    /// Documents a client ended, whose late requests are answered cancelled instead of run.
    gone: Mutex<HashSet<(u64, String)>>,
    next_ticket: AtomicU64,
    out: Arc<dyn Outbox>,
    next_client: AtomicU64,
    never_closed: Arc<AtomicBool>,
    live: Mutex<live::LiveSession>,
}

/// The connection is the live session identity.
fn conn_id(client: u64) -> String {
    format!("c{client:x}")
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
        let (tx, rx) = mpsc::channel::<Work>();
        let running: Arc<Mutex<Option<Running>>> = Arc::default();
        let waiting: Arc<Mutex<Vec<Waiting>>> = Arc::default();
        let ended: Arc<Mutex<Vec<Ended>>> = Arc::default();
        let pool = Arc::new(Pool {
            rx: Mutex::new(rx),
            running: running.clone(),
            waiting: waiting.clone(),
            ended: ended.clone(),
            respawn,
            opts,
            serial: AtomicU64::new(1),
        });
        spawn_job_thread(pool, jobs);
        Engine {
            jobs: tx,
            running,
            waiting,
            ended,
            gone: Mutex::default(),
            next_ticket: AtomicU64::new(1),
            out,
            next_client: AtomicU64::new(1),
            never_closed: Arc::new(AtomicBool::new(false)),
            live: Mutex::new(live::LiveSession::monotonic()),
        }
    }

    /// A client whose replies go to `out`. Its cancel reaches only its own jobs, and dropping it drops its queued jobs
    /// and cancels its running one, as closing a connection does.
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

    fn handle_for(&self, client: u64, out: &Arc<dyn Outbox>, closed: &Arc<AtomicBool>, msg: Message) {
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
            Some("ping") => reply(envelope::ok(&id, &pong())),
            Some("doc_end") => match (req.get("doc").and_then(Value::as_str), truthy(req.get("all"))) {
                (_, true) => reply(envelope::doc_end_ack(&id, self.end_docs(client, None, true))),
                (Some(doc), false) => reply(envelope::doc_end_ack(&id, self.end_docs(client, Some(doc), true))),
                (None, false) => reply(envelope::err(&id, "doc_end names a doc or all", None)),
            },
            Some(op) if live::is_session_op(op) => {
                let mut session = self.live.lock().unwrap_or_else(|p| p.into_inner());
                match live::session_reply(&mut session, &conn_id(client), op, &req) {
                    Ok(res) => reply(envelope::ok(&id, &res)),
                    Err(message) => reply(envelope::err(&id, &message, None)),
                }
            }
            op => {
                let doc = doc_of(&req);
                if !doc.is_empty() && lock(&self.gone).contains(&(client, doc.clone())) {
                    reply(envelope::cancelled(&id));
                    return;
                }
                let ticket = self.next_ticket.fetch_add(1, Ordering::Relaxed);
                let behind = self.blocker(client);
                // Sent before the job is queued, so it can never follow the job's own reply.
                if let Some(b) = &behind {
                    reply(envelope::queued(&id, b));
                }
                lock(&self.waiting).push(Waiting {
                    ticket,
                    client,
                    doc,
                    id: id.clone(),
                    op: op.unwrap_or("").to_string(),
                    out: out.clone(),
                });
                let queued = Queued {
                    req,
                    client,
                    out: out.clone(),
                    closed: closed.clone(),
                    ticket,
                    announced: behind.is_some(),
                };
                if self.jobs.send(Work::Job(queued)).is_err() {
                    lock(&self.waiting).retain(|w| w.ticket != ticket);
                    reply(envelope::err(&id, "the engine job thread is gone", None));
                }
            }
        }
    }

    /// The other client's job a new request from `client` will wait behind, if
    /// any: `{who, name?, op}`, `who` being the app, an assistant or a session.
    fn blocker(&self, client: u64) -> Option<Value> {
        let (other, op) = {
            let waiting = lock(&self.waiting);
            let running = lock(&self.running);
            match running.as_ref() {
                Some(r) if r.client != client => (r.client, r.op.clone()),
                _ => waiting.iter().find(|w| w.client != client).map(|w| (w.client, w.op.clone()))?,
            }
        };
        let mut who = lock(&self.live).role_of(&conn_id(other));
        if let Value::Object(m) = &mut who {
            m.insert("op".into(), Value::String(op));
        }
        Some(who)
    }

    /// Cancels `client`'s running job (only if it is `target`, when given), or withdraws its queued request `target`
    /// and answers it cancelled. Another client's job is never touched.
    fn cancel(&self, client: u64, target: Option<&Value>) -> bool {
        let target = target.filter(|t| !t.is_null());
        let mut waiting = lock(&self.waiting);
        if let Some(r) = lock(&self.running).as_ref() {
            if r.client == client && target.map_or(true, |t| *t == r.id) {
                r.cancel.cancel();
                return true;
            }
        }
        let Some(t) = target else { return false };
        let Some(pos) = waiting.iter().position(|w| w.client == client && w.id == *t) else {
            return false;
        };
        let w = waiting.remove(pos);
        drop(waiting);
        let _ = w.out.send(&mut std::iter::once(Message::Text(envelope::cancelled(&w.id))));
        true
    }
}

impl Engine {
    /// Ends `client`'s document `doc`, or all of its documents: the running job is cancelled, queued ones are
    /// withdrawn (and answered cancelled when `answer`), and the job thread drops what it holds for them once the
    /// running job is done. Returns how many jobs it ended.
    fn end_docs(&self, client: u64, doc: Option<&str>, answer: bool) -> usize {
        let hit = |c: u64, d: &str| c == client && doc.map_or(true, |x| x == d);
        let mut waiting = lock(&self.waiting);
        let mut ended = 0;
        if let Some(r) = lock(&self.running).as_ref().filter(|r| hit(r.client, &r.doc)) {
            r.cancel.cancel();
            ended += 1;
        }
        let (withdrawn, kept): (Vec<Waiting>, Vec<Waiting>) =
            std::mem::take(&mut *waiting).into_iter().partition(|w| hit(w.client, &w.doc));
        *waiting = kept;
        drop(waiting);
        ended += withdrawn.len();
        if answer {
            for w in &withdrawn {
                let _ = w.out.send(&mut std::iter::once(Message::Text(envelope::cancelled(&w.id))));
            }
        }
        match doc {
            Some(d) => {
                lock(&self.gone).insert((client, d.to_owned()));
            }
            None => lock(&self.gone).retain(|(c, _)| *c != client),
        }
        lock(&self.ended).push((client, doc.map(str::to_owned)));
        let _ = self.jobs.send(Work::End);
        ended
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
        self.engine.handle_for(self.id, &self.out, &self.closed, msg);
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        self.engine.end_docs(self.id, None, false);
        let who = conn_id(self.id);
        let mut session = self.engine.live.lock().unwrap_or_else(|p| p.into_inner());
        session.release(&who);
        session.leave(&who);
    }
}

fn run_one<J: Jobs>(pool: &Arc<Pool<J>>, jobs: &mut J, docs: &mut Docs, q: Queued, abandoned: &Arc<AtomicBool>) {
    let Queued { req, client, out, ticket, announced, .. } = q;
    let out = &out;
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    let doc = doc_of(&req);
    let cancel = CancelToken::new();
    let serial = pool.serial.fetch_add(1, Ordering::SeqCst);
    {
        let mut waiting = lock(&pool.waiting);
        // Gone means its client withdrew it, and that cancel already answered it.
        let Some(pos) = waiting.iter().position(|w| w.ticket == ticket) else {
            return;
        };
        waiting.remove(pos);
        *lock(&pool.running) =
            Some(Running { id: id.clone(), client, doc: doc.clone(), op: op.clone(), cancel: cancel.clone(), serial });
    }
    if announced {
        let _ = out.send(&mut std::iter::once(Message::Text(envelope::started(&id))));
    }

    let progress = Arc::new(Progress::default());
    progress.reset();
    let ctx = JobContext { cancel: cancel.clone(), progress: progress.clone() };
    let claimed = Arc::new(AtomicBool::new(false));
    let ticking = Arc::new(AtomicBool::new(true));
    let on_breach = {
        let pool = pool.clone();
        let abandoned = abandoned.clone();
        let out = out.clone();
        move |reply: Message| {
            let answer = || {
                let _ = out.send(&mut std::iter::once(reply));
            };
            if pool.opts.exit_on_breach {
                answer();
                std::process::exit(EXIT_BREACH);
            }
            abandon(&pool, &abandoned, serial, answer)
        }
    };
    let watchdog = spawn_watchdog(
        WatchedJob {
            id: id.clone(),
            frames: match op.as_str() {
                "rebuild" | "computeAll" => Frames::Building,
                "import" => Frames::Importing,
                _ => Frames::None,
            },
            progress,
            ticking: ticking.clone(),
            claimed: claimed.clone(),
            cancel: cancel.clone(),
            out: out.clone(),
            doing: J::doing,
            watchdog: supervise::Watchdog::new(pool.opts.clocks.budget(&op, &req), pool.opts.cancel_grace),
        },
        on_breach,
    );

    if pool.opts.test_ops {
        supervise::test_hold(&op, &ctx);
    }
    let result = match op.as_str() {
        _ if cancel.is_cancelled() => error_result("cancelled"),
        "rebuild" | "computeAll" => {
            let tolerance = req.get("tolerance").and_then(Value::as_f64).unwrap_or(0.1);
            let empty = Map::new();
            let fresh = op == "computeAll";
            // computeAll resends every body, so the client's etags are ignored.
            let known = req.get("known").and_then(Value::as_object).filter(|_| !fresh).unwrap_or(&empty);
            match docs.entry((client, doc)).or_default().apply(&req, fresh) {
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
    let opts = ReplyOptions { binary: truthy(req.get("binary")), chunked: truthy(req.get("chunked")) };
    let mut reply = send_reply(id, result, opts, Some(cancel), Limits::default());
    // Frees the slot just before the last message: a stream checks its cancel
    // token between chunks, and a cancel reaches that token only through the slot.
    let mut answer = std::iter::from_fn(|| {
        let m = reply.next();
        if reply.is_done() {
            clear_running(pool, serial);
        }
        m
    });
    let _ = out.send(&mut answer);
    clear_running(pool, serial);
}

fn truthy(v: Option<&Value>) -> bool {
    fundacad_protocol::pyjson::truthy(v)
}

/// Which progress frames a job streams while it runs.
#[derive(Clone, Copy, PartialEq)]
enum Frames {
    None,
    Building,
    Importing,
}

struct WatchedJob {
    id: Value,
    frames: Frames,
    progress: Arc<Progress>,
    ticking: Arc<AtomicBool>,
    /// Set by whoever answers the request first, the job or its watchdog.
    claimed: Arc<AtomicBool>,
    cancel: CancelToken,
    out: Arc<dyn Outbox>,
    doing: fn() -> Option<String>,
    watchdog: supervise::Watchdog,
}

/// Streams a rebuild's progress and ends a job that stalls, overruns its wall clock or ignores a cancel past grace.
fn spawn_watchdog(
    mut job: WatchedJob,
    on_breach: impl FnOnce(Message) + Send + 'static,
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
                let doing = match breach {
                    supervise::Breach::Stalled(_) => (job.doing)(),
                    _ => None,
                };
                if !matches!(breach, supervise::Breach::IgnoredCancel) {
                    eprintln!(
                        "[engine] {} {breach:?} in {}, abandoning its job thread",
                        job.id,
                        doing.as_deref().unwrap_or("an unnamed phase")
                    );
                }
                job.cancel.cancel();
                let text = envelope::reply_for(&job.id, &breach.result_in(doing.as_deref()));
                on_breach(Message::Text(text));
                return;
            }
            if job.frames == Frames::None || waited < PROGRESS_EVERY {
                continue;
            }
            waited = Duration::ZERO;
            if !job.ticking.load(Ordering::SeqCst) {
                break;
            }
            let p = &job.progress;
            let frame = if job.frames == Frames::Building {
                envelope::building(
                    &job.id,
                    p.feature.load(Ordering::Relaxed),
                    p.meshed.load(Ordering::Relaxed),
                    p.mesh_total.load(Ordering::Relaxed),
                )
            } else {
                let stage = p.stage.load(Ordering::Relaxed);
                if stage < 0 {
                    continue;
                }
                let pct =
                    import_stage::pct(p.stage_done.load(Ordering::Relaxed), p.stage_total.load(Ordering::Relaxed));
                envelope::importing(&job.id, stage, import_stage::label(stage), pct)
            };
            let _ = job.out.send(&mut std::iter::once(Message::Text(frame)));
        }
    })
}

#[cfg(test)]
mod tests;
