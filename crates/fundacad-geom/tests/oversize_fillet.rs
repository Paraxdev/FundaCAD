//! A fillet too large for its edge's neighbours is refused. Unchecked, on the four Z edges of a 60 x 40 x 20 box,
//! r = 21 carves the 40 mm end faces into pointed arches (volume 40429.5) and r = 50 leaves a 40 x 31.65 lens.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
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

/// Rounds on opposite edges meet tangent, so one a hair past the other's contact sits in its tool by only d^2 / 2r:
/// a 30 cube at r = 15.005 built 15787 mm^3 with open seams (r = 15 is the 14137 mm^3 ball), so offers skip it.
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

fn prism_with(corners: &[(f64, f64)], height: f64, blends: Vec<Value>) -> Rebuild {
    let n = corners.len();
    let lines: Vec<Value> = (0..n)
        .map(|i| {
            let (a, b) = (corners[i], corners[(i + 1) % n]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1})
        })
        .collect();
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XY", "entities": lines}),
        json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": height, "operation": "new"}),
    ];
    features.extend(blends);
    build(&json!({"parameters": {}, "features": features}))
}

fn two_distance(id: &str, d: f64, d2: f64, edges: Value, extra: Value) -> Value {
    let mut chamfer = json!({"id": id, "type": "chamfer", "chamferType": "twoDistance", "edges": edges,
        "distance": d, "distance2": d2});
    chamfer.as_object_mut().expect("an object").extend(extra.as_object().cloned().unwrap_or_default());
    chamfer
}

fn prism_chamfer(corners: &[(f64, f64)], height: f64, d: f64, d2: f64, edges: Value, extra: Value) -> Rebuild {
    prism_with(corners, height, vec![two_distance("c", d, d2, edges, extra)])
}

fn rect(x: f64, y: f64, l: f64, w: f64) -> [(f64, f64); 4] {
    [(x, y), (x + l, y), (x + l, y + w), (x, y + w)]
}

/// A convex prism less a d x d2 triangle at every corner, whichever wall takes d.
fn clean_cut(corners: &[(f64, f64)], height: f64, d: f64, d2: f64) -> f64 {
    let n = corners.len();
    let (mut area, mut cut) = (0.0, 0.0);
    for i in 0..n {
        let (p, a, b) = (corners[(i + n - 1) % n], corners[i], corners[(i + 1) % n]);
        area += a.0 * b.1 - b.0 * a.1;
        let (u, v) = ((p.0 - a.0, p.1 - a.1), (b.0 - a.0, b.1 - a.1));
        cut += d * d2 / 2.0 * (u.0 * v.1 - u.1 * v.0).abs() / (u.0.hypot(u.1) * v.0.hypot(v.1));
    }
    (area.abs() / 2.0 - cut) * height
}

/// A chamfer that should cut every vertical corner of a convex prism cleanly, with no word said.
fn check_clean(corners: &[(f64, f64)], d: f64, d2: f64, extra: Value) {
    check_cut(corners, d, d2, extra, 2 * corners.len() + 2);
}

fn check_cut(corners: &[(f64, f64)], d: f64, d2: f64, extra: Value, faces: usize) {
    let r = prism_chamfer(corners, 10.0, d, d2, z_edges(), extra.clone());
    let face_count = r.bodies.first().map(|b| kernel::count(&b.shape, Kind::Face));
    let got = (messages(&r), warnings(&r, "c"), face_count, (volume(&r) * 100.0).round() / 100.0);
    let want_volume = (clean_cut(corners, 10.0, d, d2) * 100.0).round() / 100.0;
    let want = (Vec::<&str>::new(), Vec::<&str>::new(), Some(faces), want_volume);
    assert_eq!(got, want, "{corners:?} at {d}/{d2} {extra}");
}

const PARALLELOGRAM: [(f64, f64); 4] = [(5.0, 2.0), (27.0, 2.0), (35.0, 18.0), (13.0, 18.0)];
const TRIANGLE: [(f64, f64); 3] = [(4.0, 1.0), (14.0, 1.0), (9.0, 9.660254)];

