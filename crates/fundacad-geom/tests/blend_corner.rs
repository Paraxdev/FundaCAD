//! Where three blended edges meet at a corner, the corner is one patch, not
//! three blends crossing in a point.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

fn corner_doc(blend: Value) -> Value {
    let mut blend = blend;
    blend["id"] = json!("f3");
    blend["edges"] = json!([
        {"kind": "edge", "by": "nearest", "point": [0, -20, 15.23], "body": "body1"},
        {"kind": "edge", "by": "nearest", "point": [20, 0, 15.23], "body": "body1"},
        {"kind": "edge", "by": "nearest", "point": [20, -20, 7.615], "body": "body1"}
    ]);
    json!({
        "parameters": {},
        "features": [
            {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
                {"type": "rectangle", "id": "e0", "width": 40, "height": 40, "x": 0, "y": 0}]},
            {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 15.23,
             "operation": "new", "regions": [[0, 0, 0]]},
            blend
        ],
        "bodyIds": {"f2:0": "body1"}
    })
}

fn build(doc: &Value) -> Shape {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(
        r.errors.is_empty(),
        "{:?}",
        r.errors.iter().map(|e| &e.message).collect::<Vec<_>>()
    );
    r.bodies[0].shape.clone()
}

#[test]
fn three_chamfered_edges_end_in_one_triangle() {
    let d = 3.35;
    let s = build(&corner_doc(json!({"type": "chamfer", "distance": d})));
    let faces = kernel::subshapes(&s, Kind::Face);
    assert_eq!(faces.len(), 10, "six sides, three chamfers and the corner");
    let side = d * 2f64.sqrt();
    let triangle = 3f64.sqrt() / 4.0 * side * side;
    let corner: Vec<_> = faces
        .iter()
        .filter(|f| kernel::count(f, Kind::Edge) == 3)
        .collect();
    assert_eq!(corner.len(), 1, "one three sided face");
    let fp = kernel::face_area_centre(corner[0]).expect("measurable");
    assert!(
        (fp[0] - triangle).abs() < 1e-6,
        "equilateral, {} vs {triangle}",
        fp[0]
    );
    let c = 20.0 - 2.0 * d / 3.0;
    assert!(
        (fp[1] - c).abs() < 1e-6 && (fp[2] + c).abs() < 1e-6,
        "at the corner, {fp:?}"
    );
    assert!(
        (fp[3] - (15.23 - 2.0 * d / 3.0)).abs() < 1e-6,
        "at the corner, {fp:?}"
    );
    for e in kernel::subshapes(corner[0], Kind::Edge) {
        assert!((kernel::length(&e) - side).abs() < 1e-6);
    }
}

#[test]
fn three_filleted_edges_meet_in_one_spherical_patch() {
    let s = build(&corner_doc(json!({"type": "fillet", "radius": 3.35})));
    assert_eq!(
        kernel::count(&s, Kind::Face),
        10,
        "six sides, three fillets and the corner"
    );
}
