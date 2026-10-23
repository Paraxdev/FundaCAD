use super::*;
use fundacad_protocol::{FullBody, MeshResult, WireBody};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Instant;

struct Collect(Mutex<Sender<Message>>);

impl Outbox for Collect {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        let tx = self.0.lock().unwrap();
        for m in msgs {
            tx.send(m).unwrap();
        }
        Ok(())
    }
}

/// Builds one box body per feature, and waits on a gate first when asked, so a
/// test can cancel a job while it runs.
struct Fake {
    gate: Option<Receiver<()>>,
    rebuilds: Arc<AtomicI64>,
}

impl Jobs for Fake {
    fn rebuild(
        &mut self,
        doc: &Value,
        _t: f64,
        known: &Map<String, Value>,
        _fresh: bool,
        ctx: &JobContext,
    ) -> JobResult {
        self.rebuilds.fetch_add(1, Ordering::SeqCst);
        if let Some(g) = &self.gate {
            while g.recv_timeout(Duration::from_millis(10)).is_err() {
                if ctx.cancel.is_cancelled() {
                    break;
                }
            }
        }
        let n = doc["features"].as_array().map_or(0, |a| a.len());
        let mut bodies = vec![];
        for i in 0..n {
            let id = format!("body{}", i + 1);
            if known.get(&id).and_then(Value::as_str) == Some("e") {
                let mut m = Map::new();
                m.insert("id".into(), json!(id));
                m.insert("unchanged".into(), json!(true));
                bodies.push(WireBody::Stub(m));
                continue;
            }
            let mut b = FullBody::new(id.as_str(), id.as_str(), "e");
            b.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
            b.indices = vec![0, 1, 2];
            b.face_ids = vec![0];
            bodies.push(WireBody::Full(b));
        }
        let mut fields = Map::new();
        fields.insert("protocol".into(), json!(2));
        fields.insert("bodies".into(), Value::Null);
        JobResult::Mesh(MeshResult { fields, bodies })
    }

    /// `import` reports the stage its request names, then waits on the gate.
    fn run(&mut self, op: &str, req: &Map<String, Value>, ctx: &JobContext) -> JobResult {
        if op != "import" {
            return error_result(&format!("unknown op: {op}"));
        }
        let at = |k: &str| req.get(k).and_then(Value::as_i64).unwrap_or(-1);
        ctx.progress.stage(at("stage"), at("done"), at("total"));
        if let Some(g) = &self.gate {
            while g.recv_timeout(Duration::from_millis(10)).is_err() {
                if ctx.cancel.is_cancelled() {
                    break;
                }
            }
        }
        let mut m = Map::new();
        m.insert("geom".into(), json!("g"));
        JobResult::Json(m)
    }
}

fn engine(gate: Option<Receiver<()>>) -> (Engine, Receiver<Message>, Arc<AtomicI64>) {
    let (tx, rx) = channel();
    let rebuilds = Arc::new(AtomicI64::new(0));
    let e = Engine::start(Fake { gate, rebuilds: rebuilds.clone() }, Arc::new(Collect(Mutex::new(tx))));
    (e, rx, rebuilds)
}

fn text(m: Message) -> Value {
    match m {
        Message::Text(t) => serde_json::from_str(&t).unwrap(),
        Message::Binary(_) => panic!("expected text"),
    }
}

fn next(rx: &Receiver<Message>) -> Message {
    rx.recv_timeout(Duration::from_secs(5)).expect("a reply")
}

fn send(e: &Engine, v: Value) {
    e.handle(Message::Text(v.to_string()));
}

#[test]
fn cancel_stops_the_running_job_and_only_that_one() {
    let (gate_tx, gate_rx) = channel();
    let (e, rx, _) = engine(Some(gate_rx));
    send(&e, json!({"id": "long", "op": "rebuild", "document": {"features": []}}));
    let t0 = Instant::now();
    while e.running.lock().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    send(&e, json!({"id": "c1", "op": "cancel", "target": "someone-else"}));
    assert_eq!(text(next(&rx))["result"], json!({"cancelled": false}));
    send(&e, json!({"id": "c2", "op": "cancel", "target": "long"}));
    assert_eq!(text(next(&rx))["result"], json!({"cancelled": true}));
    let reply = text(next(&rx));
    assert_eq!(reply["id"], "long");
    assert_eq!(reply["cancelled"], true);
    assert_eq!(reply["ok"], false);
    drop(gate_tx);
}

