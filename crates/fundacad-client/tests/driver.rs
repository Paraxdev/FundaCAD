//! The driver against a scripted fake worker: this test binary runs itself as the worker when `FC_FAKE_SCRIPT` is
//! set, so resyncs, stale stubs, cancels, crashes and bad frames are covered without an engine build. The script is
//! one action per rebuild request, counted across restarts through the request log.

use fundacad_client::{Client, Doc, Event, Mesh, Options, WorkerCommand};
use fundacad_protocol::{read_message, write_message, Message};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    if let Ok(script) = std::env::var("FC_FAKE_SCRIPT") {
        let log = PathBuf::from(std::env::var_os("FC_FAKE_LOG").expect("FC_FAKE_LOG"));
        return fake_worker(&script, &log);
    }
    let tests: &[(&str, fn())] = &[
        ("revisions_move_only_on_load_and_real_edits", revisions_move_only_on_load_and_real_edits),
        ("a_resync_resends_whole_at_the_same_revision", a_resync_resends_whole_at_the_same_revision),
        ("a_stale_stub_resends_at_the_same_revision", a_stale_stub_resends_at_the_same_revision),
        ("a_cancelled_reply_resends", a_cancelled_reply_resends),
        ("a_crash_resends_once_and_keeps_the_last_stderr", a_crash_resends_once_and_keeps_the_last_stderr),
        ("a_second_crash_fails_that_revision_only", a_second_crash_fails_that_revision_only),
        ("a_reply_for_a_replaced_document_is_dropped", a_reply_for_a_replaced_document_is_dropped),
        ("a_corrupt_frame_fails_and_the_next_edit_goes_whole", a_corrupt_frame_fails_and_the_next_edit_goes_whole),
        ("an_engine_error_names_its_revision_and_feature", an_engine_error_names_its_revision_and_feature),
        (
            "the_worker_builds_up_to_the_rollback_without_suppressed",
            the_worker_builds_up_to_the_rollback_without_suppressed,
        ),
        ("one_shot_requests_answer_beside_rebuilds", one_shot_requests_answer_beside_rebuilds),
    ];
    let only = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    let mut ran = 0;
    for (name, t) in tests {
        if only.as_deref().is_some_and(|o| !name.contains(o)) {
            continue;
        }
        t();
        ran += 1;
        println!("test {name} ... ok");
    }
    println!("{ran} passed");
}

