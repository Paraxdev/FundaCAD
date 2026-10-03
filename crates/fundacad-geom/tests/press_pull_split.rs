//! A cut that severs a body keeps every piece and says so, and a round face
//! resize that would sever one is refused instead.
//!
//! The round face case is a thin spike on a wide base with a pin channel up
//! its axis, the channel capped by a 45 degree cone. A round face keeps its
//! axis as it is resized and the channel wall keeps its own surface, so
//! pushing the cone up deepens the channel, and only a push that carries the
//! channel out through the tip, or a channel grown out through the flank,
//! would cut the tip off. That is refused with the reason, and the spike is
//! left as it was.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use serde_json::{json, Value};

const CONE: [f64; 3] = [-0.2307, 0.2389, 22.1667];
const CHANNEL: [f64; 3] = [0.7071, 0.7071, 10.0];

fn spike() -> Value {
    let line = |id: &str, a: [f64; 2], b: [f64; 2]| {
        json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
    };
    let loop_of = |pts: &[[f64; 2]]| -> Vec<Value> {
        (0..pts.len())
            .map(|i| line(&format!("l{i}"), pts[i], pts[(i + 1) % pts.len()]))
            .collect()
    };
    let flank = [
        [18.0, 2.0], [15.6, 5.2], [12.3, 7.5], [9.2, 10.5], [6.8, 14.0], [5.0, 17.6],
        [3.7, 21.2], [2.7, 24.8], [1.95, 27.9], [1.4038, 30.5],
    ];
    let spike = vec![
        line("floor", [0.0, 0.0], [60.0, 0.0]),
        line("rim", [60.0, 0.0], [60.0, 2.0]),
        line("foot", [60.0, 2.0], [18.0, 2.0]),
        json!({"type": "spline", "id": "flank",
               "points": flank.iter().map(|p| json!({"x": p[0], "y": p[1]})).collect::<Vec<_>>()}),
        line("cone", [1.4038, 30.5], [0.4688, 34.25]),
        line("tip", [0.4688, 34.25], [0.0, 34.25]),
        line("axis", [0.0, 34.25], [0.0, 0.0]),
    ];
    let channel = [[0.0, 0.0], [1.0, 0.0], [1.0, 21.5], [0.0, 22.5]];
    json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": "XZ", "entities": spike},
        {"id": "spike", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"},
        {"id": "pin_sk", "type": "sketch", "plane": "XZ", "entities": loop_of(&channel)},
        {"id": "pin", "type": "revolve", "sketch": "pin_sk", "axis": "Z", "angle": 360,
         "operation": "cut", "targets": ["body1"]},
    ]})
}

fn pushed(at: [f64; 3], distance: f64) -> Value {
    let mut raw = spike();
    raw["features"].as_array_mut().unwrap().push(json!({"id": "push", "type": "press-pull",
        "face": {"kind": "face", "by": "nearest", "point": at},
        "distance": distance, "operation": "cut", "body": "body1"}));
    raw
}

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn reasons(r: &Rebuild, feature: &str) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d["feature_id"] == feature)
        .filter_map(|d| d["reason"].as_str().map(str::to_owned))
        .collect()
}

fn refused(at: [f64; 3], distance: f64, what: &str) {
    let before = build(&spike());
    assert!(before.errors.is_empty(), "{:?}", before.errors);
    let r = build(&pushed(at, distance));
    let e = r.errors.iter().find(|e| e.feature_id.as_deref() == Some("push")).expect("the push is refused");
    assert_eq!(e.code.as_deref(), Some("cutsApart"), "{}", e.message);
    assert_eq!(e.message, format!("that size cuts the body apart, try a smaller {what}"));
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 1, "the spike stays whole");
    let (was, now) = (kernel::volume(&before.bodies[0].shape), kernel::volume(&r.bodies[0].shape));
    assert!((now - was).abs() < 1e-6, "{now} against {was}");
}

fn builds_whole(at: [f64; 3], distance: f64) {
    let r = build(&pushed(at, distance));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 1);
}

