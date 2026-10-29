use fundacad_engine::*;
use fundacad_protocol::{FullBody, MeshResult, WireBody};
use fundacad_protocol::{JobResult, Message};
use serde_json::{json, Map, Value};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
        for step in doc["report"].as_array().into_iter().flatten() {
            let n = step[1].as_i64().unwrap_or(-1);
            match step[0].as_str() {
                Some("feature") => ctx.progress.feature(n),
                Some("meshing") => ctx.progress.meshing(n, step[2].as_i64().unwrap_or(-1)),
                _ => ctx.progress.phase(n),
            }
        }
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
fn ping_answers_on_the_read_path() {
    let (e, rx, _) = engine(None);
    send(&e, json!({"id": "p", "op": "ping"}));
    assert_eq!(text(next(&rx)), json!({"id": "p", "ok": true, "result": {"pong": true}}));
}

#[test]
fn a_rebuild_replies_with_a_binary_stream_when_asked() {
    let (e, rx, _) = engine(None);
    send(
        &e,
        json!({"id": "r", "op": "rebuild", "binary": true, "chunked": true, "revision": 1,
                    "document": {"features": [{"id": "f1"}]}}),
    );
    let mut frames = 0;
    loop {
        let Message::Binary(b) = next(&rx) else { panic!("expected a binary frame") };
        frames += 1;
        let n = u32::from_le_bytes(b[0..4].try_into().unwrap()) as usize;
        let h: Value = serde_json::from_slice(&b[4..4 + n]).unwrap();
        assert_eq!(h["id"], "r");
        if h["stream"]["final"] == true {
            break;
        }
    }
    assert_eq!(frames, 2);
}

#[test]
fn a_delta_patches_the_held_document_and_a_gap_asks_for_a_resync() {
    let (e, rx, rebuilds) = engine(None);
    send(&e, json!({"id": "a", "op": "rebuild", "revision": 1, "document": {"features": [{"id": "f1"}]}}));
    let a = text(next(&rx));
    assert_eq!(a["result"]["bodies"].as_array().unwrap().len(), 1);

    send(
        &e,
        json!({"id": "b", "op": "rebuild", "baseRevision": 1, "revision": 2,
                    "ops": {"length": 2, "set": [[1, {"id": "f2"}]]}}),
    );
    let b = text(next(&rx));
    assert_eq!(b["result"]["bodies"].as_array().unwrap().len(), 2);

    send(&e, json!({"id": "c", "op": "rebuild", "baseRevision": 7, "revision": 8, "ops": {}}));
    assert_eq!(text(next(&rx)), json!({"id": "c", "ok": true, "result": {"resync": true}}));

    send(&e, json!({"id": "d", "op": "rebuild", "baseRevision": 2, "revision": 3, "ops": {"length": 3}}));
    assert_eq!(text(next(&rx))["result"], json!({"resync": true}));
    assert_eq!(rebuilds.load(Ordering::SeqCst), 2);
}

#[test]
fn a_long_job_reports_progress_before_its_reply() {
    let (gate_tx, gate_rx) = channel();
    let (e, rx, _) = engine(Some(gate_rx));
    send(&e, json!({"id": "slow", "op": "rebuild", "document": {"features": []}}));
    let frame = text(next(&rx));
    assert_eq!(frame["status"], "building");
    assert_eq!(frame["id"], "slow");
    gate_tx.send(()).unwrap();
    loop {
        let m = text(next(&rx));
        if m.get("ok").is_some() {
            assert_eq!(m["ok"], true);
            break;
        }
    }
}

fn first_building_frame(report: Value) -> Value {
    let (gate_tx, gate_rx) = channel();
    let (e, rx, _) = engine(Some(gate_rx));
    send(&e, json!({"id": "slow", "op": "rebuild", "document": {"features": [], "report": report}}));
    let frame = text(next(&rx));
    gate_tx.send(()).unwrap();
    frame
}

#[test]
fn a_building_frame_names_the_phase_and_keeps_the_counters_to_their_own_phase() {
    let cases = [
        (json!([]), json!([0, -1, -1, -1])),
        (json!([["feature", 4]]), json!([1, 4, -1, -1])),
        (json!([["feature", 4], ["phase", 2]]), json!([2, -1, -1, -1])),
        (json!([["feature", 4], ["meshing", 3, 7]]), json!([3, -1, 3, 7])),
        (json!([["meshing", 3, 7], ["phase", 4]]), json!([4, -1, -1, -1])),
        (json!([["meshing", 3, 7], ["feature", 9]]), json!([1, 9, -1, -1])),
    ];
    for (report, want) in cases {
        let f = first_building_frame(report.clone());
        let got = json!([f["phase"], f["feature"], f["meshed"], f["meshTotal"]]);
        assert_eq!(got, want, "after {report}");
    }
}

