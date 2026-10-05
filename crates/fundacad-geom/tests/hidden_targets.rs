//! A join, cut or intersect acts on the bodies it names whether or not their
//! eye is shut, and only one that names none leaves hidden bodies alone.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

const BLOCK: f64 = 20.0 * 20.0 * 20.0;
const CUBE: f64 = 8.0 * 8.0 * 8.0;

/// A 20 mm block as body1 with its eye shut and an 8 mm cube as body2 inside
/// it, then `tail`.
fn hidden_block_then(tail: Value) -> Value {
    let mut features = vec![
        json!({"id": "block", "type": "box", "length": 20, "width": 20, "height": 20}),
        json!({"id": "cube", "type": "box", "length": 8, "width": 8, "height": 8}),
    ];
    features.extend(tail.as_array().expect("a feature list").iter().cloned());
    json!({"parameters": {}, "bodyVisibility": {"body1": false}, "bodyIds": {"block:0": "body1", "cube:0": "body2"},
           "features": features})
}

fn ring(id: &str, z: f64) -> Value {
    json!({"id": id, "type": "sketch", "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
           "entities": [{"type": "circle", "radius": 3, "x": 0, "y": 0}]})
}

/// A 3 mm pin through the block from top to bottom, as a loft.
fn loft_cut(targets: Value) -> Value {
    json!([
        ring("low", -15.0),
        ring("high", 15.0),
        {"id": "pin", "type": "loft", "sketches": ["low", "high"], "operation": "cut", "targets": targets},
    ])
}

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn volume(r: &Rebuild, id: &str) -> f64 {
    let b = r.bodies.iter().find(|b| b.id == id).unwrap_or_else(|| panic!("no {id} in the build"));
    kernel::volume_precise(&b.shape).abs()
}

fn messages(r: &Rebuild) -> Vec<&str> {
    r.errors.iter().map(|e| e.message.as_str()).collect()
}

#[test]
fn a_loft_cut_reaches_the_hidden_body_it_names_and_no_other() {
    let r = build(&hidden_block_then(loft_cut(json!(["body1"]))));
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    let want = BLOCK - PI * 9.0 * 20.0;
    assert!((volume(&r, "body1") - want).abs() < 1.0, "body1 is {}, not {want}", volume(&r, "body1"));
    assert!((volume(&r, "body2") - CUBE).abs() < 1e-6, "the shown cube was cut too: {}", volume(&r, "body2"));
}

#[test]
fn a_revolve_cut_reaches_the_hidden_body_it_names() {
    let r = build(&hidden_block_then(json!([
        {"id": "sk", "type": "sketch", "plane": "XZ", "entities": [{"type": "circle", "radius": 2, "x": 6, "y": 0}]},
        {"id": "groove", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "cut", "targets": ["body1"]},
    ])));
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    let want = BLOCK - 2.0 * PI * PI * 6.0 * 4.0;
    assert!((volume(&r, "body1") - want).abs() < 1.0, "body1 is {}, not {want}", volume(&r, "body1"));
    assert!((volume(&r, "body2") - CUBE).abs() < 1e-6, "the shown cube was cut too: {}", volume(&r, "body2"));
}

#[test]
fn a_join_merges_into_the_hidden_body_it_names() {
    let post = |targets: Value| {
        hidden_block_then(json!([
            {"id": "post", "type": "box", "length": 4, "width": 4, "height": 40, "operation": "join", "targets": targets},
        ]))
    };
    let r = build(&post(json!(["body1"])));
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    assert_eq!(r.bodies.len(), 2, "the post became a body of its own");
    let want = BLOCK + 4.0 * 4.0 * 20.0;
    assert!((volume(&r, "body1") - want).abs() < 1e-3, "body1 is {}, not {want}", volume(&r, "body1"));
    assert!((volume(&r, "body2") - CUBE).abs() < 1e-6, "the shown cube was joined too: {}", volume(&r, "body2"));

    let r = build(&post(Value::Null));
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    assert_eq!(r.bodies.len(), 2);
    assert!((volume(&r, "body1") - BLOCK).abs() < 1e-6, "an unnamed join reached the hidden block");
    assert!(volume(&r, "body2") > CUBE + 1.0, "an unnamed join skipped the shown cube");
}

#[test]
fn an_intersect_trims_the_hidden_body_it_names() {
    let r = build(&hidden_block_then(json!([
        {"id": "keep", "type": "box", "length": 10, "width": 10, "height": 40, "operation": "intersect", "targets": ["body1"]},
    ])));
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    let want = 10.0 * 10.0 * 20.0;
    assert!((volume(&r, "body1") - want).abs() < 1e-3, "body1 is {}, not {want}", volume(&r, "body1"));
    assert!((volume(&r, "body2") - CUBE).abs() < 1e-6);
}