#[test]
fn a_closed_client_loses_its_queued_jobs_and_its_running_one() {
    let (gate_tx, gate_rx) = channel();
    let rebuilds = Arc::new(AtomicI64::new(0));
    let (tx, _rx) = channel();
    let engine = Arc::new(Engine::start(
        Fake { gate: Some(gate_rx), rebuilds: rebuilds.clone() },
        Arc::new(Collect(Mutex::new(tx))),
    ));
    let (a_tx, a_rx) = channel();
    let (b_tx, b_rx) = channel();
    let a = engine.client(Arc::new(Collect(Mutex::new(a_tx))));
    let b = engine.client(Arc::new(Collect(Mutex::new(b_tx))));
    let doc = json!({"features": []});
    a.handle(Message::Text(json!({"id": "a1", "op": "rebuild", "document": doc}).to_string()));
    let t0 = Instant::now();
    while engine.running.lock().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    a.handle(Message::Text(json!({"id": "a2", "op": "rebuild", "document": doc}).to_string()));
    b.handle(Message::Text(json!({"id": "bc", "op": "cancel"}).to_string()));
    assert_eq!(text(next(&b_rx))["result"], json!({"cancelled": false}));
    drop(a);
    let a_first = text(next(&a_rx));
    assert_eq!(a_first["id"], "a1");
    assert_eq!(a_first["cancelled"], true);
    b.handle(Message::Text(json!({"id": "b1", "op": "rebuild", "document": doc}).to_string()));
    gate_tx.send(()).unwrap();
    loop {
        let m = text(next(&b_rx));
        if m["id"] == "b1" && m.get("ok").is_some() {
            assert_eq!(m["ok"], true);
            break;
        }
    }
    assert_eq!(rebuilds.load(Ordering::SeqCst), 2);
    assert!(a_rx.try_recv().is_err());
}

#[test]
fn the_live_session_answers_while_a_job_runs_and_follows_the_connection() {
    let (gate_tx, gate_rx) = channel();
    let (tx, _rx) = channel();
    let engine = Arc::new(Engine::start(
        Fake { gate: Some(gate_rx), rebuilds: Arc::new(AtomicI64::new(0)) },
        Arc::new(Collect(Mutex::new(tx))),
    ));
    let (app_tx, app_rx) = channel();
    let (agent_tx, agent_rx) = channel();
    let app = engine.client(Arc::new(Collect(Mutex::new(app_tx))));
    let agent = engine.client(Arc::new(Collect(Mutex::new(agent_tx))));
    let call = |c: &Client, rx: &Receiver<Message>, v: Value| -> Value {
        c.handle(Message::Text(v.to_string()));
        text(next(rx))
    };
    let doc = json!({"features": [{"id": "f0", "type": "box"}]});
    agent.handle(Message::Text(json!({"id": "busy", "op": "rebuild", "document": doc}).to_string()));
    let t0 = Instant::now();
    while engine.running.lock().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }

    let r = call(
        &app,
        &app_rx,
        json!({"id": 1, "op": "session_host", "document": doc, "revision": 12,
            "title": "spool.funda", "status": {"canEdit": true}}),
    );
    assert_eq!(r, json!({"id": 1, "ok": true, "result": {"ok": true, "guests": [], "proposals": []}}));
    let st = call(&agent, &agent_rx, json!({"id": 2, "op": "session_state", "name": "an assistant"}));
    assert_eq!(st["result"]["attached"], true);
    assert_eq!(st["result"]["revision"], 12);
    assert_eq!(st["result"]["guests"], json!(["an assistant"]));
    let p = call(
        &agent,
        &agent_rx,
        json!({"id": 3, "op": "session_propose", "document": doc, "baseRevision": 12,
            "note": "feature_add: cylinder", "name": "an assistant"}),
    );
    assert_eq!(p["result"], json!({"ok": true, "proposal": p["result"]["proposal"], "revision": 12}));
    assert!(p["result"]["proposal"].as_str().is_some_and(|id| id.starts_with('p') && id.ends_with("-1")), "{p}");
    let stale = call(&agent, &agent_rx, json!({"id": 4, "op": "session_propose", "document": doc, "baseRevision": 11}));
    assert_eq!(stale["result"]["reason"], "stale");
    let got = call(&app, &app_rx, json!({"id": 5, "op": "session_host", "document": doc, "revision": 12}));
    assert_eq!(got["result"]["guests"], json!(["an assistant"]));
    assert_eq!(got["result"]["proposals"][0]["note"], "feature_add: cylinder");
    let not_host = call(&agent, &agent_rx, json!({"id": 6, "op": "session_release"}));
    assert_eq!(not_host["result"], json!({"ok": false, "reason": "not the host"}));

    // A guest that leaves takes its uncollected edit with it.
    let (other_tx, other_rx) = channel();
    let other = engine.client(Arc::new(Collect(Mutex::new(other_tx))));
    let offer = json!({"op": "session_propose", "document": doc, "baseRevision": 12});
    let mut mine = offer.as_object().unwrap().clone();
    mine.insert("id".into(), json!(7));
    call(&agent, &agent_rx, Value::Object(mine));
    let mut theirs = offer.as_object().unwrap().clone();
    theirs.insert("id".into(), json!(8));
    call(&other, &other_rx, Value::Object(theirs));
    call(&agent, &agent_rx, json!({"id": 9, "op": "session_leave"}));
    let got = call(&app, &app_rx, json!({"id": 10, "op": "session_host", "document": doc, "revision": 12}));
    let pending = got["result"]["proposals"].as_array().unwrap();
    assert_eq!(pending.len(), 1, "the wrong guest's edit was withdrawn");
    assert_eq!(pending[0]["guest"], "c3");

    drop(app);
    let st = call(&agent, &agent_rx, json!({"id": 11, "op": "session_state"}));
    assert_eq!(st["result"]["attached"], false, "a closed host still hosts");
    assert!(st["result"]["document"].is_null());
    gate_tx.send(()).unwrap();
}

