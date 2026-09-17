//! `projectGeometry` and the rebuild's projection refresh against what
//! tests/projection/gen.py recorded from the sidecar.

mod support;

use fundacad_geom::builder::NoWatch;
use fundacad_geom::jobs::rebuild_result;
use fundacad_geom::projection;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

fn cases() -> Vec<Value> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/projection/oracle.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn fields(r: JobResult) -> Map<String, Value> {
    match r {
        JobResult::Json(m) => m,
        JobResult::Mesh(m) => {
            let mut f = m.fields;
            f.insert("bodies".into(), json!(vec![Value::Null; m.bodies.len()]));
            f
        }
    }
}

fn run(case: &Value) -> Value {
    match case["kind"].as_str().unwrap() {
        "op" => {
            let req = case["request"].as_object().unwrap();
            Value::Object(fields(projection::project_geometry_result(req, &NoWatch)))
        }
        _ => {
            let res = fields(rebuild_result(&case["document"], 0.1, &Map::new(), &NoWatch));
            let mut keep = Map::new();
            for k in ["projectionUpdates", "featureError", "error"] {
                if let Some(v) = res.get(k) {
                    keep.insert(k.into(), v.clone());
                }
            }
            let n = res.get("bodies").and_then(Value::as_array).map_or(0, Vec::len);
            keep.insert("bodyCount".into(), json!(n));
            Value::Object(keep)
        }
    }
}

#[test]
fn projection_matches_the_sidecar() {
    let mut failures = Vec::new();
    for case in cases() {
        let name = format!("{}:{}", case["kind"].as_str().unwrap(), case["name"].as_str().unwrap());
        let got = run(&case);
        support::diff(&name, &got, &case["result"], 1e-6, 0.0, &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn project_geometry_and_refresh_answer_over_the_protocol() {
    use fundacad_engine::{Engine, Outbox};
    use fundacad_geom::jobs::GeomJobs;
    use fundacad_protocol::Message;
    use std::sync::{mpsc, Arc, Mutex};

    struct Chan(Mutex<mpsc::Sender<String>>);
    impl Outbox for Chan {
        fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> std::io::Result<()> {
            for m in msgs {
                if let Message::Text(t) = m {
                    let _ = self.0.lock().unwrap().send(t);
                }
            }
            Ok(())
        }
    }
    let (tx, rx) = mpsc::channel();
    let engine = Engine::start(GeomJobs, Arc::new(Chan(Mutex::new(tx))));
    let reply = |id: i64| -> Value {
        loop {
            let v: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
            if v["id"] == id && v.get("ok").is_some() {
                return v;
            }
        }
    };
    let cyl = json!({"features": [{"id": "c", "type": "cylinder", "radius": 10, "height": 20}]});
    engine.handle(Message::Text(
        json!({"id": 1, "op": "projectGeometry", "document": cyl, "plane": "XY",
               "sources": [{"kind": "silhouette", "body": "body1"}]})
        .to_string(),
    ));
    assert_eq!(
        reply(1)["result"],
        json!({"results": [{"source_index": 0, "ok": true,
            "curves": [{"curve": {"kind": "circle", "x": 0.0, "y": 0.0, "r": 10.0}}]}]})
    );
    let mut doc = cyl.clone();
    doc["features"].as_array_mut().unwrap().push(json!({"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"id": "p", "type": "projected", "source": {"kind": "silhouette", "body": "body1", "group": "p"},
         "curve": {"kind": "circle", "x": 0, "y": 0, "r": 9}}]}));
    engine.handle(Message::Text(json!({"id": 2, "op": "rebuild", "document": doc, "revision": 1}).to_string()));
    assert_eq!(
        reply(2)["result"]["projectionUpdates"],
        json!([{"sketch": "s", "entity": "p",
            "curve": {"kind": "circle", "x": 0.0, "y": 0.0, "r": 10.0}, "stale": false}])
    );
}

#[test]
fn a_bad_plane_is_a_whole_call_error() {
    let req = json!({"document": {"features": []}, "plane": "nowhere", "sources": []});
    let got = fields(projection::project_geometry_result(req.as_object().unwrap(), &NoWatch));
    assert_eq!(Value::Object(got), json!({"error": {"message": "unknown plane reference: nowhere"}}));
}
