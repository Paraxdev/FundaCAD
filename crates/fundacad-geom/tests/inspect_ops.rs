//! The `inspect` and `interference` ops against the requests and replies
//! tests/inspect/gen.py recorded from the sidecar, then over the protocol.

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
fn inspect_and_interference_match_the_sidecar() {
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
}