/// Never looks at its cancel token, like a kernel call that cannot be stopped.
#[derive(Default)]
struct Deaf;

impl Jobs for Deaf {
    fn rebuild(&mut self, doc: &Value, _t: f64, _k: &Map<String, Value>, _f: bool, _ctx: &JobContext) -> JobResult {
        let secs = doc["sleep"].as_f64().unwrap_or(0.0);
        std::thread::sleep(Duration::from_secs_f64(secs));
        let mut m = Map::new();
        m.insert("slept".into(), json!(secs));
        JobResult::Json(m)
    }
}

fn respawning(opts: EngineOptions) -> (Engine, Receiver<Message>) {
    respawning_after(opts, Duration::ZERO)
}

/// `lag` holds the job thread after it sends a reply, as a busy machine does
/// between the reply and the slot clearing behind it.
fn respawning_after(opts: EngineOptions, lag: Duration) -> (Engine, Receiver<Message>) {
    let (tx, rx) = channel();
    let e =
        Engine::start_with(Deaf, Some(Arc::new(Deaf::default)), opts, Arc::new(Lagging(Collect(Mutex::new(tx)), lag)));
    (e, rx)
}

struct Lagging(Collect, Duration);

impl Outbox for Lagging {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        let sent = self.0.send(msgs);
        std::thread::sleep(self.1);
        sent
    }
}

fn reply_to(rx: &Receiver<Message>, id: &str) -> Value {
    loop {
        let m = text(rx.recv_timeout(Duration::from_secs(10)).expect("a reply"));
        if m["id"] == id && m.get("ok").is_some() {
            return m;
        }
    }
}

#[test]
fn a_silent_job_is_reaped_and_the_queue_behind_it_still_runs() {
    let clocks = Clocks { stall: Duration::from_millis(400), job: Duration::from_secs(25) };
    let (e, rx) = respawning_after(EngineOptions { clocks, ..EngineOptions::default() }, Duration::from_millis(300));
    let t0 = Instant::now();
    send(&e, json!({"id": "wedged", "op": "rebuild", "document": {"sleep": 30}}));
    send(&e, json!({"id": "next", "op": "rebuild", "document": {"sleep": 0}}));
    let wedged = reply_to(&rx, "wedged");
    assert_eq!(wedged["ok"], false);
    let msg = wedged["error"]["message"].as_str().unwrap();
    assert!(msg.contains("stalled for over"), "{msg}");
    let next = reply_to(&rx, "next");
    assert_eq!(next["ok"], true, "{next}");
    assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    assert!(e.running.lock().unwrap().is_none());
}

#[test]
fn a_cancel_the_job_ignores_is_answered_after_the_grace() {
    let (e, rx) =
        respawning(EngineOptions { cancel_grace: Some(Duration::from_millis(300)), ..EngineOptions::default() });
    send(&e, json!({"id": "long", "op": "rebuild", "document": {"sleep": 30}}));
    let t0 = Instant::now();
    while e.running.lock().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    send(&e, json!({"id": "c", "op": "cancel", "target": "long"}));
    assert_eq!(reply_to(&rx, "c")["result"]["cancelled"], true);
    let long = reply_to(&rx, "long");
    assert_eq!(long["cancelled"], true);
    assert!(t0.elapsed() < Duration::from_secs(5));
    send(&e, json!({"id": "c2", "op": "cancel"}));
    assert_eq!(reply_to(&rx, "c2")["result"]["cancelled"], false);
    send(&e, json!({"id": "after", "op": "rebuild", "document": {"sleep": 0}}));
    assert_eq!(reply_to(&rx, "after")["ok"], true);
}

fn until_running(engine: &Engine) {
    let t0 = Instant::now();
    while engine.running.lock().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
}

