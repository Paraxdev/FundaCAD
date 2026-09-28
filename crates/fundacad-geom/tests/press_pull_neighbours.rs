//! Press/pull on a flat face carries the faces around it along, the way an
//! offset face does: each neighbour is extended along its own surface to meet
//! the moved face, so a sloped side keeps its slope rather than a straight wall
//! rising off the old edge.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn outline(pts: &[[f64; 2]]) -> Vec<Value> {
    (0..pts.len())
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        })
        .collect()
}

/// The outline on XZ pushed 10 mm either side of Y = 0.
fn block(pts: &[[f64; 2]]) -> Vec<Value> {
    vec![
        json!({"id": "sk", "type": "sketch", "plane": "XZ", "entities": outline(pts)}),
        json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "symmetric": true, "operation": "new"}),
    ]
}

fn push(mut features: Vec<Value>, at: [f64; 3], distance: f64) -> Value {
    features.push(json!({"id": "push", "type": "press-pull",
        "face": {"kind": "face", "by": "nearest", "point": at},
        "distance": distance, "operation": if distance > 0.0 { "join" } else { "cut" }, "body": "body1"}));
    json!({"parameters": {}, "features": features})
}

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn volume_after(raw: &Value) -> f64 {
    let r = build(raw);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let shape = &r.bodies[0].shape;
    assert!(shape.is_valid().unwrap_or(false), "the pushed body is valid");
    kernel::volume(shape)
}

/// 40 wide at the floor, 20 across the top, 10 high: 45 degree sides that
/// would meet 20 up.
const TRAPEZOID: [[f64; 2]; 4] = [[-20.0, 0.0], [20.0, 0.0], [10.0, 10.0], [-10.0, 10.0]];

#[test]
fn pulling_the_top_of_a_sloped_block_carries_the_slopes_up() {
    // Top 10 wide at 15 high. A straight wall would hold 8000.
    let v = volume_after(&push(block(&TRAPEZOID), [0.0, 0.0, 10.0], 5.0));
    assert!((v - 7500.0).abs() < 1e-3, "{v}");
}

#[test]
fn pushing_the_top_of_a_sloped_block_in_follows_the_slopes_down() {
    // Top 30 wide at 5 high. A straight cut would leave 4000.
    let v = volume_after(&push(block(&TRAPEZOID), [0.0, 0.0, 10.0], -5.0));
    assert!((v - 3500.0).abs() < 1e-3, "{v}");
}

/// Past where the slopes meet the top is gone and they close in a ridge 20
/// up, and pulling further changes nothing.
#[test]
fn pulling_past_where_the_slopes_meet_closes_them_in_a_ridge() {
    for d in [12.0, 30.0] {
        let raw = push(block(&TRAPEZOID), [0.0, 0.0, 10.0], d);
        let v = volume_after(&raw);
        assert!((v - 40.0 * 20.0 / 2.0 * 20.0).abs() < 1e-3, "{d}: {v}");
        let top = kernel::bbox(&build(&raw).bodies[0].shape).expect("a box")[5];
        assert!((top - 20.0).abs() < 1e-6, "{d}: {top}");
    }
}

/// A top rounded into a side has no slope to carry on there, so it sinks
/// inside the round as a straight recess.
#[test]
fn a_top_rounded_into_a_side_sinks_straight() {
    let mut features = block(&[[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]]);
    features.push(json!({"id": "round", "type": "fillet", "radius": 2,
        "edges": [{"kind": "edge", "by": "nearest", "point": [20.0, 0.0, 10.0]}]}));
    let before = volume_after(&json!({"parameters": {}, "features": features.clone()}));
    let v = volume_after(&push(features, [10.0, 0.0, 10.0], -3.0));
    // The flat top is 18 by 20 beside the 2 mm round.
    assert!((before - v - 18.0 * 20.0 * 3.0).abs() < 1e-3, "{before} to {v}");
}

#[test]
fn a_square_block_still_pulls_straight() {
    let square = [[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]];
    let v = volume_after(&push(block(&square), [10.0, 0.0, 10.0], 5.0));
    assert!((v - 6000.0).abs() < 1e-3, "{v}");
}

#[test]
fn the_top_of_a_cone_frustum_narrows_as_it_rises() {
    let features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XZ",
               "entities": outline(&[[0.0, 0.0], [20.0, 0.0], [10.0, 10.0], [0.0, 10.0]])}),
        json!({"id": "cone", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"}),
    ];
    // The cone carries on to radius 5 at 15 high.
    let v = volume_after(&push(features, [5.0, 0.0, 10.0], 5.0));
    let want = PI * 15.0 / 3.0 * (400.0 + 100.0 + 25.0);
    assert!((v - want).abs() < 1e-2, "{v} against {want}");
}

/// The low step pulled up past the high one runs its face into the riser.
/// There is nothing to carry along past that point, so it extrudes and merges.
#[test]
fn a_step_pulled_past_its_neighbour_merges() {
    let step = [[0.0, 0.0], [40.0, 0.0], [40.0, 10.0], [20.0, 10.0], [20.0, 20.0], [0.0, 20.0]];
    let v = volume_after(&push(block(&step), [30.0, 0.0, 10.0], 15.0));
    assert!((v - (20.0 * 20.0 + 20.0 * 25.0) * 20.0).abs() < 1e-3, "{v}");
}

/// A notch floor pulled up out through the top fills the notch and carries on
/// between its walls, now sloping out above the block.
#[test]
fn a_notch_floor_pulled_out_through_the_top_fills_it_and_rises_between_its_walls() {
    // 4 wide at the floor, 10 at the top, so 13 at 5 above it.
    let notch = [
        [0.0, 0.0], [40.0, 0.0], [40.0, 20.0], [25.0, 20.0], [22.0, 10.0], [18.0, 10.0], [15.0, 20.0], [0.0, 20.0],
    ];
    let raw = push(block(&notch), [20.0, 0.0, 10.0], 15.0);
    let v = volume_after(&raw);
    let above = (10.0 + 13.0) / 2.0 * 5.0;
    assert!((v - (40.0 * 20.0 + above) * 20.0).abs() < 1e-3, "{v}");
    assert_eq!(kernel::count(&build(&raw).bodies[0].shape, kernel::Kind::Solid), 1);
}
