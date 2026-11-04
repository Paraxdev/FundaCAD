//! Press/pull of a fillet blend on a box's vertical corner together with the top it meets square on. The blend's
//! slab leaves the top with freeform sides the kernel cannot carry on, and that was refused as closing in.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::{Shape, ShapeType};
use serde_json::{json, Value};

const FILLETED_BOX: &str = include_str!("../../../tools/harness/fixtures/filleted_box.json");

const BLEND: [f64; 3] = [43.59, 24.29, 34.75];
const TOP: [f64; 3] = [0.0, 0.0, 52.132];
const TOP_Z: f64 = 52.132;

fn rebuild(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn body(raw: &Value) -> Shape {
    let r = rebuild(raw);
    let errors: Vec<_> = r.errors.iter().map(|e| (&e.feature_id, &e.message)).collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(r.bodies.len(), 1);
    let shape = r.bodies[0].shape.clone();
    assert!(shape.is_valid().unwrap_or(false), "a valid body");
    assert_eq!(kernel::count(&shape, Kind::Solid), 1);
    assert_eq!(kernel::count(&shape, Kind::Shell), 1, "one closed shell");
    shape
}

fn near(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p, "body": "body1"})
}

fn with_push(mut raw: Value, faces: Vec<Value>, d: f64) -> Value {
    raw["features"].as_array_mut().unwrap().push(json!({"id": "push", "type": "press-pull",
        "face": faces, "distance": d, "operation": if d > 0.0 { "join" } else { "cut" }, "body": "body1"}));
    raw
}

fn face_at(shape: &Shape, p: [f64; 3]) -> Shape {
    shape
        .shape_map(ShapeType::Face)
        .iter()
        .min_by(|a, b| {
            let da = kernel::distance_to_point(a, p).unwrap_or(f64::MAX);
            let db = kernel::distance_to_point(b, p).unwrap_or(f64::MAX);
            da.total_cmp(&db)
        })
        .expect("a face")
}

fn filleted() -> Value {
    serde_json::from_str(FILLETED_BOX).expect("the filleted box")
}

fn push_blend_and_top(d: f64) {
    let before = kernel::volume(&body(&filleted()));
    let blend_alone = kernel::volume(&body(&with_push(filleted(), vec![near(BLEND)], d)));
    let after = body(&with_push(filleted(), vec![near(BLEND), near(TOP)], d));
    let top = kernel::bbox(&after).expect("a box")[5];
    assert!((top - (TOP_Z + d)).abs() < 1e-3, "d {d}: the top reaches {top}");
    let raised = face_at(&after, [0.0, 0.0, TOP_Z + d]);
    assert!(kernel::distance_to_point(&raised, [0.0, 0.0, TOP_Z + d]).unwrap() < 1e-6, "d {d}: a flat top");
    // The blend's slab as it builds alone, then the whole top, slab included, raised straight up.
    let expected = blend_alone + d * kernel::area(&raised);
    let grown = kernel::volume(&after);
    assert!((grown - expected).abs() < 1e-3 * (expected - before), "d {d}: {grown} against {expected}");
}

#[test]
fn the_blend_and_top_pushed_half_a_millimetre_build() {
    push_blend_and_top(0.5);
}

#[test]
fn the_blend_and_top_pushed_three_millimetres_build() {
    push_blend_and_top(3.0);
}

#[test]
fn the_blend_and_top_pushed_seven_millimetres_build() {
    push_blend_and_top(7.0);
}

#[test]
fn a_plain_box_top_pushed_alone_rises_as_before() {
    let raw = json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "id": "r", "width": 40, "height": 20, "x": 0, "y": 0}]},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"}]});
    let out = body(&with_push(raw, vec![near([5.0, 5.0, 10.0])], 7.0));
    assert!((kernel::volume(&out) - 40.0 * 20.0 * 17.0).abs() < 1e-3);
    assert_eq!(kernel::count(&out, Kind::Face), 6);
}