fn first_import_frame(stage: i64, done: i64, total: i64) -> Value {
    let (gate_tx, gate_rx) = channel();
    let (e, rx, _) = engine(Some(gate_rx));
    send(&e, json!({"id": "imp", "op": "import", "stage": stage, "done": done, "total": total}));
    let frame = text(next(&rx));
    gate_tx.send(()).unwrap();
    let reply = text(next(&rx));
    assert_eq!(reply["id"], "imp");
    assert_eq!(reply["ok"], true);
    frame
}

#[test]
fn an_import_reports_its_stage_and_fraction_before_its_reply() {
    use fundacad_protocol::import_stage;
    let frame = first_import_frame(import_stage::TRANSFER, 3, 10);
    assert_eq!(
        frame,
        json!({"id": "imp", "status": "importing", "phase": import_stage::TRANSFER,
               "label": import_stage::label(import_stage::TRANSFER), "pct": 30})
    );
}

#[test]
fn an_import_stage_with_no_fraction_says_minus_one() {
    use fundacad_protocol::import_stage;
    let frame = first_import_frame(import_stage::WALK, -1, -1);
    assert_eq!(frame["status"], "importing");
    assert_eq!(frame["phase"], import_stage::WALK);
    assert_eq!(frame["pct"], -1);
}

