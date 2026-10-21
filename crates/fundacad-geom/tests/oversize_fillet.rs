//! A fillet too large for its edge's neighbours used to build anyway: on the
//! four Z edges of a 60 x 40 x 20 box, r = 21 carved both 40 mm end faces into
//! pointed arches (59.95 long, volume 40429.5) and r = 50 left a 40 x 31.65
//! lens, each round cutting away the line its neighbour rests on.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn box_fillet(radius: f64, edges: Value) -> Rebuild {
    build(&json!({"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 60, "width": 40, "height": 20},
        {"id": "f", "type": "fillet", "radius": radius, "edges": edges},
    ]}))
}

fn z_edges() -> Value {
    json!({"kind": "edge", "by": "axis", "axis": "Z", "body": "body1"})
}

fn volume(r: &Rebuild) -> f64 {
    kernel::volume_precise(&r.bodies[0].shape).abs()
}

fn messages(r: &Rebuild) -> Vec<&str> {
    r.errors.iter().map(|e| e.message.as_str()).collect()
}

/// The size a refusal offers, from its "It fits up to Xmm".
fn offered(message: &str) -> Option<f64> {
    let rest = message.split("fits up to ").nth(1)?;
    rest.split("mm").next()?.parse().ok()
}

#[test]
fn rounds_that_would_carve_away_each_others_faces_are_refused_with_the_size_that_fits() {
    for radius in [21.0, 50.0] {
        let r = box_fillet(radius, z_edges());
        let said = messages(&r);
        assert_eq!(said.len(), 1, "r {radius}: built volume {} without a word", volume(&r));
        assert_eq!(r.errors[0].code.as_deref(), Some("blendTooLarge"), "r {radius}: {said:?}");
        assert!(said[0].contains("neighbouring edge"), "r {radius}: {said:?}");
        let fits = offered(said[0]).unwrap_or_else(|| panic!("r {radius}: no size offered: {said:?}"));
        assert!((19.9..=20.1).contains(&fits), "r {radius}: offers {fits}");
        let at = box_fillet(fits, z_edges());
        assert!(at.errors.is_empty(), "the offered {fits} does not build: {:?}", messages(&at));
    }
}

#[test]
fn rounds_that_fit_or_meet_exactly_still_build() {
    for (radius, want) in [(19.0, 41802.3), (20.0, 48000.0 - 4.0 * 20.0 * (400.0 - 100.0 * PI))] {
        let r = box_fillet(radius, z_edges());
        assert!(r.errors.is_empty(), "r {radius}: {:?}", messages(&r));
        assert!((volume(&r) - want).abs() < 0.5, "r {radius}: volume {} not {want}", volume(&r));
    }
    let one = json!({"kind": "edge", "by": "nearest", "point": [30, 20, 0], "body": "body1"});
    let r = box_fillet(25.0, one);
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    let want = 48000.0 - 20.0 * 625.0 * (1.0 - PI / 4.0);
    assert!((volume(&r) - want).abs() < 0.5, "a lone round {} not {want}", volume(&r));
}

/// The top and bottom chamfers of one 20 mm high side, 11 + 11 > 20.
#[test]
fn chamfers_that_cross_on_a_side_face_are_refused() {
    let r = build(&json!({"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": 60, "width": 40, "height": 20},
        {"id": "c", "type": "chamfer", "distance": 11, "edges": {"kind": "edge", "by": "all", "body": "body1"}},
    ]}));
    let said = messages(&r);
    assert_eq!(said.len(), 1, "built volume {} without a word", volume(&r));
    assert!(said[0].contains("chamfer on the neighbouring edge"), "{said:?}");
}

fn cube_fillet(side: f64, radius: f64) -> Rebuild {
    build(&json!({"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": side, "width": side, "height": side},
        {"id": "f", "type": "fillet", "radius": radius, "edges": {"kind": "edge", "by": "all", "body": "body1"}},
    ]}))
}

/// Rounds on opposite edges of a face meet tangent to it, so one that reaches
/// a hair past the other's contact sat inside its tool by only d^2 / 2r and
/// built: a 30 cube at r = 15.005 came out 15787 mm^3 with open seams, where
/// r = 15 is the 14137 mm^3 ball, and r = 16 was offered 15.01, inside that window.
#[test]
fn rounds_a_hair_past_meeting_are_refused_and_the_offered_size_builds_the_ball() {
    for (side, radius) in [(30.0, 15.005), (30.0, 15.02), (20.0, 10.01)] {
        let r = cube_fillet(side, radius);
        let said = messages(&r);
        assert_eq!(said.len(), 1, "cube {side} r {radius}: built volume {} without a word", volume(&r));
        assert!(said[0].contains("neighbouring edge"), "cube {side} r {radius}: {said:?}");
        let fits = offered(said[0]).unwrap_or_else(|| panic!("cube {side} r {radius}: no size offered: {said:?}"));
        let half = side / 2.0;
        assert!(fits <= half && fits > half - 0.1, "cube {side} r {radius}: offers {fits}");
        let at = cube_fillet(side, fits);
        assert!(at.errors.is_empty(), "the offered {fits} does not build: {:?}", messages(&at));
        let ball = 4.0 / 3.0 * PI * half.powi(3);
        assert!(volume(&at) >= ball - 1.0, "the offered {fits} built {} below the ball {ball}", volume(&at));
    }
}