type Peer = (Client, Receiver<Message>);

fn two_clients(gate: Receiver<()>) -> (Arc<Engine>, Peer, Peer) {
    let (tx, _rx) = channel();
    let engine = Arc::new(Engine::start(
        Fake { gate: Some(gate), rebuilds: Arc::new(AtomicI64::new(0)) },
        Arc::new(Collect(Mutex::new(tx))),
    ));
    let (a_tx, a_rx) = channel();
    let (b_tx, b_rx) = channel();
    let a = engine.client(Arc::new(Collect(Mutex::new(a_tx))));
    let b = engine.client(Arc::new(Collect(Mutex::new(b_tx))));
    (engine, (a, a_rx), (b, b_rx))
}

fn say(c: &Client, v: Value) {
    c.handle(Message::Text(v.to_string()));
}

#[test]
fn a_request_behind_another_clients_job_is_told_so_and_can_only_withdraw_itself() {
    let (gate_tx, gate_rx) = channel();
    let (engine, (agent, agent_rx), (app, app_rx)) = two_clients(gate_rx);
    say(&agent, json!({"id": "s", "op": "session_state", "name": "Claude"}));
    assert_eq!(text(next(&agent_rx))["ok"], true);
    say(&agent, json!({"id": "import", "op": "rebuild", "document": {"features": []}}));
    until_running(&engine);

    say(&app, json!({"id": "mine", "op": "rebuild", "document": {"features": []}}));
    assert_eq!(
        text(next(&app_rx)),
        json!({"id": "mine", "status": "queued",
            "behind": {"who": "assistant", "name": "Claude", "op": "rebuild"}})
    );
    say(&app, json!({"id": "c1", "op": "cancel", "target": "import"}));
    assert_eq!(text(next(&app_rx))["result"], json!({"cancelled": false}));
    say(&app, json!({"id": "c2", "op": "cancel"}));
    assert_eq!(text(next(&app_rx))["result"], json!({"cancelled": false}));
    say(&app, json!({"id": "c3", "op": "cancel", "target": "mine"}));
    let withdrawn = text(next(&app_rx));
    assert_eq!(withdrawn["id"], "mine");
    assert_eq!(withdrawn["cancelled"], true);
    assert_eq!(text(next(&app_rx))["result"], json!({"cancelled": true}));

    say(&app, json!({"id": "next", "op": "rebuild", "document": {"features": [{"id": "f"}]}}));
    assert_eq!(text(next(&app_rx))["status"], "queued");
    gate_tx.send(()).unwrap();
    gate_tx.send(()).unwrap();
    let done = reply_to(&agent_rx, "import");
    assert_eq!(done["ok"], true, "the other client's job was cancelled: {done}");
    assert_eq!(text(next(&app_rx)), json!({"id": "next", "status": "started"}));
    let next_reply = reply_to(&app_rx, "next");
    assert_eq!(next_reply["ok"], true);
    assert!(app_rx.try_recv().is_err(), "the withdrawn request still ran");
    assert!(agent_rx.try_recv().is_err(), "a frame of the app's job reached the assistant");
}

/// The status frames `id` got before its reply.
fn statuses_until(rx: &Receiver<Message>, id: &str) -> Vec<String> {
    let mut out = vec![];
    loop {
        let m = text(next(rx));
        if let Some(s) = m.get("status").and_then(Value::as_str) {
            out.push(s.to_string());
        } else if m["id"] == id {
            return out;
        }
    }
}

#[test]
fn a_clients_own_queue_and_an_idle_engine_send_no_queued_frame() {
    let (gate_tx, gate_rx) = channel();
    let (engine, (a, a_rx), (b, b_rx)) = two_clients(gate_rx);
    say(&b, json!({"id": "b0", "op": "rebuild", "document": {"features": []}}));
    gate_tx.send(()).unwrap();
    assert!(statuses_until(&b_rx, "b0").iter().all(|s| s == "building"));
    say(&a, json!({"id": "a1", "op": "rebuild", "document": {"features": []}}));
    until_running(&engine);
    say(&a, json!({"id": "a2", "op": "rebuild", "document": {"features": []}}));
    gate_tx.send(()).unwrap();
    gate_tx.send(()).unwrap();
    assert!(statuses_until(&a_rx, "a1").iter().all(|s| s == "building"));
    assert!(statuses_until(&a_rx, "a2").iter().all(|s| s == "building"));
}

fn ack(id: &str, cancelled: bool) -> Value {
    json!({"id": id, "ok": true, "result": {"cancelled": cancelled}})
}

