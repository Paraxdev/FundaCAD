//! A fillet or chamfer picked where a round wall's seam meets its rim lands on
//! the rim, and one that cannot change the body says so.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::select::entity::edges_of;
use fundacad_geom::select::Resolver;
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const R: f64 = 50.0;
const H: f64 = 34.4;

fn ring_doc(blend: Option<Value>) -> Value {
    let mut features = vec![
        json!({"id": "f1", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "id": "e0", "x": 0, "y": 0, "radius": R},
            {"type": "circle", "id": "e1", "x": 0, "y": 0, "radius": 48}]}),
        json!({"id": "f2", "type": "extrude", "sketch": "f1", "distance": H,
               "operation": "new", "regions": [[49, 0, 0]]}),
    ];
    if let Some(mut b) = blend {
        b["id"] = json!("f3");
        features.push(b);
    }
    json!({"parameters": {}, "features": features, "bodyIds": {"f2:0": "body1"}})
}

fn rebuild(doc: &Value) -> builder::Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled")
}

fn built(doc: &Value) -> Shape {
    let r = rebuild(doc);
    assert!(
        r.errors.is_empty(),
        "{:?}",
        r.errors.iter().map(|e| &e.message).collect::<Vec<_>>()
    );
    r.bodies[0].shape.clone()
}

/// The top end of the outer wall's seam, the vertex it shares with the rim.
fn seam_top(ring: &Shape) -> [f64; 3] {
    let seam = edges_of(ring)
        .unwrap()
        .into_iter()
        .find(|e| {
            let (a, b) = e.ends.unwrap();
            (a.truncate().length() - R).abs() < 1e-6 && (a.truncate() - b.truncate()).length() < 1e-6
        })
        .expect("the outer wall has a seam");
    let (a, b) = seam.ends.unwrap();
    let top = if a.z > b.z { a } else { b };
    top.to_array()
}

#[test]
fn a_pick_on_the_seam_vertex_takes_the_rim() {
    let ring = built(&ring_doc(None));
    let p = seam_top(&ring);
    assert!((p[2] - H).abs() < 1e-6);
    let sel = json!({"kind": "edge", "by": "nearest", "point": p});
    let got = Resolver::new(None, None).edges(&ring, &sel).unwrap();
    assert_eq!(got.len(), 1);
    let circle = opencascade::select_access::edge_probe(&got[0])
        .and_then(|e| e.circle)
        .expect("the rim circle, not the seam line");
    assert!((circle.0 - R).abs() < 1e-6 && (circle.1[2] - H).abs() < 1e-6);
}

fn blend_at_seam_vertex(blend: Value) -> Shape {
    let ring = built(&ring_doc(None));
    let p = seam_top(&ring);
    let mut blend = blend;
    blend["edges"] = json!([{"kind": "edge", "by": "nearest", "point": p, "body": "body1"}]);
    let out = built(&ring_doc(Some(blend)));
    assert_eq!(kernel::count(&ring, Kind::Face), 4);
    out
}

#[test]
fn a_fillet_picked_on_the_seam_vertex_rounds_the_rim() {
    let out = blend_at_seam_vertex(json!({"type": "fillet", "radius": 1.0}));
    assert_eq!(kernel::count(&out, Kind::Face), 5, "the rim is rounded");
}

#[test]
fn a_chamfer_picked_on_the_seam_vertex_cuts_the_rim() {
    let out = blend_at_seam_vertex(json!({"type": "chamfer", "distance": 1.0}));
    assert_eq!(kernel::count(&out, Kind::Face), 5, "the rim is cut");
}

fn seam_error(blend: Value) -> builder::FeatureError {
    let mut blend = blend;
    blend["edges"] = json!([{"kind": "edge", "by": "nearest", "point": [R, 0, H / 2.0], "body": "body1"}]);
    let r = rebuild(&ring_doc(Some(blend)));
    assert_eq!(r.errors.len(), 1, "the seam is refused");
    r.errors[0].clone()
}

#[test]
fn a_fillet_on_the_seam_itself_is_refused() {
    let e = seam_error(json!({"type": "fillet", "radius": 1.0}));
    assert_eq!(e.feature_id.as_deref(), Some("f3"));
    assert_eq!(e.code.as_deref(), Some("edgeIsSeam"), "{}", e.message);
}

#[test]
fn a_chamfer_on_the_seam_itself_is_refused() {
    let e = seam_error(json!({"type": "chamfer", "distance": 1.0}));
    assert_eq!(e.code.as_deref(), Some("edgeIsSeam"), "{}", e.message);
}

#[test]
fn a_seam_among_real_edges_is_refused_too() {
    let mut blend = json!({"type": "fillet", "radius": 1.0});
    blend["edges"] = json!([
        {"kind": "edge", "by": "nearest", "point": [0, R, H], "body": "body1"},
        {"kind": "edge", "by": "nearest", "point": [R, 0, H / 2.0], "body": "body1"}
    ]);
    let r = rebuild(&ring_doc(Some(blend)));
    assert_eq!(r.errors.len(), 1, "a seam in the set is refused");
    assert_eq!(r.errors[0].code.as_deref(), Some("edgeIsSeam"), "{}", r.errors[0].message);
    assert!(r.errors[0].message.contains("one of the selected edges is a seam"), "{}", r.errors[0].message);
}

#[test]
fn every_edge_leaves_the_seams_out() {
    let mut blend = json!({"type": "fillet", "radius": 0.5});
    blend["edges"] = json!({"kind": "edge", "by": "all", "body": "body1"});
    let out = built(&ring_doc(Some(blend)));
    assert_eq!(kernel::count(&out, Kind::Face), 8, "four rims rounded");
}