#[test]
fn unknown_ops_and_bad_json_are_errors_not_hangs() {
    let (e, rx, _) = engine(None);
    send(&e, json!({"id": "u", "op": "frobnicate"}));
    let u = text(next(&rx));
    assert_eq!(u["ok"], false);
    assert_eq!(u["error"]["message"], "unknown op: frobnicate");
    e.handle(Message::Text("{not json".into()));
    assert_eq!(text(next(&rx))["ok"], false);
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
fn a_bounded_op_is_held_to_its_wall_clock_even_while_it_beats() {
    let clocks = Clocks { stall: Duration::from_secs(60), job: Duration::from_millis(500) };
    let (e, rx) = respawning(EngineOptions { clocks, test_ops: true, ..EngineOptions::default() });
    send(&e, json!({"id": "w", "op": "testSleep", "seconds": 20, "tick": true, "wall": true, "deaf": true}));
    let w = reply_to(&rx, "w");
    assert_eq!(w["error"]["message"], "operation timed out, geometry too complex or degenerate");
    send(&e, json!({"id": "s", "op": "testSleep", "seconds": 0.2}));
    assert_eq!(reply_to(&rx, "s")["result"]["slept"], 0.2);
}

#[test]
fn the_test_op_is_unknown_unless_enabled() {
    let (e, rx) = respawning(EngineOptions::default());
    send(&e, json!({"id": "t", "op": "testSleep", "seconds": 0}));
    assert_eq!(reply_to(&rx, "t")["ok"], false);
}

#[test]
fn compute_all_resends_bodies_the_client_already_holds() {
    let (e, rx, _) = engine(None);
    let doc = json!({"features": [{"id": "f1"}]});
    let known = json!({"body1": "e"});
    send(&e, json!({"id": "r", "op": "rebuild", "document": doc, "known": known}));
    assert_eq!(reply_to(&rx, "r")["result"]["bodies"][0]["unchanged"], true);
    send(&e, json!({"id": "c", "op": "computeAll", "document": doc, "known": known}));
    let c = reply_to(&rx, "c");
    assert!(c["result"]["bodies"][0].get("unchanged").is_none(), "{c}");
}

fn say(c: &Client, v: Value) {
    c.handle(Message::Text(v.to_string()));
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
fn a_delta_patches_its_own_clients_document_not_the_last_one_sent() {
    let (tx, _rx) = channel();
    let engine = Arc::new(Engine::start(
        Fake { gate: None, rebuilds: Arc::new(AtomicI64::new(0)) },
        Arc::new(Collect(Mutex::new(tx))),
    ));
    let (a_tx, a_rx) = channel();
    let (b_tx, b_rx) = channel();
    let app = engine.client(Arc::new(Collect(Mutex::new(a_tx))));
    let agent = engine.client(Arc::new(Collect(Mutex::new(b_tx))));
    say(&app, json!({"id": "a1", "op": "rebuild", "revision": 1, "document": {"features": [{"id": "f1"}]}}));
    assert_eq!(reply_to(&a_rx, "a1")["result"]["bodies"].as_array().unwrap().len(), 1);
    let four = json!({"features": [{"id": "x"}, {"id": "y"}, {"id": "z"}, {"id": "w"}]});
    say(&agent, json!({"id": "b1", "op": "rebuild", "revision": 1, "document": four}));
    assert_eq!(reply_to(&b_rx, "b1")["result"]["bodies"].as_array().unwrap().len(), 4);
    say(
        &app,
        json!({"id": "a2", "op": "rebuild", "baseRevision": 1, "revision": 2,
        "ops": {"set": [[0, {"id": "f1b"}]]}}),
    );
    assert_eq!(reply_to(&a_rx, "a2")["result"]["bodies"].as_array().unwrap().len(), 1);
}

fn ack(id: &str, cancelled: bool) -> Value {
    json!({"id": id, "ok": true, "result": {"cancelled": cancelled}})
}

#[test]
fn a_cancel_sent_after_an_answer_finds_nothing_running() {
    let (e, rx) = respawning_after(EngineOptions::default(), Duration::from_millis(300));
    send(&e, json!({"id": "a", "op": "rebuild", "document": {"sleep": 0.05}}));
    assert_eq!(reply_to(&rx, "a")["ok"], true);
    send(&e, json!({"id": "c", "op": "cancel", "target": "a"}));
    assert_eq!(reply_to(&rx, "c"), ack("c", false));
}

fn fake_engine(out: Arc<dyn Outbox>) -> Engine {
    Engine::start(Fake { gate: None, rebuilds: Arc::new(AtomicI64::new(0)) }, out)
}

fn streamed_rebuild(id: &str, bodies: usize) -> Value {
    let features: Vec<Value> = (0..bodies).map(|i| json!({"id": format!("f{i}")})).collect();
    json!({"id": id, "op": "rebuild", "binary": true, "chunked": true,
           "document": {"features": features}})
}

fn binary_head(m: Message) -> Value {
    let Message::Binary(b) = m else { panic!("expected a binary frame") };
    let n = u32::from_le_bytes(b[0..4].try_into().unwrap()) as usize;
    serde_json::from_slice(&b[4..4 + n]).unwrap()
}

#[test]
fn a_cancel_sent_after_a_streamed_answer_finds_nothing_running() {
    for (bodies, frames) in [(0, 1), (1, 2), (3, 2)] {
        let (tx, rx) = channel();
        let e = fake_engine(Arc::new(Lagging(Collect(Mutex::new(tx)), Duration::from_millis(300))));
        send(&e, streamed_rebuild("r", bodies));
        let mut got = 1;
        while binary_head(next(&rx))["stream"]["final"] != true {
            got += 1;
        }
        assert_eq!(got, frames, "{bodies} bodies");
        send(&e, json!({"id": "c", "op": "cancel"}));
        assert_eq!(text(next(&rx)), ack("c", false), "{bodies} bodies");
    }
}

/// Holds the job thread after the first binary frame until the test opens the
/// gate, without holding the channel, so a cancel can be acked meanwhile.
struct HeldAfterHead {
    out: Collect,
    gate: Mutex<Receiver<()>>,
    held: AtomicBool,
}

impl Outbox for HeldAfterHead {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        for m in msgs {
            let head = matches!(m, Message::Binary(_)) && !self.held.swap(true, Ordering::SeqCst);
            self.out.send(&mut std::iter::once(m))?;
            if head {
                let _ = self.gate.lock().unwrap().recv_timeout(Duration::from_secs(10));
            }
        }
        Ok(())
    }
}

#[test]
fn a_cancel_between_the_frames_of_a_streamed_answer_ends_it_cancelled() {
    let (tx, rx) = channel();
    let (gate_tx, gate_rx) = channel();
    let e = fake_engine(Arc::new(HeldAfterHead {
        out: Collect(Mutex::new(tx)),
        gate: Mutex::new(gate_rx),
        held: AtomicBool::new(false),
    }));
    send(&e, streamed_rebuild("r", 2));
    assert_eq!(binary_head(next(&rx))["stream"]["final"], false);
    send(&e, json!({"id": "c", "op": "cancel", "target": "r"}));
    assert_eq!(text(next(&rx)), ack("c", true));
    gate_tx.send(()).unwrap();
    assert_eq!(text(next(&rx)), json!({"id": "r", "ok": false, "cancelled": true, "error": {"message": "cancelled"}}));
    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
}

#[test]
fn a_request_right_after_another_clients_answer_is_not_queued_behind_it() {
    let (tx, _rx) = channel();
    let engine = Arc::new(fake_engine(Arc::new(Collect(Mutex::new(tx)))));
    let (a_tx, a_rx) = channel();
    let (b_tx, b_rx) = channel();
    let a = engine.client(Arc::new(Collect(Mutex::new(a_tx))));
    let b = engine.client(Arc::new(Lagging(Collect(Mutex::new(b_tx)), Duration::from_millis(300))));
    say(&b, json!({"id": "b0", "op": "rebuild", "document": {"features": [{"id": "f1"}]}}));
    assert_eq!(reply_to(&b_rx, "b0")["ok"], true);
    say(&a, json!({"id": "a1", "op": "rebuild", "document": {"features": [{"id": "f1"}, {"id": "f2"}]}}));
    let statuses = statuses_until(&a_rx, "a1");
    assert!(statuses.iter().all(|s| s == "building"), "{statuses:?}");
}