#[test]
fn a_cut_that_names_no_target_refuses_when_all_it_reaches_is_hidden() {
    let mut raw = hidden_block_then(loft_cut(Value::Null));
    raw["bodyVisibility"] = json!({"body1": false, "body2": false});
    let r = build(&raw);
    assert_eq!(
        messages(&r),
        ["Cut removed nothing, the only bodies it reaches are hidden. Show one, or name it as the target."]
    );
    assert!((volume(&r, "body1") - BLOCK).abs() < 1e-6 && (volume(&r, "body2") - CUBE).abs() < 1e-6);

    raw["features"].as_array_mut().expect("features").remove(1);
    let r = build(&raw);
    assert_eq!(
        messages(&r),
        ["Cut removed nothing, the only body it reaches is hidden. Show it, or name it as the target."]
    );
    assert!((volume(&r, "body1") - BLOCK).abs() < 1e-6);
}

/// A ring about Z whose bounding box holds a 2 mm box at the origin that the
/// ring itself never touches.
fn ring_cut_around(mut bodies: Vec<Value>, vis: Value) -> Value {
    bodies.push(json!({"id": "sk", "type": "sketch", "plane": "XZ", "entities": [{"type": "circle", "radius": 2, "x": 6, "y": 0}]}));
    bodies.push(json!({"id": "groove", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "cut"}));
    json!({"parameters": {}, "bodyVisibility": vis, "features": bodies})
}

#[test]
fn a_shown_body_the_cut_only_boxes_in_does_not_hide_that_the_one_it_reaches_is_hidden() {
    let block = json!({"id": "block", "type": "box", "length": 20, "width": 20, "height": 20});
    let speck = json!({"id": "speck", "type": "box", "length": 2, "width": 2, "height": 2});
    let r = build(&ring_cut_around(vec![block, speck.clone()], json!({"body1": false})));
    assert_eq!(
        messages(&r),
        ["Cut removed nothing, the only body it reaches is hidden. Show it, or name it as the target."]
    );
    assert!((volume(&r, "body1") - BLOCK).abs() < 1e-6 && (volume(&r, "body2") - 8.0).abs() < 1e-6);

    // The same holds the other way round: a hidden body that is only boxed in is not reached.
    let r = build(&ring_cut_around(vec![speck], json!({"body1": false})));
    assert_eq!(
        messages(&r),
        ["Cut removed nothing, the shape doesn't reach any body. Move it into one, or use Join."]
    );
}

#[test]
fn an_extrude_cut_into_a_body_it_recorded_as_hidden_says_so_past_a_shown_near_miss() {
    // The hole sits in a corner of the cylinder's bounding box, outside the cylinder.
    let doc = |hidden: Value| {
        json!({"parameters": {}, "features": [
            {"id": "block", "type": "box", "length": 20, "width": 20, "height": 20},
            {"id": "rod", "type": "cylinder", "radius": 5, "height": 10},
            {"id": "sk", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "radius": 0.4, "x": 4.5, "y": 4.5}]},
            {"id": "hole", "type": "extrude", "sketch": "sk", "distance": 3, "operation": "cut", "hiddenBodies": hidden},
        ]})
    };
    let r = build(&doc(json!(["body1"])));
    assert_eq!(
        messages(&r),
        ["Cut removed nothing, the only body it reaches was hidden when the extrude was made. Drag the other way, or make the extrude again with the body shown."]
    );
    let r = build(&doc(json!([])));
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    assert!(volume(&r, "body1") < BLOCK - 1.0, "the hole missed the block: {}", volume(&r, "body1"));
}

#[test]
fn a_cut_that_names_no_target_still_cuts_the_shown_body_beside_a_hidden_one() {
    let r = build(&hidden_block_then(loft_cut(Value::Null)));
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    assert!((volume(&r, "body1") - BLOCK).abs() < 1e-6, "an unnamed cut reached the hidden block");
    let want = CUBE - PI * 9.0 * 8.0;
    assert!((volume(&r, "body2") - want).abs() < 1.0, "body2 is {}, not {want}", volume(&r, "body2"));
}

#[test]
fn a_cut_that_misses_only_calls_itself_an_extrude_when_it_is_one() {
    let far = |z: f64| ring(if z < 100.0 { "low" } else { "high" }, z);
    let loft = json!({"parameters": {}, "features": [
        {"id": "block", "type": "box", "length": 20, "width": 20, "height": 20},
        far(90.0),
        far(120.0),
        {"id": "pin", "type": "loft", "sketches": ["low", "high"], "operation": "cut"},
    ]});
    assert_eq!(
        messages(&build(&loft)),
        ["Cut removed nothing, the shape doesn't reach any body. Move it into one, or use Join."]
    );
    let extrude = json!({"parameters": {}, "features": [
        {"id": "block", "type": "box", "length": 20, "width": 20, "height": 20},
        far(90.0),
        {"id": "pin", "type": "extrude", "sketch": "low", "distance": 5, "operation": "cut"},
    ]});
    assert_eq!(
        messages(&build(&extrude)),
        ["Cut removed nothing, the extrude doesn't reach any body. Drag the other way, or use Join."]
    );
}
