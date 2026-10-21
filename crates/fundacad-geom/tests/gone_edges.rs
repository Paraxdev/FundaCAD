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

/// The box's front right Z edge, where a 60 x 40 x 20 box has it.
fn right_z_edge() -> Value {
    json!({"kind": "edge", "by": "match", "body": "body1",
           "fp": {"mid": [30, 20, 0], "dir": [0, 0, 1], "length": 20, "curve": "line"}})
}

fn stale(r: &Rebuild, feature: &str) -> Option<Value> {
    r.diagnostics.iter().find(|d| d["feature_id"] == json!(feature) && d["stale"] == json!(true)).cloned()
}

#[test]
fn a_match_left_tied_between_edges_away_from_its_pick_says_where_it_now_lands() {
    // A chamfer upstream took the fillet's edge, its two border lines tie 5 mm off.
    let doc = json!({"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 60, "width": 40, "height": 20},
        {"id": "ch", "type": "chamfer", "distance": 5, "edges": right_z_edge()},
        {"id": "f", "type": "fillet", "radius": 3, "edges": right_z_edge()},
    ]});
    let r = build(&doc);
    let d = stale(&r, "f").unwrap_or_else(|| panic!("no stale note for f: {:?}", r.diagnostics));
    let now: Vec<f64> = d["now"]["mid"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let near = |x: f64, y: f64| (now[0] - x).abs() < 0.01 && (now[1] - y).abs() < 0.01 && now[2].abs() < 0.01;
    assert!(near(25.0, 20.0) || near(30.0, 15.0), "{d}");
    assert!((d["off"].as_f64().unwrap() - 5.0).abs() < 0.01, "{d}");
    assert_eq!(d["now"]["curve"], json!("line"), "{d}");
}

#[test]
fn a_match_picked_where_no_edge_is_says_which_edge_it_took() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 60, "width": 40, "height": 20},
        {"id": "f", "type": "fillet", "radius": 2, "edges":
            {"kind": "edge", "by": "match", "body": "body1", "fp": {"mid": [1, 2, 3], "dir": [0, 0, 1]}}},
    ]});
    let r = build(&doc);
    let d = stale(&r, "f").unwrap_or_else(|| panic!("no stale note for f: {:?}", r.diagnostics));
    assert!(d["off"].as_f64().unwrap() > 30.0, "{d}");
}

#[test]
fn a_match_whose_edge_only_drifted_with_a_parameter_stays_quiet() {
    for length in [59.0, 61.0] {
        let doc = json!({"parameters": {}, "features": [
            {"id": "bx", "type": "box", "length": length, "width": 40, "height": 20},
            {"id": "f", "type": "fillet", "radius": 3, "edges": right_z_edge()},
        ]});
        let r = build(&doc);
        assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
        assert!(stale(&r, "f").is_none(), "length {length}: {:?}", r.diagnostics);
        let want = length * 40.0 * 20.0 - 20.0 * 9.0 * (1.0 - PI / 4.0);
        assert!((volume(&r) - want).abs() < 0.05, "length {length}: volume {} is not one filleted edge", volume(&r));
    }
}
