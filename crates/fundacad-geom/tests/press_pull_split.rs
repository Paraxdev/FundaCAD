//! A cut that severs a body keeps every piece and says so.
//!
//! The case is a thin spike on a wide base with a pin channel up its axis,
//! the channel capped by a 45 degree cone. Pushing that cone up with press/pull
//! offsets it along its normal, so it rises and widens, breaks out through the
//! spike's flank and cuts the tip off. The tip is far under 0.1% of the body,
//! which is exactly what the build's debris drop used to throw away unsaid.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use serde_json::{json, Value};

const PUSH: f64 = -5.85;

fn spike(with_push: bool) -> Value {
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
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XZ", "entities": spike}),
        json!({"id": "spike", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"}),
        json!({"id": "pin_sk", "type": "sketch", "plane": "XZ", "entities": loop_of(&channel)}),
        json!({"id": "pin", "type": "revolve", "sketch": "pin_sk", "axis": "Z", "angle": 360,
               "operation": "cut", "targets": ["body1"]}),
        // A stretched sphere is a freeform face, and with one anywhere on the
        // body the kernel refuses the clean offset, so the push thickens the
        // cone into a slab instead. That slab is what breaks out of the spike.
        json!({"id": "dimple", "type": "sphere", "radius": 1, "operation": "new"}),
        json!({"id": "stretch", "type": "scale", "sx": 10, "sy": 10, "sz": 1.5, "about": [0, 0, 0], "bodies": ["body2"]}),
        json!({"id": "place", "type": "move", "dx": 35, "dy": 0, "dz": 2, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}),
        json!({"id": "carve", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}),
    ];
    if with_push {
        features.push(json!({"id": "push", "type": "press-pull",
            "face": {"kind": "face", "by": "nearest", "point": [-0.2307, 0.2389, 22.1667]},
            "distance": PUSH, "operation": "cut", "body": "body1"}));
    }
    json!({"parameters": {}, "features": features})
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

#[test]
fn a_press_pull_that_severs_the_tip_keeps_it_and_says_so() {
    let before = build(&spike(false));
    assert!(before.errors.is_empty(), "{:?}", before.errors);
    let before = &before.bodies[0].shape;

    let r = build(&spike(true));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1, "the pieces stay one body");
    let after = &r.bodies[0].shape;

    let solids = kernel::subshapes(after, Kind::Solid);
    assert_eq!(solids.len(), 2, "the severed tip is gone");
    let tip = solids
        .iter()
        .find(|s| kernel::bbox(s).is_some_and(|b| b[2] > 25.0))
        .expect("a piece above the break");
    let tip_box = kernel::bbox(tip).expect("a box");
    assert!((tip_box[5] - 34.25).abs() < 1e-3, "the tip reaches the apex: {tip_box:?}");
    assert!(kernel::volume(tip) > 5.0, "the tip is a real piece: {}", kernel::volume(tip));

    // The face moves along its normal and its rim sweeps a 45 degree side, so
    // the tool is that slab: old cone, swept rim, new cone.
    let s = -PUSH / std::f64::consts::SQRT_2;
    let slab = [[0.0, 22.5], [1.0, 21.5], [1.0 + s, 21.5 + s], [0.0, 22.5 + 2.0 * s]];
    let slab_doc = json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": "XZ", "entities": (0..4).map(|i| {
            let (a, b) = (slab[i], slab[(i + 1) % 4]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        }).collect::<Vec<_>>()},
        {"id": "slab", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"},
    ]});
    let tool = build(&slab_doc).bodies.remove(0).shape;
    let removed = kernel::volume(&kernel::boolean_op(before, &[&tool], BoolKind::Common).expect("common"));
    // Measured with booleans, since the volume integral of the thickened
    // faces is only good to a couple of mm3 on this body.
    let gone = kernel::boolean_op(before, &[after], BoolKind::Cut).expect("cut");
    let lost = kernel::volume(&kernel::boolean_op(&gone, &[&tool], BoolKind::Cut).expect("cut"));
    assert!(lost < 1e-3, "lost {lost} mm3 outside what the offset removed");
    let gone = kernel::volume(&gone);
    assert!((gone - removed).abs() < 1e-3 * removed, "removed {gone}, the slab holds {removed}");

    let said = reasons(&r, "push");
    assert!(
        said.iter().any(|m| m == "the cut split Body1 into 2 pieces"),
        "{said:?}"
    );
    assert!(
        said.iter().any(|m| m == "the offset broke through the outside of Body1"),
        "{said:?}"
    );
}

/// The control: a push that stays inside the spike neither splits nor breaks out.
#[test]
fn a_press_pull_that_stays_inside_says_nothing() {
    let mut raw = spike(true);
    raw["features"][8]["distance"] = json!(-1.0);
    let r = build(&raw);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Solid), 1);
    assert!(reasons(&r, "push").is_empty(), "{:?}", reasons(&r, "push"));
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