#[test]
fn a_cancel_sent_after_the_grace_answer_finds_nothing_running() {
    let (e, rx) = respawning_after(
        EngineOptions { cancel_grace: Some(Duration::from_millis(300)), ..EngineOptions::default() },
        Duration::from_millis(300),
    );
    send(&e, json!({"id": "long", "op": "rebuild", "document": {"sleep": 30}}));
    until_running(&e);
    send(&e, json!({"id": "c", "op": "cancel", "target": "long"}));
    assert_eq!(reply_to(&rx, "c"), ack("c", true));
    assert_eq!(reply_to(&rx, "long")["cancelled"], true);
    send(&e, json!({"id": "c2", "op": "cancel"}));
    assert_eq!(reply_to(&rx, "c2"), ack("c2", false));
    send(&e, json!({"id": "c3", "op": "cancel", "target": "long"}));
    assert_eq!(reply_to(&rx, "c3"), ack("c3", false));
    send(&e, json!({"id": "after", "op": "rebuild", "document": {"sleep": 0}}));
    assert_eq!(reply_to(&rx, "after")["ok"], true);
}

/// [`Fake`] that counts how often the engine let go of what documents held.
struct Docked(Fake, Arc<AtomicI64>);

impl Jobs for Docked {
    fn rebuild(&mut self, doc: &Value, t: f64, known: &Map<String, Value>, fresh: bool, ctx: &JobContext) -> JobResult {
        self.0.rebuild(doc, t, known, fresh, ctx)
    }

    fn run(&mut self, op: &str, req: &Map<String, Value>, ctx: &JobContext) -> JobResult {
        self.0.run(op, req, ctx)
    }

    fn release(&mut self) -> bool {
        self.1.fetch_add(1, Ordering::SeqCst);
        true
    }
}

/// [`Docked`] whose caches are held by an abandoned rebuild for its first `busy` releases, counting every attempt.
struct Held {
    docked: Docked,
    busy: i64,
    attempts: Arc<AtomicI64>,
}

impl Jobs for Held {
    fn rebuild(&mut self, doc: &Value, t: f64, known: &Map<String, Value>, fresh: bool, ctx: &JobContext) -> JobResult {
        self.docked.rebuild(doc, t, known, fresh, ctx)
    }

    fn release(&mut self) -> bool {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        if self.busy > 0 {
            self.busy -= 1;
            return false;
        }
        self.docked.release()
    }
}

#[test]
fn a_release_the_held_caches_refuse_is_asked_again_before_the_next_job() {
    let (tx, rx) = channel();
    let (releases, attempts) = (Arc::new(AtomicI64::new(0)), Arc::new(AtomicI64::new(0)));
    let docked = Docked(Fake { gate: None, rebuilds: Arc::new(AtomicI64::new(0)) }, releases.clone());
    let jobs = Held { docked, busy: 1, attempts: attempts.clone() };
    let e = Engine::start(jobs, Arc::new(Collect(Mutex::new(tx))));
    send(&e, json!({"id": "a1", "op": "rebuild", "doc": "A", "document": {"features": []}}));
    assert_eq!(replies_until(&rx, "a1"), vec![json!(["a1", "ok"])]);
    send(&e, json!({"id": "end", "op": "doc_end", "doc": "A"}));
    assert_eq!(replies_until(&rx, "end"), vec![json!(["end", {"ended": 0}])]);
    until_count(&attempts, 1);
    assert_eq!(releases.load(Ordering::SeqCst), 0);
    send(&e, json!({"id": "b1", "op": "rebuild", "doc": "B", "document": {"features": []}}));
    assert_eq!(replies_until(&rx, "b1"), vec![json!(["b1", "ok"])]);
    assert_eq!((attempts.load(Ordering::SeqCst), releases.load(Ordering::SeqCst)), (2, 1));
}

struct DocEngine {
    engine: Arc<Engine>,
    rx: Receiver<Message>,
    rebuilds: Arc<AtomicI64>,
    releases: Arc<AtomicI64>,
}

fn doc_engine(gate: Option<Receiver<()>>) -> DocEngine {
    let (tx, rx) = channel();
    let rebuilds = Arc::new(AtomicI64::new(0));
    let releases = Arc::new(AtomicI64::new(0));
    let jobs = Docked(Fake { gate, rebuilds: rebuilds.clone() }, releases.clone());
    let engine = Arc::new(Engine::start(jobs, Arc::new(Collect(Mutex::new(tx)))));
    DocEngine { engine, rx, rebuilds, releases }
}

/// Every reply (status frames left out) up to and including the one to `id`, as `[id, what]`.
fn replies_until(rx: &Receiver<Message>, id: &str) -> Vec<Value> {
    let mut out = vec![];
    loop {
        let m = text(next(rx));
        if m.get("status").is_some() {
            continue;
        }
        let what = if m["cancelled"] == true {
            json!("cancelled")
        } else if let Some(r) = m.get("result").filter(|_| m["ok"] == true) {
            r.get("ended").map_or(json!("ok"), |n| json!({"ended": n}))
        } else {
            json!({"error": m["error"]["message"]})
        };
        let done = m["id"] == id;
        out.push(json!([m["id"], what]));
        if done {
            return out;
        }
    }
}

