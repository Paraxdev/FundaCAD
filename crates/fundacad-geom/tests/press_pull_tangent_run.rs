//! Press/pull of a fillet blend on a box's vertical corner together with the top it meets square on. Raising the
//! top leaves the blend carried up by a freeform face, which was refused as closing in. The blend then rounds the
//! taller corner again at its new radius, the same in either pick order.

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

fn with_push(raw: Value, faces: Vec<Value>, d: f64) -> Value {
    with_pushes(raw, vec![faces], d)
}

fn with_pushes(mut raw: Value, pushes: Vec<Vec<Value>>, d: f64) -> Value {
    for (i, faces) in pushes.into_iter().enumerate() {
        raw["features"].as_array_mut().unwrap().push(json!({"id": format!("push{i}"), "type": "press-pull",
            "face": faces, "distance": d, "operation": if d > 0.0 { "join" } else { "cut" }, "body": "body1"}));
    }
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

fn raised_top(after: &Shape, d: f64) -> Shape {
    let top = kernel::bbox(after).expect("a box")[5];
    assert!((top - (TOP_Z + d)).abs() < 1e-3, "d {d}: the top reaches {top}");
    let raised = face_at(after, [0.0, 0.0, TOP_Z + d]);
    assert!(kernel::distance_to_point(&raised, [0.0, 0.0, TOP_Z + d]).unwrap() < 1e-6, "d {d}: a flat top");
    raised
}

fn push_blend_and_top(d: f64) {
    let before = kernel::volume(&body(&filleted()));
    let blend_first = kernel::volume(&body(&with_push(filleted(), vec![near(BLEND), near(TOP)], d)));
    let top_first = kernel::volume(&body(&with_push(filleted(), vec![near(TOP), near(BLEND)], d)));
    assert!((blend_first - top_first).abs() < 1e-6, "d {d}: {blend_first} blend first, {top_first} top first");
    // The flat top goes first whatever the pick order, then the blend.
    let after = body(&with_pushes(filleted(), vec![vec![near(TOP)], vec![near(BLEND)]], d));
    raised_top(&after, d);
    let sequential = kernel::volume(&after);
    assert!(sequential > before);
    assert!((top_first - sequential).abs() < 1e-6, "d {d}: {top_first} against {sequential} pushed one by one");
}

/// The top pushed after the blend rises straight, its rounded corner with it.
fn push_top_after_blend(d: f64) {
    let before = kernel::volume(&body(&filleted()));
    let blend_alone = kernel::volume(&body(&with_push(filleted(), vec![near(BLEND)], d)));
    let after = body(&with_pushes(filleted(), vec![vec![near(BLEND)], vec![near(TOP)]], d));
    let raised = raised_top(&after, d);
    // The blend rounded again alone, then the whole top raised straight up.
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
fn the_top_pushed_after_the_blend_half_a_millimetre_rises_straight() {
    push_top_after_blend(0.5);
}

#[test]
fn the_top_pushed_after_the_blend_seven_millimetres_rises_straight() {
    push_top_after_blend(7.0);
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