/// 3 + 12 fits a 20 mm wall only with the 12 at one corner and the 3 at the other. d went on the face the kernel's
/// map lists first, putting 12 + 12 on two walls: 3/12 was refused, 1/12 built 3746.71 for 3760.
#[test]
fn a_two_distance_chamfer_that_fits_with_one_size_at_each_end_of_a_face_builds() {
    for (d, d2) in [(3.0, 12.0), (12.0, 3.0), (3.0, 16.0)] {
        check_clean(&rect(7.0, -3.0, 20.0, 20.0), d, d2, json!({}));
    }
    for (d, d2) in [(3.0, 12.0), (12.0, 3.0)] {
        check_clean(&PARALLELOGRAM, d, d2, json!({}));
    }
    check_clean(&TRIANGLE, 2.0, 7.0, json!({}));
    for ((l, w), d, d2) in
        [((20.0, 20.0), 1.0, 12.0), ((40.0, 40.0), 3.0, 30.0), ((40.0, 40.0), 3.0, 36.0), ((25.0, 15.0), 12.0, 1.0)]
    {
        check_clean(&rect(-6.0, 11.0, l, w), d, d2, json!({}));
    }
}

/// On a 30 x 10 prism the 12 fits only on the 30 mm walls, in either order: 12/3 came back warned at 2525.
/// tangentEdges false goes straight to the section build.
#[test]
fn a_two_distance_chamfer_takes_the_faces_it_fits_on_in_either_order() {
    for extra in [json!({}), json!({"tangentEdges": false})] {
        check_clean(&rect(-12.0, 4.0, 30.0, 10.0), 3.0, 12.0, extra.clone());
        check_clean(&rect(-12.0, 4.0, 30.0, 10.0), 12.0, 3.0, extra.clone());
    }
    check_clean(&rect(3.0, -21.0, 40.0, 20.0), 18.0, 3.0, json!({"tangentEdges": false}));
    check_clean(&rect(7.0, -3.0, 20.0, 20.0), 3.0, 12.0, json!({"tangentEdges": false}));
}

/// Setbacks that just meet use up each wall and the section build cuts them, a hair past they cross.
#[test]
fn two_distance_setbacks_that_just_meet_on_a_wall_build() {
    check_clean(&rect(7.0, -3.0, 20.0, 20.0), 3.0, 16.9, json!({}));
    for (d, d2) in [(3.0, 17.0), (9.0, 11.0)] {
        check_cut(&rect(7.0, -3.0, 20.0, 20.0), d, d2, json!({}), 6);
    }
    let r = prism_chamfer(&rect(7.0, -3.0, 20.0, 20.0), 10.0, 3.0, 17.5, z_edges(), json!({}));
    assert!(!r.errors.is_empty() || !warnings(&r, "c").is_empty(), "3/17.5 built {} with no word", volume(&r));
}

/// None of these fits either way round. Cut one edge at a time, 40 x 20 at 3/30 came back 6002.65 with both 40 mm
/// walls carved and no word said.
#[test]
fn a_two_distance_chamfer_that_runs_past_a_face_is_never_silent() {
    for ((l, w), d, d2) in
        [((40.0, 20.0), 3.0, 30.0), ((40.0, 20.0), 30.0, 3.0), ((30.0, 10.0), 1.0, 20.0), ((40.0, 40.0), 38.0, 3.0)]
    {
        let r = prism_chamfer(&rect(-6.0, 11.0, l, w), 10.0, d, d2, z_edges(), json!({}));
        assert!(
            !r.errors.is_empty() || !warnings(&r, "c").is_empty(),
            "{l} x {w} at {d}/{d2}: built {} with no word",
            volume(&r)
        );
    }
}