fn until_count(n: &AtomicI64, want: i64) {
    let t0 = Instant::now();
    while n.load(Ordering::SeqCst) != want {
        assert!(t0.elapsed() < Duration::from_secs(5), "count stayed {} not {want}", n.load(Ordering::SeqCst));
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn ending_a_document_ends_its_queued_and_running_jobs_and_leaves_another_documents_job_to_run_next() {
    let (gate_tx, gate_rx) = channel();
    let d = doc_engine(Some(gate_rx));
    let e = &*d.engine;
    send(e, json!({"id": "b0", "op": "rebuild", "doc": "B", "document": {"features": []}}));
    gate_tx.send(()).unwrap();
    assert_eq!(replies_until(&d.rx, "b0"), vec![json!(["b0", "ok"])]);

    send(e, json!({"id": "a1", "op": "rebuild", "doc": "A", "document": {"features": [{"id": "f"}]}}));
    until_running(e);
    send(e, json!({"id": "a2", "op": "rebuild", "doc": "A", "document": {"features": []}}));
    send(e, json!({"id": "b1", "op": "rebuild", "doc": "B", "document": {"features": [{"id": "g"}]}}));
    send(e, json!({"id": "a3", "op": "import", "doc": "A"}));
    send(e, json!({"id": "end", "op": "doc_end", "doc": "A"}));
    assert_eq!(
        replies_until(&d.rx, "a1"),
        vec![
            json!(["a2", "cancelled"]),
            json!(["a3", "cancelled"]),
            json!(["end", {"ended": 3}]),
            json!(["a1", "cancelled"]),
        ]
    );
    gate_tx.send(()).unwrap();
    assert_eq!(replies_until(&d.rx, "b1"), vec![json!(["b1", "ok"])]);

    // A late request of the ended document is never run, and B still holds what it built.
    send(e, json!({"id": "a4", "op": "rebuild", "doc": "A", "document": {"features": []}}));
    assert_eq!(replies_until(&d.rx, "a4"), vec![json!(["a4", "cancelled"])]);
    assert_eq!((d.rebuilds.load(Ordering::SeqCst), d.releases.load(Ordering::SeqCst)), (3, 0));

    // Ending the last document releases the caches, and the next document starts on a clean engine.
    send(e, json!({"id": "end-b", "op": "doc_end", "doc": "B"}));
    assert_eq!(replies_until(&d.rx, "end-b"), vec![json!(["end-b", {"ended": 0}])]);
    until_count(&d.releases, 1);
    send(e, json!({"id": "c1", "op": "rebuild", "doc": "C", "document": {"features": []}}));
    gate_tx.send(()).unwrap();
    assert_eq!(replies_until(&d.rx, "c1"), vec![json!(["c1", "ok"])]);
    assert_eq!((d.rebuilds.load(Ordering::SeqCst), d.releases.load(Ordering::SeqCst)), (4, 1));
    assert!(d.rx.try_recv().is_err());
}

#[test]
fn a_delta_is_applied_only_to_the_document_that_sent_its_base_revision() {
    let d = doc_engine(None);
    let e = &*d.engine;
    let whole = |id: &str, doc: &str| json!({"id": id, "op": "rebuild", "doc": doc, "revision": 5, "document": {"features": [{"id": "f"}]}});
    let delta = |id: &str, doc: &str| {
        json!({"id": id, "op": "rebuild", "doc": doc, "baseRevision": 5, "revision": 6,
            "ops": {"length": 2, "set": [[1, {"id": "g"}]]}})
    };
    send(e, whole("x1", "X"));
    assert_eq!(replies_until(&d.rx, "x1"), vec![json!(["x1", "ok"])]);
    send(e, delta("y1", "Y"));
    assert_eq!(text(next(&d.rx)), json!({"id": "y1", "ok": true, "result": {"resync": true}}));
    send(e, delta("x2", "X"));
    assert_eq!(replies_until(&d.rx, "x2"), vec![json!(["x2", "ok"])]);

    // After X ends, a new document sending the same revisions starts from its own whole document.
    send(e, json!({"id": "end", "op": "doc_end", "doc": "X"}));
    assert_eq!(replies_until(&d.rx, "end"), vec![json!(["end", {"ended": 0}])]);
    until_count(&d.releases, 1);
    send(e, delta("z1", "Z"));
    assert_eq!(text(next(&d.rx)), json!({"id": "z1", "ok": true, "result": {"resync": true}}));
    send(e, whole("z2", "Z"));
    assert_eq!(replies_until(&d.rx, "z2"), vec![json!(["z2", "ok"])]);
    assert_eq!(d.rebuilds.load(Ordering::SeqCst), 3);
}

#[test]
fn ending_every_document_of_a_client_and_dropping_it_take_the_same_path() {
    let (gate_tx, gate_rx) = channel();
    let (tx, _rx) = channel();
    let releases = Arc::new(AtomicI64::new(0));
    let jobs = Docked(Fake { gate: Some(gate_rx), rebuilds: Arc::new(AtomicI64::new(0)) }, releases.clone());
    let engine = Arc::new(Engine::start(jobs, Arc::new(Collect(Mutex::new(tx)))));
    let (a_tx, a_rx) = channel();
    let (b_tx, b_rx) = channel();
    let a = engine.client(Arc::new(Collect(Mutex::new(a_tx))));
    let b = engine.client(Arc::new(Collect(Mutex::new(b_tx))));

    say(&a, json!({"id": "a1", "op": "rebuild", "doc": "P", "document": {"features": []}}));
    until_running(&engine);
    say(&a, json!({"id": "a2", "op": "import", "doc": "Q"}));
    say(&b, json!({"id": "b1", "op": "rebuild", "doc": "P", "document": {"features": []}}));
    say(&a, json!({"id": "bad", "op": "doc_end"}));
    assert_eq!(replies_until(&a_rx, "bad"), vec![json!(["bad", {"error": "doc_end names a doc or all"}])]);
    say(&a, json!({"id": "end", "op": "doc_end", "all": true}));
    assert_eq!(
        replies_until(&a_rx, "a1"),
        vec![json!(["a2", "cancelled"]), json!(["end", {"ended": 2}]), json!(["a1", "cancelled"])]
    );
    until_count(&releases, 1);
    gate_tx.send(()).unwrap();
    assert_eq!(replies_until(&b_rx, "b1"), vec![json!(["b1", "ok"])]);

    say(&b, json!({"id": "b2", "op": "rebuild", "doc": "P", "document": {"features": []}}));
    until_running(&engine);
    drop(b);
    until_count(&releases, 2);
    assert!(engine.running.lock().unwrap().is_none());
    assert!(engine.waiting.lock().unwrap().is_empty());
    assert!(a_rx.try_recv().is_err());
}

#[test]
fn a_test_hold_names_the_ops_it_holds() {
    let spec = "import=20000, rebuild=6000";
    assert_eq!(supervise::hold_ms(spec, "import"), Some(20000));
    assert_eq!(supervise::hold_ms(spec, "rebuild"), Some(6000));
    assert_eq!(supervise::hold_ms(spec, "export"), None);
    assert_eq!(supervise::hold_ms("import=soon", "import"), None);
}

struct TwoClients {
    engine: Arc<Engine>,
    releases: Arc<AtomicI64>,
    app: (Client, Receiver<Message>),
    mcp: (Client, Receiver<Message>),
}

fn app_and_assistant() -> TwoClients {
    let (tx, _rx) = channel();
    let releases = Arc::new(AtomicI64::new(0));
    let jobs = Docked(Fake { gate: None, rebuilds: Arc::new(AtomicI64::new(0)) }, releases.clone());
    let engine = Arc::new(Engine::start(jobs, Arc::new(Collect(Mutex::new(tx)))));
    let pair = || {
        let (t, r) = channel();
        (engine.client(Arc::new(Collect(Mutex::new(t)))), r)
    };
    let (app, mcp) = (pair(), pair());
    TwoClients { engine, releases, app, mcp }
}

fn built(c: &(Client, Receiver<Message>), id: &str, doc: Option<&str>) {
    let mut req = json!({"id": id, "op": "rebuild", "revision": 1, "document": {"features": [{"id": "f"}]}});
    if let Some(d) = doc {
        req["doc"] = json!(d);
    }
    say(&c.0, req);
    assert_eq!(replies_until(&c.1, id), vec![json!([id, "ok"])]);
}

fn ended(c: &(Client, Receiver<Message>), id: &str, doc: &str) {
    say(&c.0, json!({"id": id, "op": "doc_end", "doc": doc}));
    assert_eq!(replies_until(&c.1, id), vec![json!([id, {"ended": 0}])]);
}

#[test]
fn an_assistant_that_names_no_document_does_not_keep_an_ended_documents_caches_held() {
    let t = app_and_assistant();
    built(&t.mcp, "m1", None);
    built(&t.app, "a1", Some("A"));
    built(&t.app, "b1", Some("B"));
    ended(&t.app, "end-a", "A");
    // B is still open, so nothing is released.
    built(&t.app, "b2", Some("B"));
    assert_eq!(t.releases.load(Ordering::SeqCst), 0);
    ended(&t.app, "end-b", "B");
    until_count(&t.releases, 1);
    built(&t.mcp, "m2", None);
    built(&t.app, "c1", Some("C"));
    ended(&t.app, "end-c", "C");
    until_count(&t.releases, 2);
    assert!(t.engine.waiting.lock().unwrap().is_empty());
}

#[test]
fn the_ended_documents_kept_are_the_latest_sixty_four() {
    let t = app_and_assistant();
    let late = |c: &(Client, Receiver<Message>), id: &str, doc: &str| {
        say(&c.0, json!({"id": id, "op": "rebuild", "doc": doc, "revision": 1, "document": {"features": []}}));
        replies_until(&c.1, id)
    };
    for n in 0..64 {
        ended(&t.app, &format!("e{n}"), &format!("d{n}"));
    }
    ended(&t.app, "again", "d7");
    assert_eq!(t.engine.gone.lock().unwrap().len(), 64);
    assert_eq!(late(&t.app, "l0", "d0"), vec![json!(["l0", "cancelled"])]);
    assert_eq!(late(&t.app, "l63", "d63"), vec![json!(["l63", "cancelled"])]);
    ended(&t.mcp, "other", "d0");
    assert_eq!(t.engine.gone.lock().unwrap().len(), 64);
    assert_eq!(late(&t.app, "l0b", "d0"), vec![json!(["l0b", "ok"])]);
    assert_eq!(late(&t.mcp, "m0", "d0"), vec![json!(["m0", "cancelled"])]);
    assert_eq!(late(&t.app, "l1", "d1"), vec![json!(["l1", "cancelled"])]);
    ended(&t.app, "e64", "d64");
    assert_eq!(t.engine.gone.lock().unwrap().len(), 64);
    assert_eq!(late(&t.app, "l1b", "d1"), vec![json!(["l1b", "ok"])]);
    assert_eq!(late(&t.app, "l2", "d2"), vec![json!(["l2", "cancelled"])]);
    assert_eq!(late(&t.app, "l64", "d64"), vec![json!(["l64", "cancelled"])]);
}

#[test]
fn ending_every_document_keeps_the_ended_ones_gone_and_dropping_the_client_forgets_them() {
    let (gate_tx, gate_rx) = channel();
    let (tx, _rx) = channel();
    let jobs = Docked(Fake { gate: Some(gate_rx), rebuilds: Arc::new(AtomicI64::new(0)) }, Arc::new(AtomicI64::new(0)));
    let engine = Arc::new(Engine::start(jobs, Arc::new(Collect(Mutex::new(tx)))));
    let (a_tx, a_rx) = channel();
    let a = engine.client(Arc::new(Collect(Mutex::new(a_tx))));
    let (b_tx, b_rx) = channel();
    let b = engine.client(Arc::new(Collect(Mutex::new(b_tx))));
    say(&a, json!({"id": "r0", "op": "doc_end", "doc": "R"}));
    assert_eq!(replies_until(&a_rx, "r0"), vec![json!(["r0", {"ended": 0}])]);
    say(&a, json!({"id": "p1", "op": "rebuild", "doc": "P", "document": {"features": []}}));
    until_running(&engine);
    say(&a, json!({"id": "q1", "op": "import", "doc": "Q"}));
    say(&a, json!({"id": "n1", "op": "import"}));
    say(&a, json!({"id": "all", "op": "doc_end", "all": true}));
    assert_eq!(
        replies_until(&a_rx, "p1"),
        vec![
            json!(["q1", "cancelled"]),
            json!(["n1", "cancelled"]),
            json!(["all", {"ended": 3}]),
            json!(["p1", "cancelled"])
        ]
    );
    let gone = |e: &Engine| e.gone.lock().unwrap().iter().cloned().collect::<Vec<_>>();
    let id_a = a.id;
    assert_eq!(gone(&engine), vec![(id_a, "R".into()), (id_a, "P".into()), (id_a, "Q".into())]);
    for (id, doc) in [("p2", "P"), ("q2", "Q"), ("r2", "R")] {
        say(&a, json!({"id": id, "op": "rebuild", "doc": doc, "document": {"features": []}}));
        assert_eq!(replies_until(&a_rx, id), vec![json!([id, "cancelled"])]);
    }
    say(&b, json!({"id": "b1", "op": "doc_end", "doc": "S"}));
    assert_eq!(replies_until(&b_rx, "b1"), vec![json!(["b1", {"ended": 0}])]);
    drop(a);
    assert_eq!(gone(&engine), vec![(b.id, "S".to_string())]);
    drop(gate_tx);
}
