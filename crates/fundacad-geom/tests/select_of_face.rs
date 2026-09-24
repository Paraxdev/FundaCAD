//! `by:"ofFace"` takes the face as a fingerprint or as any face selector.

use fundacad_core::schema::Selector;
use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use fundacad_geom::select::Resolver;
use opencascade::primitives::Shape;
use opencascade::select_access as sa;
use serde_json::{json, Value};

fn build(features: Vec<Value>) -> Rebuild {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let doc = json!({ "features": features });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn block() -> Value {
    json!({"id": "bx", "type": "box", "length": 20, "width": 20, "height": 10})
}

fn by_fingerprint() -> Value {
    json!({"kind": "edge", "by": "ofFace", "body": "body1",
           "face": {"centroid": [0, 0, 5], "normal": [0, 0, 1], "surface": "plane"}})
}

fn by_nearest() -> Value {
    json!({"kind": "edge", "by": "ofFace", "body": "body1",
           "face": {"kind": "face", "by": "nearest", "point": [3, 2, 5]}})
}

fn mids(part: &Shape, sel: &Value) -> Vec<[i64; 3]> {
    let mut out: Vec<[i64; 3]> = Resolver::new(None, None)
        .edges(part, sel)
        .unwrap()
        .iter()
        .map(|e| {
            let m = sa::edge_probe(e).and_then(|p| p.mid).expect("a midpoint");
            m.map(|c| (c * 1000.0).round() as i64)
        })
        .collect();
    out.sort_unstable();
    out
}

#[test]
fn a_nearest_face_gives_the_same_edges_as_its_fingerprint() {
    let r = build(vec![block()]);
    let part = &r.bodies[0].shape;
    let want = mids(part, &by_fingerprint());
    assert_eq!(want.len(), 4, "the top of a box has four edges");
    assert!(want.iter().all(|m| m[2] == 5000), "{want:?}");
    assert_eq!(mids(part, &by_nearest()), want);
    let normal = json!({"kind": "edge", "by": "ofFace",
                        "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}});
    assert_eq!(mids(part, &normal), want);
}

#[test]
fn a_nested_face_selector_parses_as_a_known_selector_and_round_trips() {
    for v in [by_fingerprint(), by_nearest()] {
        let s: Selector = serde_json::from_value(v.clone()).unwrap();
        assert!(matches!(s, Selector::Known(_)), "{v} did not parse: {s:?}");
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }
    let edge_in_face = json!({"kind": "edge", "by": "ofFace",
                              "face": {"kind": "edge", "by": "all"}});
    let s: Selector = serde_json::from_value(edge_in_face).unwrap();
    assert!(matches!(s, Selector::Invalid(_)), "an edge selector is not a face: {s:?}");
}

#[test]
fn a_fillet_on_a_face_picked_by_a_point_builds() {
    let fillet = |edges: Value| json!({"id": "fil", "type": "fillet", "radius": 1.5, "edges": edges});
    let near = build(vec![block(), fillet(by_nearest())]);
    assert!(near.errors.is_empty(), "{:?}", near.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let fp = build(vec![block(), fillet(by_fingerprint())]);
    assert!(fp.errors.is_empty(), "{:?}", fp.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let (a, b) = (kernel::volume(&near.bodies[0].shape), kernel::volume(&fp.bodies[0].shape));
    assert!(a < 4000.0 - 1.0, "the fillet took nothing off: {a}");
    assert!((a - b).abs() < 1e-6, "{a} against {b}");
}

#[test]
fn a_nested_edge_selector_is_refused() {
    let r = build(vec![
        block(),
        json!({"id": "fil", "type": "fillet", "radius": 1.5,
               "edges": {"kind": "edge", "by": "ofFace", "body": "body1",
                         "face": {"kind": "edge", "by": "all"}}}),
    ]);
    assert_eq!(r.errors.len(), 1);
}