/// 1 + 1 already runs past the ledge's 1.5 mm wall, a convex chamfer at one end and a concave fill at the other.
/// The section build never checked a fill against its neighbour: 3/1 built 1486.62 for at most 1492.
#[test]
fn a_chamfer_and_a_fill_crossing_on_a_short_wall_are_refused() {
    let ledge = [(6.0, -4.0), (26.0, -4.0), (26.0, 1.0), (24.5, 1.0), (24.5, 6.0), (6.0, 6.0)];
    for (d, d2) in [(1.0, 3.0), (3.0, 1.0), (1.0, 2.0), (2.0, 1.0)] {
        for extra in [json!({}), json!({"tangentEdges": false})] {
            let r = prism_chamfer(&ledge, 8.0, d, d2, z_edges(), extra.clone());
            assert!(
                !r.errors.is_empty() || !warnings(&r, "c").is_empty(),
                "{d}/{d2} {extra}: built {} with no word",
                volume(&r)
            );
        }
    }
    let near = |x: f64, y: f64| json!({"kind": "edge", "by": "nearest", "point": [x, y, 4.0], "body": "body1"});
    let r = prism_with(
        &ledge,
        8.0,
        vec![
            two_distance("c1", 3.0, 1.0, near(26.0, 1.0), json!({})),
            two_distance("c2", 3.0, 1.0, near(24.5, 1.0), json!({})),
        ],
    );
    let refused: Vec<Option<&str>> = r.errors.iter().map(|e| e.feature_id.as_deref()).collect();
    assert_eq!(refused, [Some("c2")], "the fill after the chamfer: {:?}, volume {}", messages(&r), volume(&r));
    assert!((volume(&r) - (1540.0 - 12.0)).abs() < 0.01, "the chamfer alone cuts 3 x 1 / 2 x 8: {}", volume(&r));
}

/// A U with a 12 mm deep, 8 mm wide slot, chamfered at every other corner, the slot's right one concave.
const U_PRISM: [(f64, f64); 8] =
    [(5.0, -7.0), (29.0, -7.0), (29.0, 13.0), (21.0, 13.0), (21.0, 1.0), (13.0, 1.0), (13.0, 13.0), (5.0, 13.0)];

fn u_alternate_corners() -> Value {
    let at = |i: usize| json!({"kind": "edge", "by": "nearest", "point": [U_PRISM[i].0, U_PRISM[i].1, 5.0], "body": "body1"});
    json!([at(0), at(2), at(4), at(6)])
}

/// A 17 mm fill fits neither the 12 mm wall nor the 8 mm floor of the U's inner corner: it came back warned about a
/// convex corner, the fill clamped without a word.
#[test]
fn a_concave_fill_longer_than_both_its_faces_is_refused() {
    for (d, d2) in [(1.0, 17.0), (17.0, 1.0), (3.0, 21.0)] {
        let r = prism_with(&U_PRISM, 10.0, vec![two_distance("c", d, d2, u_alternate_corners(), json!({}))]);
        assert_eq!(messages(&r).len(), 1, "{d}/{d2}: built {} with {:?}", volume(&r), warnings(&r, "c"));
    }
}

/// The U's inner corner takes its 12 along the 12 mm wall, just reaching the corner above, and 1 along the floor.
/// Given 1/12 it put the 12 on the 8 mm floor, warned at 3713.33.
#[test]
fn a_concave_fill_that_just_reaches_the_next_corner_builds() {
    for (d, d2) in [(1.0, 12.0), (12.0, 1.0)] {
        let r = prism_with(&U_PRISM, 10.0, vec![two_distance("c", d, d2, u_alternate_corners(), json!({}))]);
        let got = (messages(&r), warnings(&r, "c"), (volume(&r) * 100.0).round() / 100.0);
        assert_eq!(got, (Vec::<&str>::new(), Vec::<&str>::new(), 3840.0 - 2.0 * 60.0), "{d}/{d2}");
    }
}

fn x_chamfered_then(l: f64, w: f64, e: f64, d: f64, d2: f64) -> Rebuild {
    let x_edges = json!({"kind": "edge", "by": "axis", "axis": "X", "body": "body1"});
    prism_with(
        &rect(-6.0, 11.0, l, w),
        10.0,
        vec![
            json!({"id": "c0", "type": "chamfer", "distance": e, "edges": x_edges}),
            two_distance("c", d, d2, z_edges(), json!({})),
        ],
    )
}