fn fake_worker(script: &str, log: &PathBuf) {
    let actions: Vec<&str> = script.split(',').collect();
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    while let Ok(Some(Message::Text(t))) = read_message(&mut stdin) {
        let req: Value = serde_json::from_str(&t).unwrap();
        if req["op"] != "rebuild" {
            one_shot(&req, &mut stdout);
            continue;
        }
        let n = std::fs::read_to_string(log).map(|s| s.lines().count()).unwrap_or(0);
        let action = actions.get(n).copied().unwrap_or("ok");
        let doc = req.get("document");
        let entry = json!({
            "revision": req["revision"],
            "base": req.get("baseRevision"),
            "full": doc.is_some(),
            "bodyIds": doc.and_then(|d| d.get("bodyIds")).is_some(),
            "features": match doc {
                Some(d) => json!(d["features"].as_array().map_or(0, Vec::len)),
                None => req["ops"]["length"].clone(),
            },
        });
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
        writeln!(f, "{entry}").unwrap();
        drop(f);
        let id = &req["id"];
        let ok = json!({"id": id, "ok": true, "result": {
            "bodies": [{"id": "body1", "etag": format!("e{}", req["revision"]),
                        "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "indices": [0, 1, 2]}],
            "bodyIds": {"f1": "body1"},
        }});
        let reply = match action {
            "crash" => {
                let mut e = std::io::stderr();
                let _ = e.write_all(b"\xff\xfe not utf-8\n");
                let _ = writeln!(e, "last words");
                std::process::exit(3);
            }
            "slow" => {
                std::thread::sleep(Duration::from_millis(400));
                ok
            }
            "resync" => json!({"id": id, "ok": true, "result": {"resync": true}}),
            "stub" => {
                json!({"id": id, "ok": true, "result": {"bodies": [{"id": "body1", "etag": "gone", "unchanged": true}]}})
            }
            "cancel" => json!({"id": id, "ok": false, "cancelled": true, "error": {"message": "cancelled"}}),
            "fail" => json!({"id": id, "ok": false, "error": {"message": "boom", "feature_id": "f1"}}),
            "garbage" => {
                let head =
                    json!({"id": id, "ok": true, "result": {"$buffers": [{"len": u64::MAX / 2, "dtype": "f32"}]}});
                let mut frame = Vec::new();
                let h = head.to_string().into_bytes();
                frame.extend_from_slice(&(h.len() as u32).to_le_bytes());
                frame.extend_from_slice(&h);
                write_message(&mut stdout, &Message::Binary(frame)).unwrap();
                continue;
            }
            _ => ok,
        };
        write_message(&mut stdout, &Message::Text(reply.to_string())).unwrap();
    }
}

/// Requests other than rebuilds, answered without touching the rebuild script.
fn one_shot(req: &Value, out: &mut impl std::io::Write) {
    let id = &req["id"];
    fn say(out: &mut impl std::io::Write, v: Value) {
        write_message(out, &Message::Text(v.to_string())).unwrap();
    }
    match req["op"].as_str().unwrap() {
        "export" => say(
            out,
            json!({"id": id, "ok": true, "result": {
                "path": req["path"], "features": req["document"]["features"].as_array().map(Vec::len),
            }}),
        ),
        "import" => {
            say(out, json!({"id": id, "status": "importing", "phase": "read", "label": "", "pct": 10}));
            say(out, json!({"id": id, "ok": true, "result": {"name": req["path"], "geom": {}}}));
        }
        "refuse" => say(out, json!({"id": id, "ok": false, "error": {"message": "no such body"}})),
        "stop" => say(out, json!({"id": id, "ok": false, "cancelled": true, "error": {"message": "cancelled"}})),
        _ => std::process::exit(4),
    }
}

struct Fake {
    client: Client,
    rx: Receiver<Event>,
    log: PathBuf,
}

fn fake(script: &str) -> Fake {
    let log = std::env::temp_dir().join(format!("fc-fake-{}-{}.log", std::process::id(), rand_tag()));
    let _ = std::fs::remove_file(&log);
    let cmd =
        WorkerCommand::new(std::env::current_exe().unwrap()).env("FC_FAKE_SCRIPT", script).env("FC_FAKE_LOG", &log);
    let (client, rx) = Client::spawn(cmd, Options::default()).unwrap();
    Fake { client, rx, log }
}

fn rand_tag() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

fn doc(name: &str) -> Doc {
    match json!({"name": name, "features": [{"id": "f1", "type": "box", "size": 1.0}], "parameters": {}}) {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

impl Fake {
    fn event(&self) -> Event {
        loop {
            match self.rx.recv_timeout(Duration::from_secs(20)).expect("an event within 20 s") {
                Event::Progress { .. } => {}
                e => return e,
            }
        }
    }

    fn mesh(&self) -> Arc<Mesh> {
        loop {
            match self.event() {
                Event::Mesh(m) => return m,
                Event::WorkerRestarted { .. } => {}
                e => panic!("expected a mesh, got {e:?}"),
            }
        }
    }

    /// What each request carried: (revision, base revision, sent whole, carried bodyIds).
    fn sent(&self) -> Vec<(u64, Option<u64>, bool, bool)> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                (v["revision"].as_u64().unwrap(), v["base"].as_u64(), v["full"] == true, v["bodyIds"] == true)
            })
            .collect()
    }

    /// How many features each request carried, the document's or the delta's length.
    fn features_sent(&self) -> Vec<u64> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["features"].as_u64().unwrap())
            .collect()
    }

    fn grow(&self) -> Option<u64> {
        self.client
            .edit(|d| {
                let f = &mut d.get_mut("features").unwrap()[0]["size"];
                *f = json!(f.as_f64().unwrap() + 1.0);
                Ok(())
            })
            .unwrap()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.log);
    }
}

fn revisions_move_only_on_load_and_real_edits() {
    let f = fake("");
    assert_eq!(f.client.load(doc("a")).unwrap(), 1);
    assert_eq!(f.mesh().revision, 1);

    assert_eq!(f.client.edit(|_| Ok(())).unwrap(), None);
    let err = f.client.edit(|d| {
        d.insert("x".into(), json!(1));
        Err("refused".into())
    });
    assert_eq!(err, Err("refused".into()));
    assert_eq!(f.client.edit(|d| if d.contains_key("x") { Err("kept".into()) } else { Ok(()) }).unwrap(), None);
    let panicked = f.client.edit(|d| {
        d.insert("x".into(), json!(1));
        panic!("in the edit")
    });
    assert!(panicked.unwrap_err().contains("in the edit"));
    assert_eq!(f.client.edit(|d| if d.contains_key("x") { Err("kept".into()) } else { Ok(()) }).unwrap(), None);

    assert_eq!(f.grow(), Some(2));
    let m = f.mesh();
    assert_eq!((m.revision, m.timing.full_send), (2, false));
    f.client.rebuild();
    let m = f.mesh();
    assert_eq!((m.revision, m.timing.full_send), (2, true));
    assert_eq!(f.sent(), vec![(1, None, true, false), (2, Some(1), false, false), (2, None, true, true)]);
}

fn a_resync_resends_whole_at_the_same_revision() {
    let f = fake("ok,resync");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    assert_eq!(f.grow(), Some(2));
    assert_eq!(f.mesh().revision, 2);
    assert_eq!(f.sent()[1..], [(2, Some(1), false, false), (2, None, true, true)]);
}

fn a_stale_stub_resends_at_the_same_revision() {
    let f = fake("ok,stub");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    f.grow();
    let m = f.mesh();
    assert_eq!((m.revision, m.fresh), (2, 1));
    assert_eq!(f.sent()[1..], [(2, Some(1), false, false), (2, Some(2), false, false)]);
}