/// The cone rises by 5.85 along its normal, so its apex rises by 5.85√2 and
/// the channel's r 1 wall runs up to meet it: what is removed is that much
/// more channel, measured with booleans since the volume integral of the
/// spline flank is only good to a couple of mm3.
#[test]
fn pushing_the_cone_up_deepens_the_channel() {
    let before = build(&spike());
    assert!(before.errors.is_empty(), "{:?}", before.errors);
    let before = &before.bodies[0].shape;
    let r = build(&pushed(CONE, -5.85));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let after = &r.bodies[0].shape;
    assert_eq!(kernel::count(after, Kind::Solid), 1);
    let top = kernel::bbox(after).expect("a box")[5];
    assert!((top - 34.25).abs() < 1e-3, "the tip stays: {top}");
    let gone = kernel::volume(&kernel::boolean_op(before, &[after], BoolKind::Cut).expect("cut"));
    let deeper = std::f64::consts::PI * 5.85 * std::f64::consts::SQRT_2;
    assert!((gone - deeper).abs() < 1e-3 * deeper, "removed {gone}, the deeper channel is {deeper}");
    assert!(reasons(&r, "push").is_empty(), "{:?}", reasons(&r, "push"));
}

/// At -7 the cone meets the channel wall at z 31.4, under the spike's top
/// cone, and at -8 at z 32.8, above where that cone narrows to r 1.
#[test]
fn pushing_the_cone_out_through_the_tip_is_refused() {
    builds_whole(CONE, -7.0);
    refused(CONE, -8.0, "offset");
}

/// Grown to r 4 the cone still closes the channel inside the flank, at r 6
/// the channel is wider than the spike below where the cone closes it.
#[test]
fn growing_the_channel_out_through_the_flank_is_refused() {
    builds_whole(CHANNEL, -3.0);
    refused(CHANNEL, -5.0, "radius");
}

/// The control: a push that stays inside the spike neither splits nor breaks out.
#[test]
fn a_press_pull_that_stays_inside_says_nothing() {
    let r = build(&pushed(CONE, -1.0));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 1);
    assert!(reasons(&r, "push").is_empty(), "{:?}", reasons(&r, "push"));
}

/// A groove 0.1 short of a plate's end, its floor 1 above the bottom, pushed
/// down by 2: the 0.05% strip past it falls off, stays in the body, and the
/// build says the push split it.
#[test]
fn a_press_pull_that_severs_a_strip_keeps_it_and_says_so() {
    let raw = json!({"parameters": {}, "features": [
        {"id": "bar", "type": "box", "length": 200, "width": 200, "height": 10, "operation": "new"},
        {"id": "groove", "type": "box", "length": 0.4, "width": 220, "height": 9, "operation": "new"},
        {"id": "place", "type": "move", "dx": 99.7, "dy": 0, "dz": 0.5, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
        {"id": "carve", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
        {"id": "push", "type": "press-pull",
         "face": {"kind": "face", "by": "nearest", "point": [99.7, 0.0, -4.0]},
         "distance": -2, "operation": "cut", "body": "body1"},
    ]});
    let r = build(&raw);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1, "the pieces stay one body");
    let solids = kernel::subshapes(&r.bodies[0].shape, Kind::Solid);
    assert_eq!(solids.len(), 2, "both sides of the push stay");
    let total = kernel::volume(&r.bodies[0].shape);
    assert!((total - (400_000.0 - 800.0)).abs() < 1e-3, "{total}");
    assert_eq!(reasons(&r, "push"), vec!["the cut split Box into 2 pieces".to_owned()]);
}

/// An extrude cut that shaves a 0.05% strip off a plate leaves the strip in
/// the body, and the build says the cut split it.
#[test]
fn an_extrude_cut_that_shaves_off_a_strip_keeps_it_and_says_so() {
    let raw = json!({"parameters": {}, "features": [
        {"id": "bar", "type": "box", "length": 200, "width": 200, "height": 10, "operation": "new"},
        {"id": "sk", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "r", "x": 99.8, "y": 0, "width": 0.2, "height": 220}]},
        {"id": "cut", "type": "extrude", "sketch": "sk", "distance": 20, "symmetric": true,
         "operation": "cut", "targets": ["body1"]},
    ]});
    let r = build(&raw);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let solids = kernel::subshapes(&r.bodies[0].shape, Kind::Solid);
    assert_eq!(solids.len(), 2, "both sides of the cut stay");
    let total = kernel::volume(&r.bodies[0].shape);
    assert!((total - (400_000.0 - 400.0)).abs() < 1e-3, "{total}");
    assert_eq!(reasons(&r, "cut"), vec!["the cut split Box into 2 pieces".to_owned()]);
    assert!(reasons(&r, "bar").is_empty());
}