/// An l x w x 10 block, X edges chamfered e, less each corner's d x d2 wedge, for every way round the corners take.
fn x_chamfered_cuts(l: f64, w: f64, e: f64, d: f64, d2: f64) -> Vec<f64> {
    let wedge = |a: f64, b: f64| {
        let m = e.min(b);
        let under = e * m - m * m / 2.0 - e * m * m / (2.0 * b) + m * m * m / (3.0 * b);
        a * b * 10.0 / 2.0 - 2.0 * a * under
    };
    let block = l * w * 10.0 - 2.0 * e * e * l;
    (0..16u32)
        .map(|bits| {
            let cut: f64 = (0..4).map(|c| if (bits >> c) & 1 == 1 { wedge(d, d2) } else { wedge(d2, d) }).sum();
            ((block - cut) * 100.0).round() / 100.0
        })
        .collect()
}

/// Past a 45 degree X edge chamfer each Z edge's wall ends on a short slant. The fit check read a longer setback as
/// crossing the bottom edge and skipped OCCT, the section build left 22 faces and 3864 for 3848.56 at 1 then 2/3.
#[test]
fn a_two_distance_chamfer_runs_on_past_a_short_slanted_end() {
    for (e, d, d2) in [(1.0, 2.0, 3.0), (1.0, 1.5, 1.0), (2.0, 5.0, 3.0), (4.0, 6.0, 5.0), (4.0, 2.0, 3.0)] {
        let r = x_chamfered_then(24.0, 20.0, e, d, d2);
        let v = (volume(&r) * 100.0).round() / 100.0;
        let one_way_round = x_chamfered_cuts(24.0, 20.0, e, d, d2).iter().any(|c| (c - v).abs() < 0.015);
        let got = (messages(&r), warnings(&r, "c"), kernel::count(&r.bodies[0].shape, Kind::Face), one_way_round);
        assert_eq!(got, (Vec::<&str>::new(), Vec::<&str>::new(), 14, true), "{e} then {d}/{d2}: {v}");
    }
}

