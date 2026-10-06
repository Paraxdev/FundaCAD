//! A `match` edge reference never refuses, so one whose edge was deleted used
//! to settle on whatever edge was left and blend that. Two cases can be told
//! from an edge that merely moved: the best match is another kind of curve far
//! from the pick, or several references share one edge none was picked near.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn volume(r: &Rebuild) -> f64 {
    kernel::volume_precise(&r.bodies[0].shape).abs()
}

fn reasons(r: &Rebuild) -> Vec<String> {
    r.diagnostics.iter().filter_map(|d| d["reason"].as_str().map(str::to_owned)).collect()
}

/// The plate's bottom edge along X on its front side.
fn front_edge(len: f64, y: f64, z: f64) -> Value {
    json!({"kind": "edge", "by": "match", "body": "body1",
           "fp": {"mid": [0, y, z], "dir": [1, 0, 0], "length": len, "curve": "line"}})
}

/// The rim of a pocket that is no longer cut.
fn pocket_rim(x: f64, y: f64, z: f64) -> Value {
    json!({"kind": "edge", "by": "match", "body": "body1",
           "fp": {"mid": [x + 3.0, y, z], "dir": [0, 1, 0], "length": 6.0 * PI, "curve": "circle",
                  "radius": 3, "center": [x, y, z]}})
}

#[test]
fn a_rim_whose_best_match_is_a_straight_edge_far_away_is_gone() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "plate", "type": "box", "length": 40, "width": 40, "height": 10},
        {"id": "edge", "type": "chamfer", "distance": 1,
         "edges": [front_edge(40.0, -20.0, -5.0), pocket_rim(10.0, 10.0, -5.0)]},
    ]});
    let r = build(&doc);
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let want = 40.0 * 40.0 * 10.0 - 0.5 * 40.0;
    assert!((volume(&r) - want).abs() < 0.05, "volume {} is not one chamfered edge, {want}", volume(&r));
    assert!(reasons(&r).iter().any(|s| s == "the edge this was picked on is gone"), "{:?}", r.diagnostics);
}

#[test]
fn a_feature_whose_only_edge_is_gone_says_no_edge_was_found() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "plate", "type": "box", "length": 40, "width": 40, "height": 10},
        {"id": "edge", "type": "chamfer", "distance": 1, "edges": [pocket_rim(10.0, 10.0, -5.0)]},
    ]});
    let r = build(&doc);
    let said: Vec<&str> = r.errors.iter().map(|e| e.message.as_str()).collect();
    assert_eq!(said, ["no edge found to chamfer on Box"]);
}

#[test]
fn two_rims_that_settle_on_one_circle_neither_was_picked_near_are_gone() {
    let doc = json!({"parameters": {}, "bodyIds": {"plate:0": "body1"}, "features": [
        {"id": "plate", "type": "box", "length": 60, "width": 60, "height": 10},
        {"id": "post", "type": "cylinder", "radius": 4, "height": 20, "operation": "join", "targets": ["body1"]},
        {"id": "edge", "type": "chamfer", "distance": 0.5,
         "edges": [front_edge(60.0, -30.0, -5.0), pocket_rim(20.0, 20.0, -5.0), pocket_rim(-20.0, 20.0, -5.0)]},
    ]});
    let r = build(&doc);
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let want = 60.0 * 60.0 * 10.0 + PI * 16.0 * 10.0 - 0.5 * 0.25 * 60.0;
    assert!((volume(&r) - want).abs() < 0.5, "volume {} is not one chamfered edge, {want}", volume(&r));
    assert!(
        reasons(&r).iter().any(|s| s.starts_with("2 references share one edge")),
        "{:?}",
        r.diagnostics
    );
}

#[test]
fn a_rim_picked_on_the_circle_it_resolves_to_is_kept() {
    // The control: one reference, on its own circle, a little off where it was picked.
    let doc = json!({"parameters": {}, "bodyIds": {"plate:0": "body1"}, "features": [
        {"id": "plate", "type": "box", "length": 60, "width": 60, "height": 10},
        {"id": "post", "type": "cylinder", "radius": 4, "height": 20, "operation": "join", "targets": ["body1"]},
        {"id": "edge", "type": "chamfer", "distance": 0.5,
         "edges": [{"kind": "edge", "by": "match", "body": "body1",
                    "fp": {"mid": [4.3, 0, 10.2], "dir": [0, 1, 0], "length": 8.0 * PI, "curve": "circle",
                           "radius": 4.1, "center": [0.3, 0, 10.2]}}]},
    ]});
    let r = build(&doc);
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let plain = 60.0 * 60.0 * 10.0 + PI * 16.0 * 10.0;
    assert!(volume(&r) < plain - 1.0, "the post's top rim was not chamfered: {}", volume(&r));
    assert!(!reasons(&r).iter().any(|s| s.contains("gone")), "{:?}", r.diagnostics);
}
