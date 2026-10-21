//! Thin extrude: a wall of a given thickness along open or closed sketch curves,
//! with mitred corners, crossing walls fused, and the extrude's own operations.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn build(params: Value, features: Vec<Value>) -> Rebuild {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let doc = json!({ "parameters": params, "features": features });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn errors(r: &Rebuild) -> Vec<String> {
    r.errors.iter().map(|e| e.message.clone()).collect()
}

fn ok(r: &Rebuild) {
    assert!(r.errors.is_empty(), "errors: {:?}", errors(r));
}

fn err_with(r: &Rebuild, part: &str) {
    assert!(
        errors(r).iter().any(|e| e.contains(part)),
        "wanted an error with {part:?}, got {:?}",
        errors(r)
    );
}

fn bbox(r: &Rebuild, i: usize) -> [f64; 6] {
    kernel::bbox(&r.bodies[i].shape).expect("body has a box")
}

fn vol(r: &Rebuild, i: usize) -> f64 {
    kernel::volume(&r.bodies[i].shape)
}

fn near(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() < 1e-3, "{what}: {a} != {b}");
}

fn near_box(r: &Rebuild, want: [f64; 6]) {
    for (got, w) in bbox(r, 0).iter().zip(want) {
        near(*got, w, "bbox");
    }
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"id": id, "type": "line", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

fn sketch_at(z: f64, ents: Vec<Value>) -> Value {
    json!({"id": "sk", "type": "sketch",
           "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "entities": ents})
}

fn sketch(ents: Vec<Value>) -> Value {
    sketch_at(0.0, ents)
}

fn with(mut base: Value, extra: &Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn thin(extra: Value) -> Value {
    let e = json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10,
                   "operation": "new", "thin": true, "thickness": 2});
    with(e, &extra)
}

fn ell() -> Value {
    sketch(vec![line("a", [0., 0.], [40., 0.]), line("b", [40., 0.], [40., 30.])])
}

#[test]
fn an_l_of_two_lines_is_a_wall_with_a_mitred_corner() {
    let r = build(json!({}), vec![ell(), thin(json!({"curves": ["a", "b"]}))]);
    ok(&r);
    assert_eq!(r.bodies.len(), 1);
    near(vol(&r, 0), 1400.0, "centred L");
    near_box(&r, [0.0, -1.0, 0.0, 41.0, 30.0, 10.0]);
}

#[test]
fn the_sides_of_an_l() {
    for (side, extra, v) in [
        ("inside", json!({}), 1360.0),
        ("outside", json!({}), 1440.0),
        ("twoSides", json!({"thickness2": 1}), 2070.0),
    ] {
        let e = with(json!({"curves": ["a", "b"], "side": side}), &extra);
        let r = build(json!({}), vec![ell(), thin(e)]);
        ok(&r);
        near(vol(&r, 0), v, side);
    }
}

#[test]
fn a_line_drawn_one_way_has_its_inside_on_the_left() {
    let sk = sketch(vec![line("a", [0., 0.], [40., 0.])]);
    let r = build(json!({}), vec![sk, thin(json!({"side": "inside"}))]);
    ok(&r);
    near(vol(&r, 0), 800.0, "one line");
    near_box(&r, [0.0, 0.0, 0.0, 40.0, 2.0, 10.0]);
}

#[test]
fn a_plus_of_crossing_lines_is_one_body() {
    let sk = sketch(vec![line("h", [-20., 0.], [20., 0.]), line("v", [0., -20.], [0., 20.])]);
    let r = build(json!({}), vec![sk, thin(json!({}))]);
    ok(&r);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(kernel::count(&r.bodies[0].shape, kernel::Kind::Solid), 1);
    near(vol(&r, 0), 1560.0, "plus");
}

#[test]
fn a_t_is_one_body() {
    let sk = sketch(vec![line("h", [-20., 0.], [20., 0.]), line("v", [0., 0.], [0., 20.])]);
    let r = build(json!({}), vec![sk, thin(json!({}))]);
    ok(&r);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(kernel::count(&r.bodies[0].shape, kernel::Kind::Solid), 1);
    near(vol(&r, 0), 1180.0, "T");
}

#[test]
fn a_line_meeting_an_arc_at_a_corner_is_one_wall() {
    let sk = sketch(vec![
        line("a", [0., 0.], [10., 0.]),
        json!({"type": "arc", "id": "b", "x1": 10, "y1": 0, "mx": 20, "my": 10, "x2": 30, "y2": 0}),
    ]);
    let r = build(json!({}), vec![sk, thin(json!({}))]);
    ok(&r);
    assert_eq!(kernel::count(&r.bodies[0].shape, kernel::Kind::Solid), 1);
    let centre_line = 2.0 * (10.0 + 10.0 * std::f64::consts::PI) * 10.0;
    assert!((vol(&r, 0) / centre_line - 1.0).abs() < 0.02, "{} against {centre_line}", vol(&r, 0));
}

#[test]
fn a_closed_rectangle_is_a_ring_wall() {
    let sk = sketch(vec![json!({"type": "rectangle", "id": "r", "width": 40, "height": 30, "x": 0, "y": 0})]);
    for (side, v) in [("center", 2800.0), ("inside", 2640.0), ("outside", 2960.0)] {
        let r = build(json!({}), vec![sk.clone(), thin(json!({"curves": ["r"], "side": side}))]);
        ok(&r);
        near(vol(&r, 0), v, side);
    }
}

#[test]
fn a_closed_chain_of_lines_drawn_clockwise_still_has_its_inside_inside() {
    let sk = sketch(vec![
        line("a", [0., 0.], [0., 30.]),
        line("b", [0., 30.], [40., 30.]),
        line("c", [40., 30.], [40., 0.]),
        line("d", [40., 0.], [0., 0.]),
    ]);
    let r = build(json!({}), vec![sk, thin(json!({"side": "inside"}))]);
    ok(&r);
    near(vol(&r, 0), 2640.0, "clockwise rectangle, inside");
    near_box(&r, [0.0, 0.0, 0.0, 40.0, 30.0, 10.0]);
}

#[test]
fn a_circle_is_a_round_ring() {
    let sk = sketch(vec![json!({"type": "circle", "id": "c", "radius": 10, "x": 0, "y": 0})]);
    let r = build(json!({}), vec![sk, thin(json!({}))]);
    ok(&r);
    near(vol(&r, 0), std::f64::consts::PI * (121.0 - 81.0) * 10.0, "ring");
}

#[test]
fn lines_and_a_tangent_arc_make_a_u_wall() {
    let sk = sketch(vec![
        line("a", [0., 10.], [20., 10.]),
        json!({"type": "arc", "id": "b", "x1": 20, "y1": 10, "mx": 30, "my": 0, "x2": 20, "y2": -10}),
        line("c", [20., -10.], [0., -10.]),
    ]);
    let r = build(json!({}), vec![sk, thin(json!({}))]);
    ok(&r);
    near(vol(&r, 0), (80.0 + 20.0 * std::f64::consts::PI) * 10.0, "U");
    near_box(&r, [0.0, -11.0, 0.0, 31.0, 11.0, 10.0]);
}

#[test]
fn a_thin_wall_joins_and_cuts_a_target() {
    let bx = json!({"id": "bx", "type": "box", "length": 100, "width": 100, "height": 20});
    let r = build(json!({}), vec![bx.clone(), ell(), thin(json!({"operation": "cut", "targets": ["body1"]}))]);
    ok(&r);
    assert_eq!(r.bodies.len(), 1);
    near(vol(&r, 0), 200_000.0 - 1400.0, "cut");

    let top = sketch_at(10.0, vec![line("a", [0., 0.], [40., 0.]), line("b", [40., 0.], [40., 30.])]);
    let r = build(json!({}), vec![bx, top, thin(json!({"operation": "join", "targets": ["body1"]}))]);
    ok(&r);
    assert_eq!(r.bodies.len(), 1);
    near(vol(&r, 0), 200_000.0 + 1400.0, "join");
}

#[test]
fn a_thin_wall_takes_the_extrude_end_types() {
    let r = build(json!({}), vec![ell(), thin(json!({"symmetric": true}))]);
    ok(&r);
    near(vol(&r, 0), 2800.0, "symmetric");
    near(bbox(&r, 0)[2], -10.0, "symmetric bottom");
}

#[test]
fn the_thickness_takes_a_parameter() {
    let r = build(json!({"wall": 4}), vec![ell(), thin(json!({"thickness": "wall", "side": "inside"}))]);
    ok(&r);
    near(vol(&r, 0), (1200.0 - 36.0 * 26.0) * 10.0, "parameter thickness");
}

#[test]
fn bad_thin_walls_are_refused() {
    for (extra, says) in [
        (json!({"thickness": 0}), "thickness"),
        (json!({"curves": ["zz"]}), "zz"),
        (json!({"side": "sideways"}), "sideways"),
        (json!({"side": "twoSides"}), "thickness2"),
    ] {
        let e = with(json!({"curves": ["a", "b"]}), &extra);
        let r = build(json!({}), vec![ell(), thin(e)]);
        err_with(&r, says);
    }
}

#[test]
fn a_thin_extrude_keeps_its_regions_for_when_thin_is_off() {
    let sk = sketch(vec![json!({"type": "rectangle", "id": "r", "width": 40, "height": 30, "x": 0, "y": 0})]);
    let ex = thin(json!({"regions": [[0, 0, 0]]}));
    let r = build(json!({}), vec![sk.clone(), ex.clone()]);
    ok(&r);
    near(vol(&r, 0), 2800.0, "thin follows the curves");
    let r = build(json!({}), vec![sk, with(ex, &json!({"thin": false}))]);
    ok(&r);
    near(vol(&r, 0), 12000.0, "thin off extrudes the region");
}

#[test]
fn a_wall_thicker_than_its_loop_is_refused() {
    let sk = sketch(vec![json!({"type": "rectangle", "id": "r", "width": 40, "height": 30, "x": 0, "y": 0})]);
    let r = build(json!({}), vec![sk, thin(json!({"side": "inside", "thickness": 20}))]);
    err_with(&r, "thick");
}

#[test]
fn a_construction_line_is_no_wall() {
    let mut c = line("c", [0., 10.], [40., 10.]);
    c["construction"] = json!(true);
    let sk = sketch(vec![line("a", [0., 0.], [40., 0.]), c]);
    let r = build(json!({}), vec![sk.clone(), thin(json!({}))]);
    ok(&r);
    near(vol(&r, 0), 800.0, "construction skipped");
    let r = build(json!({}), vec![sk, thin(json!({"curves": ["c"]}))]);
    err_with(&r, "construction");
}

fn square_of_lines() -> Vec<Value> {
    vec![
        line("s1", [0., 0.], [40., 0.]),
        line("s2", [40., 0.], [40., 40.]),
        line("s3", [40., 40.], [0., 40.]),
        line("s4", [0., 40.], [0., 0.]),
    ]
}

fn one_solid(r: &Rebuild) {
    ok(r);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(kernel::count(&r.bodies[0].shape, kernel::Kind::Solid), 1);
}

#[test]
fn a_loop_with_a_stub_at_a_corner_is_a_ring_and_a_stub() {
    let mut ents = square_of_lines();
    ents.push(line("stub", [40., 40.], [40., 70.]));
    let r = build(json!({}), vec![sketch(ents), thin(json!({}))]);
    one_solid(&r);
    // ring 42*42 - 38*38 = 320, stub 2*30 less the 2*1 it shares with the ring
    near(vol(&r, 0), (320.0 + 58.0) * 10.0, "square and stub");
    near_box(&r, [-1.0, -1.0, 0.0, 41.0, 70.0, 10.0]);

    let mut ents = square_of_lines();
    ents.push(line("stub", [0., 0.], [0., -30.]));
    let r = build(json!({}), vec![sketch(ents), thin(json!({}))]);
    one_solid(&r);
    near(vol(&r, 0), (320.0 + 58.0) * 10.0, "stub at the first corner");
}

#[test]
fn a_rectangle_with_a_line_from_its_corner() {
    let rect = json!({"type": "rectangle", "id": "r", "width": 40, "height": 30, "x": 0, "y": 0});
    let sk = sketch(vec![rect, line("stub", [20., 15.], [20., 50.])]);
    // ring 2800 or 2960, stub 2*35 less the 2*2 square it shares with the ring
    for (side, v) in [("center", 2800.0 + 680.0), ("outside", 2960.0 + 660.0)] {
        let r = build(json!({}), vec![sk.clone(), thin(json!({"side": side}))]);
        one_solid(&r);
        near(vol(&r, 0), v, side);
    }
}

#[test]
fn a_diagonal_between_two_corners_keeps_the_corners_mitred() {
    let mut ents = square_of_lines();
    ents.push(line("diag", [0., 0.], [40., 40.]));
    let r = build(json!({}), vec![sketch(ents), thin(json!({}))]);
    one_solid(&r);
    // the diagonal's 2 by 40 sqrt 2 strip shares 2 sqrt 2 + 1 with the ring at each corner
    let diag = 2.0 * 40.0 * 2f64.sqrt() - 2.0 * (2.0 * 2f64.sqrt() + 1.0);
    near(vol(&r, 0), (320.0 + diag) * 10.0, "square and diagonal");
}

#[test]
fn a_y_of_three_lines_is_one_wall() {
    let arm = |id: &str, deg: f64| {
        let (s, c) = deg.to_radians().sin_cos();
        line(id, [0., 0.], [20.0 * c, 20.0 * s])
    };
    let sk = sketch(vec![arm("a", 90.0), arm("b", 210.0), arm("c", 330.0)]);
    let r = build(json!({}), vec![sk, thin(json!({}))]);
    one_solid(&r);
    // each arm owns 2 by 20 less the 1 / sqrt 3 it leaves at the meeting point to the next one
    near(vol(&r, 0), (120.0 - 3f64.sqrt()) * 10.0, "Y");
}
