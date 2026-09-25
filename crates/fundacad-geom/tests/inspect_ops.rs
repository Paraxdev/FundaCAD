//! The `inspect` and `interference` ops against the requests and replies
//! tests/inspect/gen.py on the legacy branch recorded from the Python engine, then over the protocol.

mod support;

use fundacad_geom::builder::NoWatch;
use fundacad_geom::inspect;
use fundacad_geom::jobs::GeomJobs;
use fundacad_geom::select::Resolver;
use fundacad_protocol::JobResult;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, ItemKind};
use serde_json::{json, Map, Value};
use std::path::PathBuf;

fn cases() -> Vec<Value> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/inspect/oracle.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn json_of(r: JobResult) -> Value {
    match r {
        JobResult::Json(m) => Value::Object(m),
        _ => panic!("expected a JSON result"),
    }
}

/// A fused body whose face order the two kernels' booleans hand back
/// differently, compared with faces and edges renumbered by geometry.
const ORDER_FREE: [&str; 1] = ["l_shape"];

fn sort_key(v: &Value, fields: &[&str]) -> String {
    fields
        .iter()
        .map(|f| match &v[*f] {
            Value::Array(a) => a
                .iter()
                .map(|x| format!("{:.3}", x.as_f64().unwrap_or(0.0) + 0.0))
                .collect::<Vec<_>>()
                .join(","),
            Value::Number(n) => format!("{:.3}", n.as_f64().unwrap_or(0.0)),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn renumber(list: &mut Vec<Value>, fields: &[&str]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..list.len()).collect();
    order.sort_by_key(|&k| sort_key(&list[k], fields));
    let mut new_index = vec![0; list.len()];
    for (pos, &old) in order.iter().enumerate() {
        new_index[old] = pos;
    }
    *list = order.iter().map(|&k| list[k].clone()).collect();
    new_index
}

fn remap(v: &mut Value, key: &str, map: &[usize]) {
    if let Some(a) = v.get_mut(key).and_then(Value::as_array_mut) {
        for x in a.iter_mut() {
            *x = json!(map[x.as_u64().unwrap() as usize]);
        }
        a.sort_by_key(Value::as_u64);
    }
}

fn canonical_order(res: &mut Value) {
    for body in res["bodies"].as_array_mut().into_iter().flatten() {
        let Some(faces) = body.get_mut("faces").and_then(Value::as_array_mut) else {
            continue;
        };
        let map = renumber(faces, &["surface", "centroid", "area"]);
        for (pos, f) in faces.iter_mut().enumerate() {
            f["i"] = json!(pos);
            remap(f, "neighbors", &map);
        }
        if let Some(edges) = body.get_mut("edges").and_then(Value::as_array_mut) {
            renumber(edges, &["mid", "length"]);
            for (pos, e) in edges.iter_mut().enumerate() {
                e["i"] = json!(pos);
                remap(e, "faces", &map);
            }
        }
    }
}

#[test]
fn inspect_and_interference_match_the_python_engine() {
    let mut failures = Vec::new();
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        let req = case["request"].as_object().unwrap();
        let mut got = match req["op"].as_str().unwrap() {
            "inspect" => json_of(inspect::inspect_result(req, &NoWatch)),
            _ => json_of(inspect::interference_result(req, &NoWatch)),
        };
        if let Some(pairs) = got.get_mut("pairs").and_then(Value::as_array_mut) {
            for p in pairs {
                let m = p.as_object_mut().unwrap();
                let tris = m.remove("indices").and_then(|i| i.as_array().map(|a| a.len() / 3));
                let positions = m.remove("positions");
                assert!(positions.is_some() == tris.is_some(), "{name}: overlay mesh half present");
                m.insert("triangles".into(), json!(tris.unwrap_or(0)));
            }
        }
        let mut want = case["result"].clone();
        for v in [&mut got, &mut want] {
            if let Some(pairs) = v.get_mut("pairs").and_then(Value::as_array_mut) {
                for p in pairs {
                    let t = p["triangles"].as_u64().unwrap_or(0);
                    p["triangles"] = json!(t > 0);
                }
            }
        }
        if ORDER_FREE.contains(&name) {
            canonical_order(&mut got);
            canonical_order(&mut want);
        }
        support::diff(name, &got, &want, 1e-6, 1e-7, &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_selector_inspect_hands_back_finds_its_own_entity() {
    let shapes = [
        Shape::box_with_dimensions(20.0, 10.0, 4.0),
        Shape::cylinder_radius_height(10.0, 20.0),
        Shape::cylinder_radius_height(10.0, 4.0).subtract(&Shape::cylinder_radius_height(5.0, 4.0)).into(),
    ];
    for shape in &shapes {
        let body = inspect::InspectBody { id: json!("b1"), name: json!("Body1"), shape: Some(shape) };
        let rep = inspect::inspect_bodies(&[body], true, 400, 800).unwrap();
        let faces = sa::items(shape, ItemKind::Face);
        for f in rep[0]["faces"].as_array().unwrap() {
            let got = Resolver::new(None, None).faces(shape, &f["selector"]).unwrap();
            let i = f["i"].as_u64().unwrap() as usize;
            assert_eq!(got.len(), 1, "face {i}");
            assert!(got[0].is_same(&faces[i]), "face {i} resolved to another face");
        }
        let edges = sa::items(shape, ItemKind::Edge);
        for e in rep[0]["edges"].as_array().unwrap() {
            let got = Resolver::new(None, None).edges(shape, &e["selector"]).unwrap();
            let i = e["i"].as_u64().unwrap() as usize;
            assert_eq!(got.len(), 1, "edge {i}");
            assert!(got[0].is_same(&edges[i]), "edge {i} resolved to another edge");
        }
    }
}

#[test]
fn a_body_that_did_not_build_is_reported_empty() {
    let rep = inspect::inspect_bodies(
        &[inspect::InspectBody { id: json!("b1"), name: json!("Body1"), shape: None }],
        true,
        400,
        800,
    )
    .unwrap();
    assert_eq!(rep, vec![json!({"id": "b1", "name": "Body1", "empty": true})]);
}

#[test]
fn a_dense_candidate_set_is_capped_with_a_message() {
    let doc = json!({"features": (0..4).flat_map(|i| [
        json!({"id": format!("s{i}"), "type": "sketch", "plane": "XY",
               "entities": [{"type": "rectangle", "width": 20, "height": 20, "x": i * 2, "y": 0}]}),
        json!({"id": format!("e{i}"), "type": "extrude", "sketch": format!("s{i}"), "distance": 20}),
    ]).collect::<Vec<_>>()});
    let mut req = Map::new();
    req.insert("document".into(), doc);
    let (_, r) = inspect::rebuild_request(&req, &NoWatch).map_err(|_| ()).unwrap();
    let res = inspect::interference(&r.bodies, None, 2, &NoWatch);
    assert_eq!(res["truncated"], json!(true));
    assert!(res["message"].as_str().unwrap().starts_with("Stopped after checking 2 candidate pairs"));
    assert!(res["pairs"].as_array().unwrap().len() <= 2);
}

#[test]
fn both_ops_answer_over_the_protocol() {
    use fundacad_engine::{Engine, Outbox};
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
    let doc = json!({"features": [{"id": "b", "type": "box", "length": 20, "width": 10, "height": 4}]});
    engine.handle(Message::Text(json!({"id": 1, "op": "inspect", "document": doc, "detail": false}).to_string()));
    let reply: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"]["bodies"][0]["volume"], json!(800.0), "{reply}");
    engine.handle(Message::Text(json!({"id": 2, "op": "interference", "document": doc}).to_string()));
    let reply: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
    assert_eq!(reply["result"], json!({"pairs": []}), "{reply}");

    let result = |id: i64| -> Value {
        loop {
            let v: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
            if v["id"] == id && v.get("ok").is_some() {
                return v["result"].clone();
            }
        }
    };
    engine.handle(Message::Text(json!({"id": 3, "op": "rebuild", "document": doc, "revision": 1}).to_string()));
    let built = result(3);
    let etag = built["bodies"][0]["etag"].clone();
    let known = json!({"body1": etag});
    engine.handle(Message::Text(
        json!({"id": 4, "op": "rebuild", "document": doc, "revision": 2, "known": known}).to_string(),
    ));
    assert_eq!(result(4)["bodies"][0]["unchanged"], json!(true));
    // server.py `_compute_all_job` never answers with a stub, whatever the client holds.
    engine.handle(Message::Text(
        json!({"id": 5, "op": "computeAll", "document": doc, "revision": 3, "known": known}).to_string(),
    ));
    let all = result(5);
    assert!(all["bodies"][0].get("unchanged").is_none(), "{all}");
    assert_eq!(all["bodies"][0]["etag"], etag);
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&all), keys(&built));
}

#[test]
fn a_summary_counts_without_measuring_and_places_shared_shapes() {
    use fundacad_geom::kernel;
    let cyl = kernel::make_cylinder(5.0, 10.0).unwrap();
    let turned = kernel::translated(&kernel::rotated(&cyl, [90.0, 0.0, 0.0]).unwrap(), [7.0, 3.0, 1.0]).unwrap();
    let tilted = kernel::rotated(&cyl, [30.0, 20.0, 0.0]).unwrap();
    let shapes = [&cyl, &turned, &tilted];
    let bodies: Vec<inspect::InspectBody> = shapes
        .iter()
        .map(|s| inspect::InspectBody { id: json!("b"), name: json!("B"), shape: Some(*s) })
        .collect();
    for _ in 0..2 {
        let rep = inspect::inspect_bodies_at(&bodies, inspect::Level::Summary, 400, 800).unwrap();
        for (r, s) in rep.iter().zip(shapes) {
            let want = kernel::bbox(s).unwrap();
            let got: Vec<f64> = ["min", "max"]
                .iter()
                .flat_map(|k| r["bbox"][k].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()))
                .collect();
            for (g, w) in got.iter().zip(want) {
                assert!((g - w).abs() < 1e-6, "{got:?} vs {want:?}");
            }
            assert_eq!(r["surfaces"], json!([["plane", 2], ["cylinder", 1]]));
            assert_eq!(r["wraps"].as_array().unwrap().len(), 1);
            assert_eq!(r["seams"].as_array().unwrap().len(), 1);
            assert_eq!(r["openEdges"], json!([]));
            assert!(r.get("faces").is_none());
        }
        let com = |i: usize| rep[i]["centerOfMass"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect::<Vec<_>>();
        let want = kernel::translated(&kernel::rotated(&kernel::make_cylinder(5.0, 10.0).unwrap(), [90.0, 0.0, 0.0]).unwrap(), [7.0, 3.0, 1.0]).unwrap();
        let plain = inspect::inspect_bodies(&[inspect::InspectBody { id: json!("b"), name: json!("B"), shape: Some(&want) }], false, 400, 800).unwrap();
        let expect: Vec<f64> = plain[0]["centerOfMass"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        for (g, w) in com(1).iter().zip(&expect) {
            assert!((g - w).abs() < 1e-6, "{:?} vs {expect:?}", com(1));
        }
        assert_eq!(rep[1]["volume"], rep[0]["volume"]);
    }
}