fn warnings<'a>(r: &'a Rebuild, feature: &str) -> Vec<&'a str> {
    r.diagnostics
        .iter()
        .filter(|d| d["feature_id"] == json!(feature))
        .filter_map(|d| d["message"].as_str())
        .collect()
}

/// A lone round past the 40 mm face is no fillet: r = 100 on one Z edge left
/// 14904 of the 48000 mm^3 box, the edge's 40 mm face gone, without a word.
#[test]
fn a_lone_round_larger_than_its_face_builds_with_a_warning_and_the_size_that_rounds() {
    let one = json!({"kind": "edge", "by": "nearest", "point": [30, 20, 0], "body": "body1"});
    for radius in [45.0, 100.0] {
        let r = box_fillet(radius, one.clone());
        assert!(r.errors.is_empty(), "r {radius}: {:?}", messages(&r));
        let said = warnings(&r, "f");
        assert_eq!(said.len(), 1, "r {radius}: volume {} and no warning: {:?}", volume(&r), r.diagnostics);
        assert!(said[0].contains("runs past"), "r {radius}: {said:?}");
        let fits = offered(said[0]).unwrap_or_else(|| panic!("r {radius}: no size offered: {said:?}"));
        assert!((39.9..=40.0).contains(&fits), "r {radius}: offers {fits}");
    }
    let r = box_fillet(25.0, one);
    assert!(warnings(&r, "f").is_empty(), "a round that fits warned: {:?}", r.diagnostics);
}

fn box_two_distance(sides: [f64; 2], d: f64, d2: f64, extra: Value) -> Rebuild {
    let mut chamfer = json!({"id": "c", "type": "chamfer", "chamferType": "twoDistance", "distance": d, "distance2": d2, "edges": z_edges()});
    chamfer.as_object_mut().expect("an object").extend(extra.as_object().cloned().unwrap_or_default());
    build(&json!({"parameters": {}, "features": [
        {"id": "bx", "type": "box", "length": sides[0], "width": sides[1], "height": 10},
        chamfer,
    ]}))
}

/// Each corner cuts a d x d2 / 2 x 10 prism, and every side face stays.
fn check_corners_cut(sides: [f64; 2], d: f64, d2: f64, extra: Value) {
    let case = format!("{} x {}, {d}/{d2} {extra}", sides[0], sides[1]);
    let r = box_two_distance(sides, d, d2, extra);
    assert!(r.errors.is_empty(), "{case}: {:?}", messages(&r));
    let want = sides[0] * sides[1] * 10.0 - 4.0 * d * d2 / 2.0 * 10.0;
    assert!((volume(&r) - want).abs() < 0.01, "{case}: volume {} != {want}", volume(&r));
    let bb = kernel::bbox(&r.bodies[0].shape).expect("a bbox");
    let half = [sides[0] / 2.0, sides[1] / 2.0, 5.0];
    for (k, v) in bb.iter().enumerate() {
        assert!((v.abs() - half[k % 3]).abs() < 1e-3, "{case}: bbox {bb:?}");
    }
}

/// 3 + 12 fits each 20 mm side only with the 12 at one corner and the 3 at the
/// other: 4000 - 4 x 180 = 3280.
#[test]
fn a_two_distance_chamfer_that_fits_with_alternating_sides_builds() {
    for (d, d2) in [(3.0, 12.0), (12.0, 3.0), (3.0, 16.0)] {
        check_corners_cut([20.0, 20.0], d, d2, json!({}));
    }
}

/// On a 30 x 10 box the 12 fits only on both 30 mm sides, whichever distance it
/// is given as. tangentEdges false goes straight to the section build.
#[test]
fn a_two_distance_chamfer_takes_the_faces_it_fits_on_in_either_order() {
    for extra in [json!({}), json!({"tangentEdges": false})] {
        check_corners_cut([30.0, 10.0], 3.0, 12.0, extra.clone());
        check_corners_cut([30.0, 10.0], 12.0, 3.0, extra.clone());
    }
    check_corners_cut([20.0, 20.0], 3.0, 12.0, json!({"tangentEdges": false}));
}