/// The section build cuts a straight chamfer only over its edge, so past a slanted end or a fillet it left a step
/// with no word where OCCT finds no cut.
#[test]
fn a_two_distance_chamfer_the_section_build_would_leave_a_step_on_is_never_silent() {
    for (e, d, d2) in [(1.0, 1.0, 12.0), (2.0, 12.0, 2.0)] {
        let r = x_chamfered_then(24.0, 20.0, e, d, d2);
        let v = (volume(&r) * 100.0).round() / 100.0;
        let clean = x_chamfered_cuts(24.0, 20.0, e, d, d2).iter().any(|c| (c - v).abs() < 0.015);
        assert!(
            !r.errors.is_empty() || !warnings(&r, "c").is_empty() || clean,
            "{e} then {d}/{d2}: built {v} with no word"
        );
    }
    let top = json!({"kind": "edge", "by": "ofFace", "body": "body1",
        "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}});
    let r = prism_with(
        &rect(-6.0, 11.0, 20.0, 20.0),
        10.0,
        vec![
            json!({"id": "f", "type": "fillet", "radius": 2.0, "edges": top}),
            two_distance("c", 3.0, 12.0, z_edges(), json!({})),
        ],
    );
    assert!(!r.errors.is_empty() || !warnings(&r, "c").is_empty(), "built {} with no word", volume(&r));
}

const L_TOP: [(f64, f64); 6] = [(0.0, 0.0), (30.0, 0.0), (30.0, 10.0), (12.0, 10.0), (12.0, 24.0), (0.0, 24.0)];
const T_TOP: [(f64, f64); 8] =
    [(0.0, 0.0), (30.0, 0.0), (30.0, 10.0), (20.0, 10.0), (20.0, 24.0), (10.0, 24.0), (10.0, 10.0), (0.0, 10.0)];
const BAR_TOP: [(f64, f64); 4] = [(0.0, 0.0), (30.0, 0.0), (30.0, 10.0), (0.0, 10.0)];

/// The outline turned by atan(3/4) and moved off the origin, its top edges chamfered d on one face, d2 on the other.
fn top_ring(corners: &[(f64, f64)], d: f64, d2: f64) -> Rebuild {
    let turned: Vec<(f64, f64)> =
        corners.iter().map(|&(x, y)| (7.0 + 0.8 * x - 0.6 * y, -3.0 + 0.6 * x + 0.8 * y)).collect();
    let top = json!({"kind": "edge", "by": "ofFace", "body": "body1",
        "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}});
    prism_chamfer(&turned, 10.0, d, d2, top, json!({}))
}

fn outcome(r: &Rebuild) -> (usize, Vec<&str>, f64) {
    (r.errors.len(), warnings(r, "c"), (volume(r) * 100.0).round() / 100.0)
}

/// 5 + 5 just meets across the 10 mm arms and 10 runs down the 10 mm walls. The section build ended each chamfer
/// square at the inside corner, leaving the mitre: the L came back 2625 for 2550, the T 2420 for 2270, no word said.
#[test]
fn two_distance_setbacks_that_just_meet_past_an_inside_corner_are_refused() {
    let sizes = [(5.0, 9.0, 4.99), (9.0, 5.0, 8.99), (5.01, 9.0, 4.99), (4.0, 10.0, 3.99), (10.0, 4.0, 9.99)];
    for (corners, whole) in [(&L_TOP[..], 4680.0), (&T_TOP[..], 4400.0)] {
        for (d, d2, fits) in sizes {
            let r = top_ring(corners, d, d2);
            let got = (outcome(&r), messages(&r).first().and_then(|m| offered(m)));
            assert_eq!(got, ((1, vec![], whole), Some(fits)), "{corners:?} at {d}/{d2}: {:?}", messages(&r));
            let again = top_ring(corners, fits, d2 * fits / d);
            assert_eq!(
                (again.errors.len(), warnings(&again, "c").len()),
                (0, 0),
                "{corners:?} at {d}/{d2} offered {fits}"
            );
        }
    }
}

/// A hair short of meeting OCCT cuts the mitre, and a bar with no inside corner still takes setbacks that just meet.
#[test]
fn two_distance_setbacks_short_of_an_inside_corner_or_meeting_on_a_bar_build() {
    let cases = [
        (&L_TOP[..], 4.99, 9.0, 2620.23),
        (&L_TOP[..], 9.0, 4.99, 2553.66),
        (&T_TOP[..], 4.99, 9.0, 2373.51),
        (&BAR_TOP[..], 5.0, 9.0, 1566.67),
        (&BAR_TOP[..], 9.0, 5.0, 1500.0),
    ];
    for (corners, d, d2, want) in cases {
        let r = top_ring(corners, d, d2);
        assert_eq!(outcome(&r), (0, vec![], want), "{corners:?} at {d}/{d2}: {:?}", messages(&r));
    }
}

const SLANT_TOP: [(f64, f64); 6] = [(0.0, 0.0), (30.0, 0.0), (30.0, 10.0), (20.0, 10.0), (10.0, 20.0), (0.0, 20.0)];

/// The inside corner turns 225 degrees. Each size fits one way round but OCCT fails it, and the section build ended
/// both chamfers square at the corner: 2/8 came back 3819.2 where OCP cuts at most 3797.5, with no word.
#[test]
fn two_distance_chamfers_the_kernel_fails_past_a_slanted_inside_corner_are_refused() {
    for (d, d2) in [(2.0, 8.0), (3.0, 8.0), (4.0, 8.0), (3.0, 5.0)] {
        let r = top_ring(&SLANT_TOP, d, d2);
        let got = (outcome(&r), messages(&r).first().and_then(|m| offered(m)));
        assert_eq!(got, ((1, vec![], 4500.0), None), "at {d}/{d2}: {:?}", messages(&r));
    }
    for (d, d2, want) in [(4.0, 3.0, 3983.15), (5.0, 2.0, 4055.96)] {
        let r = top_ring(&SLANT_TOP, d, d2);
        assert_eq!(outcome(&r), (0, vec![], want), "at {d}/{d2}: {:?}", messages(&r));
    }
}

/// Two straight arms 10 wide meeting at an inside corner that turns 120 degrees.
const V60_TOP: [(f64, f64); 6] =
    [(0.0, 0.0), (30.0, 0.0), (30.0, 10.0), (17.320508, 10.0), (27.320508, 27.320508), (18.660254, 32.320508)];

fn equal_ring(corners: &[(f64, f64)], d: f64) -> Rebuild {
    let turned: Vec<(f64, f64)> =
        corners.iter().map(|&(x, y)| (7.0 + 0.8 * x - 0.6 * y, -3.0 + 0.6 * x + 0.8 * y)).collect();
    let top = json!({"kind": "edge", "by": "ofFace", "body": "body1",
        "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}});
    prism_with(&turned, 10.0, vec![json!({"id": "c", "type": "chamfer", "edges": top, "distance": d})])
}

/// 5 + 5 meets across the 10 mm arms, OCCT gives up and the section build takes over. It ended each chamfer square
/// at an inside corner and left the mitre wedge, tan(turn / 2) d^3 / 3 a corner: the L came back 3538.33 for 3496.67,
/// the T 3300 for 3216.67, the 120 degree corner 3738.84 for 3666.67. The volumes are the mitred offset of the top.
#[test]
fn equal_chamfers_that_meet_past_an_inside_corner_cut_the_mitre() {
    let cases = [
        (&L_TOP[..], 5.0, 3496.67),
        (&T_TOP[..], 5.0, 3216.67),
        (&SLANT_TOP[..], 5.0, 3489.89),
        (&V60_TOP[..], 5.0, 3666.67),
        (&L_TOP[..], 4.99, 3501.06),
        (&T_TOP[..], 4.99, 3221.06),
        (&SLANT_TOP[..], 4.99, 3493.59),
        (&V60_TOP[..], 4.99, 3671.66),
        (&BAR_TOP[..], 5.0, 2166.67),
    ];
    let owned = |r: Rebuild| {
        let (errors, warned, v) = outcome(&r);
        (errors, warned.iter().map(|w| w.to_string()).collect::<Vec<_>>(), v)
    };
    let got: Vec<_> = cases.iter().map(|&(corners, d, _)| owned(equal_ring(corners, d))).collect();
    let want: Vec<_> = cases.iter().map(|&(_, _, v)| (0, Vec::<String>::new(), v)).collect();
    assert_eq!(got, want);
}

const TILTED: [f64; 3] = [0.36, -0.48, 0.8];

/// Each loop turned by atan(3/4) and moved off the origin, all in one sketch on a plane through (2, -1, 3). The
/// region seed is a world point near the first loop's first corner.
fn plate(loops: &[&[(f64, f64)]], normal: [f64; 3], xdir: [f64; 3], height: f64, blends: Vec<Value>) -> Rebuild {
    let mut lines = vec![];
    for (k, corners) in loops.iter().enumerate() {
        let turned: Vec<(f64, f64)> =
            corners.iter().map(|&(x, y)| (7.0 + 0.8 * x - 0.6 * y, -3.0 + 0.6 * x + 0.8 * y)).collect();
        let n = turned.len();
        for i in 0..n {
            let (a, b) = (turned[i], turned[(i + 1) % n]);
            lines.push(json!({"type": "line", "id": format!("l{k}_{i}"), "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1}));
        }
    }
    let ydir = [
        normal[1] * xdir[2] - normal[2] * xdir[1],
        normal[2] * xdir[0] - normal[0] * xdir[2],
        normal[0] * xdir[1] - normal[1] * xdir[0],
    ];
    let origin = [2.0, -1.0, 3.0];
    let seed: Vec<f64> = (0..3).map(|i| origin[i] + 7.2 * xdir[i] - 1.6 * ydir[i]).collect();
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": {"origin": origin, "normal": normal, "xdir": xdir},
            "entities": lines}),
        json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": height, "operation": "new",
            "regions": [seed]}),
    ];
    features.extend(blends);
    build(&json!({"parameters": {}, "features": features}))
}

fn owned(r: &Rebuild) -> (usize, Vec<String>, f64, Option<f64>) {
    let (errors, warned, v) = outcome(r);
    (errors, warned.iter().map(|w| w.to_string()).collect(), v, messages(r).first().and_then(|m| offered(m)))
}

/// A 10 mm wall between the outline and the hole, so 5 + 5 meets across it and the section build takes over. Each
/// rim corner is an inside corner of the top face, which came back with its wedge: 6166.67 for 6000, 9166.67 for 9000.
#[test]
fn equal_chamfers_round_a_hole_rim_cut_the_mitre_on_a_tilted_face_too() {
    let cases = [
        (30.0, 10.0, [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], 5.0, 6000.0),
        (30.0, 10.0, [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], 4.99, 6007.99),
        (30.0, 10.0, TILTED, [0.8, 0.6, 0.0], 5.0, 6000.0),
        (40.0, 20.0, TILTED, [0.8, 0.6, 0.0], 5.0, 9000.0),
    ];
    let got: Vec<_> = cases
        .iter()
        .map(|&(outer, hole, normal, xdir, d, _)| {
            let inner = rect((outer - hole) / 2.0, (outer - hole) / 2.0, hole, hole);
            let top = json!({"kind": "edge", "by": "ofFace", "body": "body1",
                "face": {"kind": "face", "by": "normal", "dir": normal}});
            let c = json!({"id": "c", "type": "chamfer", "edges": top, "distance": d});
            owned(&plate(&[&rect(0.0, 0.0, outer, outer), &inner], normal, xdir, 10.0, vec![c]))
        })
        .collect();
    let want: Vec<_> = cases.iter().map(|&(.., v)| (0, vec![], v, None)).collect();
    assert_eq!(got, want);
}

/// Three chosen edges meet at each inside corner, two on the face and the concave wall edge, whose fill the section
/// build adds after its cuts, so no mitre makes it right: the L all round at 5 came back 2434.89 where OCCT's trend
/// gives about 2397, no word said. The corner offers no size, while the holed plate's own overlap still offers one.
#[test]
fn chamfers_where_three_chosen_edges_meet_at_an_inside_corner_are_refused() {
    let all = json!({"kind": "edge", "by": "all", "body": "body1"});
    let (z, x) = ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0]);
    let holed = |d: f64, d2: f64| {
        let c = two_distance("c", d, d2, all.clone(), json!({}));
        owned(&plate(
            &[&rect(0.0, 0.0, 20.0, 20.0), &rect(5.0, 5.0, 10.0, 10.0)],
            TILTED,
            [0.8, 0.6, 0.0],
            10.0,
            vec![c],
        ))
    };
    let l_all = |d: f64| {
        let c = json!({"id": "c", "type": "chamfer", "edges": all.clone(), "distance": d});
        owned(&plate(&[&L_TOP[..]], z, x, 10.0, vec![c]))
    };
    let got = vec![holed(4.0, 10.0), holed(1.0, 2.5), l_all(5.0), l_all(4.99), l_all(3.0)];
    let want = vec![
        (1, vec![], 3000.0, Some(1.0)),
        (0, vec![], 2737.5, None),
        (1, vec![], 4680.0, None),
        (0, vec![], 2403.96, None),
        (0, vec![], 3726.0, None),
    ];
    assert_eq!(got, want);
}

/// The slit's tip turns 10 degrees, too sharp for the mitre's cut. It refused with OCCT's bare "Failed creating a
/// chamfer", which named no place; it now names the tip.
#[test]
fn a_chamfer_past_an_inside_corner_too_sharp_to_mitre_is_refused_at_the_corner() {
    let notch = [(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (16.0, 20.0), (15.0, 8.569951), (14.0, 20.0), (0.0, 20.0)];
    let slit = |d: f64| {
        let top = json!({"kind": "edge", "by": "ofFace", "body": "body1",
            "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}});
        let c = json!({"id": "c", "type": "chamfer", "edges": top, "distance": d});
        let r = plate(&[&notch[..]], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], 10.0, vec![c]);
        (owned(&r), messages(&r).iter().any(|m| m.contains("through (15.858, 11.856, 13)")))
    };
    let got = vec![slit(0.5), slit(0.8), slit(1.7)];
    let want =
        vec![((0, vec![], 5870.35, None), false), ((1, vec![], 5885.7, None), true), ((1, vec![], 5885.7, None), true)];
    assert_eq!(got, want);
}
