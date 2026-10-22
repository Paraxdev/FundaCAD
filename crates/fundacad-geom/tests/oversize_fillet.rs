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
    r.diagnostics.iter().filter(|d| d["feature_id"] == json!(feature)).filter_map(|d| d["message"].as_str()).collect()
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

fn prism_fillet(corners: &[(f64, f64)], height: f64, radius: f64, near: &[[f64; 3]]) -> Rebuild {
    let n = corners.len();
    let lines: Vec<Value> = (0..n)
        .map(|i| {
            let (a, b) = (corners[i], corners[(i + 1) % n]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1})
        })
        .collect();
    let edges: Vec<Value> =
        near.iter().map(|p| json!({"kind": "edge", "by": "nearest", "point": p, "body": "body1"})).collect();
    build(&json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": "XY", "entities": lines},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": height, "operation": "new"},
        {"id": "f", "type": "fillet", "radius": radius, "edges": edges},
    ]}))
}

struct Closing {
    corners: &'static [(f64, f64)],
    height: f64,
    near: [[f64; 3]; 2],
    crossing: &'static [f64],
    limit: f64,
    apart: f64,
    apart_volume: f64,
}

/// The limit is where one round's end contact enters the other's tool (5 sqrt5 / 2 on the trapezoid), the
/// volumes are the prism less two r^2 (1 - pi/4) sections swept between caps square to their edges.
#[test]
fn rounds_that_cross_near_an_end_are_refused_with_the_size_that_keeps_them_apart() {
    let cases = [
        Closing {
            corners: &[(-20.0, 0.0), (20.0, 0.0), (5.0, 30.0), (-5.0, 30.0)],
            height: 20.0,
            near: [[12.5, 15.0, 20.0], [-12.5, 15.0, 20.0]],
            crossing: &[5.6, 10.0],
            limit: 5.590,
            apart: 5.5,
            apart_volume: 14572.50,
        },
        Closing {
            corners: &[(-7.0, 6.0), (35.0, 6.0), (22.0, 38.0), (14.0, 38.0)],
            height: 17.0,
            near: [[28.5, 22.0, 17.0], [3.5, 22.0, 17.0]],
            crossing: &[4.73, 6.0, 13.4],
            limit: 4.7267,
            apart: 4.0,
            apart_volume: 13353.24,
        },
        Closing {
            corners: &[(-11.0, -10.0), (27.0, -10.0), (29.0, -8.0), (29.0, 20.0), (-11.0, 20.0)],
            height: 13.0,
            near: [[8.0, -10.0, 13.0], [29.0, 6.0, 13.0]],
            crossing: &[2.05, 3.0],
            limit: 2.0,
            apart: 1.5,
            apart_volume: 15542.13,
        },
    ];
    for c in &cases {
        let at = |radius: f64| prism_fillet(c.corners, c.height, radius, &c.near);
        for &radius in c.crossing {
            let r = at(radius);
            let said = messages(&r);
            assert_eq!(said.len(), 1, "{:?} r {radius}: built volume {} without a word", c.near, volume(&r));
            assert_eq!(r.errors[0].code.as_deref(), Some("blendTooLarge"), "r {radius}: {said:?}");
            assert!(said[0].contains("neighbouring edge"), "{:?} r {radius}: {said:?}", c.near);
            let fits = offered(said[0]).unwrap_or_else(|| panic!("r {radius}: no size offered: {said:?}"));
            assert!(fits <= c.limit + 1e-9 && fits > c.limit - 0.011, "{:?} r {radius}: offers {fits}", c.near);
            let offer = at(fits);
            assert!(offer.errors.is_empty(), "{:?} the offered {fits} does not build: {:?}", c.near, messages(&offer));
        }
        let r = at(c.apart);
        assert!(r.errors.is_empty(), "{:?} r {}: {:?}", c.near, c.apart, messages(&r));
        assert!((volume(&r) - c.apart_volume).abs() < 0.05, "{:?} r {}: volume {}", c.near, c.apart, volume(&r));
        for p in c.near {
            let lone = prism_fillet(c.corners, c.height, c.crossing[1], &[p]);
            assert!(lone.errors.is_empty(), "the lone round at {p:?} has no neighbour to cross: {:?}", messages(&lone));
        }
    }
}