fn a_cancelled_reply_resends() {
    let f = fake("ok,cancel");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    f.grow();
    assert_eq!(f.mesh().revision, 2);
    assert_eq!(f.sent()[2], (2, None, true, true));
}

fn a_crash_resends_once_and_keeps_the_last_stderr() {
    let f = fake("ok,crash");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    f.grow();
    match f.event() {
        Event::WorkerRestarted { stderr_tail, .. } => {
            assert_eq!(stderr_tail.last().map(String::as_str), Some("last words"), "{stderr_tail:?}")
        }
        e => panic!("expected a restart, got {e:?}"),
    }
    let m = f.mesh();
    assert_eq!((m.revision, m.timing.full_send), (2, true));
    assert_eq!(f.sent()[2], (2, None, true, true));
}

fn a_second_crash_fails_that_revision_only() {
    let f = fake("ok,crash,crash");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    f.grow();
    let mut restarts = 0;
    let failed = loop {
        match f.event() {
            Event::WorkerRestarted { .. } => restarts += 1,
            Event::Failed { revision, message, .. } => break (revision, message),
            e => panic!("expected a restart or a failure, got {e:?}"),
        }
    };
    assert!(matches!(f.event(), Event::WorkerRestarted { .. }));
    assert_eq!(restarts, 1);
    assert_eq!(failed.0, 2);
    assert!(failed.1.contains("crashed"), "{}", failed.1);
    assert_eq!(f.grow(), Some(3));
    assert_eq!(f.mesh().revision, 3);
}

fn a_reply_for_a_replaced_document_is_dropped() {
    let f = fake("ok,slow");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    assert_eq!(f.grow(), Some(2));
    assert_eq!(f.client.load(doc("b")).unwrap(), 3);
    assert_eq!(f.mesh().revision, 3);
    assert_eq!(f.sent()[2], (3, None, true, false), "document b went out without a's bodyIds");
}

fn a_corrupt_frame_fails_and_the_next_edit_goes_whole() {
    let f = fake("ok,garbage");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    f.grow();
    match f.event() {
        Event::Failed { revision, .. } => assert_eq!(revision, 2),
        e => panic!("expected a failure, got {e:?}"),
    }
    assert_eq!(f.grow(), Some(3));
    let m = f.mesh();
    assert_eq!((m.revision, m.timing.full_send), (3, true));
}

fn an_engine_error_names_its_revision_and_feature() {
    let f = fake("ok,fail");
    f.client.load(doc("a")).unwrap();
    f.mesh();
    f.grow();
    match f.event() {
        Event::Failed { revision, message, feature_id } => {
            assert_eq!((revision, message.as_str(), feature_id.as_deref()), (2, "boom", Some("f1")))
        }
        e => panic!("expected a failure, got {e:?}"),
    }
    assert_eq!(f.grow(), Some(3));
    let m = f.mesh();
    assert_eq!((m.revision, m.timing.full_send), (3, false));
}

fn the_worker_builds_up_to_the_rollback_without_suppressed() {
    let f = fake("");
    let mut d = doc("a");
    d["features"]
        .as_array_mut()
        .unwrap()
        .extend([json!({"id": "f2", "type": "box"}), json!({"id": "f3", "type": "box"})]);
    d.insert("rollback".into(), json!(2));
    f.client.load(d).unwrap();
    f.mesh();
    f.client.edit(|d| Ok(drop(d.insert("suppressed".into(), json!(["f1"]))))).unwrap();
    f.mesh();
    f.client.edit(|d| Ok(drop(d.insert("rollback".into(), Value::Null)))).unwrap();
    f.mesh();
    assert_eq!(f.features_sent(), [2, 1, 2]);
    let kept = f.client.edit(|d| if d["features"].as_array().unwrap().len() == 3 { Ok(()) } else { Err("cut".into()) });
    assert_eq!(kept, Ok(None), "the client keeps every feature");
}

fn one_shot_requests_answer_beside_rebuilds() {
    let f = fake("slow");
    let missing = f.client.export(Map::new());
    assert_eq!(missing.unwrap_err().message, "no document is open");
    let mut d = doc("a");
    d["features"].as_array_mut().unwrap().push(json!({"id": "f2", "type": "box"}));
    d.insert("rollback".into(), json!(1));
    f.client.load(d).unwrap();
    let mut req = Map::new();
    req.insert("path".into(), json!("C:/out/a.step"));
    let out = f.client.export(req).unwrap();
    assert_eq!(Value::Object(out), json!({"path": "C:/out/a.step", "features": 1}));
    let mut imp = Map::new();
    imp.insert("path".into(), json!("s.ply"));
    assert_eq!(f.client.request("import", imp).unwrap()["name"], json!("s.ply"));
    let no = f.client.request("refuse", Map::new()).unwrap_err();
    assert_eq!((no.message.as_str(), no.cancelled), ("no such body", false));
    assert!(f.client.request("stop", Map::new()).unwrap_err().cancelled);
    f.mesh();
    let died = f.client.request("die", Map::new()).unwrap_err();
    assert!(died.message.contains("stopped"), "{died:?}");
}
