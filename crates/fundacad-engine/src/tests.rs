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
}

fn engine(gate: Option<Receiver<()>>) -> (Engine, Receiver<Message>, Arc<AtomicI64>) {
    let (tx, rx) = channel();
    let rebuilds = Arc::new(AtomicI64::new(0));
    let e = Engine::start(
        Fake {
            gate,
            rebuilds: rebuilds.clone(),
        },
        Arc::new(Collect(Mutex::new(tx))),
    );
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
    assert_eq!(
        text(next(&rx)),
        json!({"id": "p", "ok": true, "result": {"pong": true}})
    );
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
        let Message::Binary(b) = next(&rx) else {
            panic!("expected a binary frame")
        };
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
    send(
        &e,
        json!({"id": "a", "op": "rebuild", "revision": 1, "document": {"features": [{"id": "f1"}]}}),
    );
    let a = text(next(&rx));
    assert_eq!(a["result"]["bodies"].as_array().unwrap().len(), 1);

    send(
        &e,
        json!({"id": "b", "op": "rebuild", "baseRevision": 1, "revision": 2,
                    "ops": {"length": 2, "set": [[1, {"id": "f2"}]]}}),
    );
    let b = text(next(&rx));
    assert_eq!(b["result"]["bodies"].as_array().unwrap().len(), 2);

    send(
        &e,
        json!({"id": "c", "op": "rebuild", "baseRevision": 7, "revision": 8, "ops": {}}),
    );
    assert_eq!(
        text(next(&rx)),
        json!({"id": "c", "ok": true, "result": {"resync": true}})
    );

    send(
        &e,
        json!({"id": "d", "op": "rebuild", "baseRevision": 2, "revision": 3, "ops": {"length": 3}}),
    );
    assert_eq!(text(next(&rx))["result"], json!({"resync": true}));
    assert_eq!(rebuilds.load(Ordering::SeqCst), 2);
}

#[test]
fn cancel_stops_the_running_job_and_only_that_one() {
    let (gate_tx, gate_rx) = channel();
    let (e, rx, _) = engine(Some(gate_rx));
    send(
        &e,
        json!({"id": "long", "op": "rebuild", "document": {"features": []}}),
    );
    let t0 = Instant::now();
    while e.running.lock().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    send(
        &e,
        json!({"id": "c1", "op": "cancel", "target": "someone-else"}),
    );
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
fn a_long_job_reports_progress_before_its_reply() {
    let (gate_tx, gate_rx) = channel();
    let (e, rx, _) = engine(Some(gate_rx));
    send(
        &e,
        json!({"id": "slow", "op": "rebuild", "document": {"features": []}}),
    );
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

#[test]
fn a_closed_client_loses_its_queued_jobs_and_its_running_one() {
    let (gate_tx, gate_rx) = channel();
    let rebuilds = Arc::new(AtomicI64::new(0));
    let (tx, _rx) = channel();
    let engine = Arc::new(Engine::start(
        Fake {
            gate: Some(gate_rx),
            rebuilds: rebuilds.clone(),
        },
        Arc::new(Collect(Mutex::new(tx))),
    ));
    let (a_tx, a_rx) = channel();
    let (b_tx, b_rx) = channel();
    let a = engine.client(Arc::new(Collect(Mutex::new(a_tx))));
    let b = engine.client(Arc::new(Collect(Mutex::new(b_tx))));
    let doc = json!({"features": []});
    a.handle(Message::Text(
        json!({"id": "a1", "op": "rebuild", "document": doc}).to_string(),
    ));
    let t0 = Instant::now();
    while engine.running.lock().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    a.handle(Message::Text(
        json!({"id": "a2", "op": "rebuild", "document": doc}).to_string(),
    ));
    b.handle(Message::Text(
        json!({"id": "bc", "op": "cancel"}).to_string(),
    ));
    assert_eq!(text(next(&b_rx))["result"], json!({"cancelled": false}));
    drop(a);
    let a_first = text(next(&a_rx));
    assert_eq!(a_first["id"], "a1");
    assert_eq!(a_first["cancelled"], true);
    b.handle(Message::Text(
        json!({"id": "b1", "op": "rebuild", "document": doc}).to_string(),
    ));
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
    fn rebuild(
        &mut self,
        doc: &Value,
        _t: f64,
        _k: &Map<String, Value>,
        _f: bool,
        _ctx: &JobContext,
    ) -> JobResult {
        let secs = doc["sleep"].as_f64().unwrap_or(0.0);
        std::thread::sleep(Duration::from_secs_f64(secs));
        let mut m = Map::new();
        m.insert("slept".into(), json!(secs));
        JobResult::Json(m)
    }
}

fn respawning(opts: EngineOptions) -> (Engine, Receiver<Message>) {
    let (tx, rx) = channel();
    let e = Engine::start_with(
        Deaf,
        Some(Arc::new(Deaf::default)),
        opts,
        Arc::new(Collect(Mutex::new(tx))),
    );
    (e, rx)
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
    let clocks = Clocks {
        stall: Duration::from_millis(400),
        job: Duration::from_secs(25),
    };
    let (e, rx) = respawning(EngineOptions {
        clocks,
        ..EngineOptions::default()
    });
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
    let (e, rx) = respawning(EngineOptions {
        cancel_grace: Some(Duration::from_millis(300)),
        ..EngineOptions::default()
    });
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

#[test]
fn a_bounded_op_is_held_to_its_wall_clock_even_while_it_beats() {
    let clocks = Clocks {
        stall: Duration::from_secs(60),
        job: Duration::from_millis(500),
    };
    let (e, rx) = respawning(EngineOptions {
        clocks,
        test_ops: true,
        ..EngineOptions::default()
    });
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
