//! FundaCAD 1's solveRules.test.ts: the radius guard and its blame list, rect edge offsets, held axes, merged ends and
//! drags.

use serde_json::{json, Value};

use crate::compile::{compile_and_solve, constraint_index_of, solve_keeping_axes, DragRefused, DragReq, SolveOpts};
use crate::geom::{coinc_key, v};
use crate::model::{Constraint, Entity};
use crate::test_fixtures::*;

fn cs(items: Vec<Value>) -> Vec<Constraint> {
    cons(Value::Array(items))
}

fn fix(e: &str, ps: &[i32]) -> Vec<Value> {
    ps.iter().map(|p| json!({ "type": "fix", "e": e, "p": p })).collect()
}

fn on(cx: f64, cy: f64, r: f64, deg: f64) -> (f64, f64) {
    (cx + r * deg.to_radians().cos(), cy + r * deg.to_radians().sin())
}

fn arc_about(id: &str, cx: f64, cy: f64, r: f64) -> Entity {
    let (s, e, m) = (on(cx, cy, r, 10.0), on(cx, cy, r, 130.0), on(cx, cy, r, 70.0));
    arc(id, s.0, s.1, e.0, e.1, m.0, m.1)
}

fn drag(from: (f64, f64), to: (f64, f64)) -> Option<DragReq> {
    Some(DragReq { from: v(from.0, from.1), to: v(to.0, to.1) })
}

fn solve_drag(ents: &[Entity], c: &[Constraint], d: Option<DragReq>) -> crate::compile::SolvePass {
    compile_and_solve(ents, c, d, &SolveOpts::default()).unwrap()
}

// A radius solved through zero is refused, blaming every dimension on that round.

fn c() -> Entity {
    circle("c", 120.0, 45.0, 5.0)
}
fn a() -> Entity {
    arc_about("a", 140.0, 60.0, 5.0)
}
fn b() -> Entity {
    arc_about("b", 160.0, 40.0, 4.0)
}
fn l() -> Entity {
    line("l", 100.0, 30.0, 130.0, 36.0)
}
fn q() -> Entity {
    pt("q", 112.0, 52.0)
}
fn o() -> Entity {
    circle("o", 120.0, 45.0, 9.0)
}

fn refused(ents: Vec<Entity>, constraints: Value, blamed: &[&str]) {
    let r = solve(&ents, &cons(constraints));
    let mut got = r.conflicts.clone();
    got.sort();
    assert_eq!(r.entities, ents);
    assert!(!r.ok);
    assert_eq!(got, blamed);
}

macro_rules! radius_guard {
    ($name:ident, $ents:expr, $cons:tt, $blamed:expr) => {
        #[test]
        fn $name() {
            refused($ents, json!($cons), $blamed);
        }
    };
}

radius_guard!(a_negative_radius_on_a_circle_is_refused, vec![c()], [{ "type": "radius", "e": "c", "value": -2 }], &["k0"]);
radius_guard!(a_negative_diameter_on_a_circle_is_refused, vec![c()], [{ "type": "diameter", "circle": "c", "value": -4 }], &["k0"]);
radius_guard!(a_negative_radius_on_an_arc_is_refused, vec![a()], [{ "type": "radius", "e": "a", "value": -3 }], &["k0"]);
radius_guard!(a_negative_diameter_on_an_arc_is_refused, vec![a()], [{ "type": "diameter", "circle": "a", "value": -6 }], &["k0"]);
radius_guard!(
    a_rim_gap_blames_the_radius_and_the_gap,
    vec![o(), c()],
    [{ "type": "radius", "e": "c", "value": -1 }, { "type": "c2cDistance", "c1": "o", "c2": "c", "value": 2 }],
    &["k0", "k1"]
);
radius_guard!(
    a_line_rim_gap_blames_the_radius_and_the_gap,
    vec![c(), l()],
    [{ "type": "radius", "e": "c", "value": -1 }, { "type": "c2lDistance", "circle": "c", "line": "l", "value": 3 }],
    &["k0", "k1"]
);
radius_guard!(
    a_point_rim_gap_blames_the_radius_and_the_gap,
    vec![c(), q()],
    [{ "type": "radius", "e": "c", "value": -1 }, { "type": "p2cDistance", "e": "q", "p": 0, "circle": "c", "value": 2 }],
    &["k0", "k1"]
);
radius_guard!(
    a_radial_gap_that_drives_only_the_inner_round_negative_blames_only_the_gap,
    vec![c(), o()],
    [{ "type": "radius", "e": "o", "value": 5 }, { "type": "radialGap", "inner": "c", "outer": "o", "value": 8 }],
    &["k1"]
);
radius_guard!(
    a_tangent_line_on_a_negative_circle_blames_both,
    vec![c(), l()],
    [{ "type": "radius", "e": "c", "value": -2 }, { "type": "tangent", "line": "l", "circle": "c" }],
    &["k0", "k1"]
);
radius_guard!(
    a_tangent_line_on_a_negative_arc_blames_both,
    vec![a(), l()],
    [{ "type": "radius", "e": "a", "value": -2 }, { "type": "tangent2", "a": "l", "b": "a" }],
    &["k0", "k1"]
);
radius_guard!(
    tangent_circles_with_a_negative_radius_blame_both,
    vec![o(), c()],
    [{ "type": "radius", "e": "c", "value": -2 }, { "type": "tangent2", "a": "o", "b": "c" }],
    &["k0", "k1"]
);
radius_guard!(
    equal_circles_with_a_negative_radius_blame_both,
    vec![o(), c()],
    [{ "type": "radius", "e": "o", "value": -1 }, { "type": "equalRadius", "a": "c", "b": "o" }],
    &["k0", "k1"]
);
radius_guard!(
    a_tangent_circle_and_arc_with_a_negative_radius_blame_both,
    vec![c(), a()],
    [{ "type": "radius", "e": "a", "value": -2 }, { "type": "tangent2", "a": "c", "b": "a" }],
    &["k0", "k1"]
);
radius_guard!(
    an_equal_circle_and_arc_with_a_negative_radius_blame_both,
    vec![c(), a()],
    [{ "type": "radius", "e": "a", "value": -2 }, { "type": "equalRadius", "a": "c", "b": "a" }],
    &["k0", "k1"]
);
radius_guard!(
    tangent_arcs_with_a_negative_radius_blame_both,
    vec![a(), b()],
    [{ "type": "radius", "e": "b", "value": -2 }, { "type": "tangent2", "a": "a", "b": "b" }],
    &["k0", "k1"]
);
radius_guard!(
    equal_arcs_with_a_negative_radius_blame_both,
    vec![a(), b()],
    [{ "type": "radius", "e": "b", "value": -2 }, { "type": "equalRadius", "a": "a", "b": "b" }],
    &["k0", "k1"]
);
radius_guard!(
    a_line_dimension_beside_a_negative_radius_is_not_blamed,
    vec![c(), l()],
    [{ "type": "radius", "e": "c", "value": -2 }, { "type": "horizontal", "line": "l" }],
    &["k0"]
);
radius_guard!(
    a_negative_radius_on_an_off_origin_negative_quadrant_circle_is_refused,
    vec![circle("n", -63.5, -22.25, 4.0), line("m", -80.0, -30.0, -50.0, -41.5)],
    [{ "type": "radius", "e": "n", "value": -2 }, { "type": "tangent", "line": "m", "circle": "n" }],
    &["k0", "k1"]
);

#[test]
fn a_small_circle_may_grow_and_a_zero_diameter_is_refused() {
    let small = circle("s", 120.5, 45.25, 0.5);
    let mut grow = fix("s", &[0]);
    grow.push(json!({ "type": "radius", "e": "s", "value": 0.8 }));
    let r = solve(std::slice::from_ref(&small), &cs(grow));
    entities_near(&r.entities, &[circle("s", 120.5, 45.25, 0.8)], 5e-7);
    assert_pass(&r, 0, true, &[], &[]);

    let mut zero = fix("s", &[0]);
    zero.push(json!({ "type": "diameter", "circle": "s", "value": 0 }));
    let r = solve(std::slice::from_ref(&small), &cs(zero));
    assert_eq!(r.entities, vec![small]);
    assert!(!r.ok);
    assert_eq!(r.conflicts, ["k1"]);
}

#[test]
fn a_refused_drag_on_a_fixed_point_is_still_reported() {
    let mut cons_ = vec![json!({ "type": "radius", "e": "c", "value": -2 })];
    cons_.extend(fix("p", &[0]));
    let r = solve_drag(&[c(), pt("p", 140.0, 47.0)], &cs(cons_), drag((140.0, 47.0), (145.0, 49.0)));
    assert!(!r.ok);
    assert_eq!(r.conflicts, ["k0"]);
    assert_eq!(r.drag_refused, Some(DragRefused::Fix));
}

// Offsets of rectangle edges.

#[test]
fn an_offset_of_a_rectangle_edge_pair_moves_only_the_copys_matching_edge() {
    let mut c = fix("r", &[0, 2]);
    c.push(json!({ "type": "offset", "pairs": [{ "src": "r~0", "cpy": "q~0" }], "value": 3 }));
    let r = solve(&[rect("r", 105.0, 55.0, 10.0, 10.0, 0.0), rect("q", 105.0, 55.0, 14.0, 14.0, 0.0)], &cs(c));
    assert_eq!(r.entities[0], rect("r", 105.0, 55.0, 10.0, 10.0, 0.0));
    let Entity::Rectangle { x, y, width, height, .. } = r.entities[1] else { panic!("rectangle lost") };
    near(y - height / 2.0, 47.0, digits(6));
    near(y + height / 2.0, 62.0, digits(6));
    // planegcs leaves the free side edges within 1e-3 of where they were
    near(x, 105.0, digits(2));
    near(width, 14.0, digits(2));
    assert_pass(&r, 3, true, &[], &[]);
}

#[test]
fn a_rectangle_edge_to_line_offset_pair_turns_the_line_parallel() {
    let mut c = fix("r", &[0, 2]);
    c.push(json!({ "type": "hDistance", "e1": "r", "p1": 0, "e2": "b", "p2": 0, "value": -5 }));
    c.push(json!({ "type": "distance", "line": "b", "value": 10 }));
    c.push(json!({ "type": "offset", "pairs": [{ "src": "r~0", "cpy": "b" }], "value": 3 }));
    let r = solve(&[rect("r", 105.0, 55.0, 10.0, 10.0, 0.0), line("b", 95.0, 46.0, 105.0, 47.5)], &cs(c));
    entities_near(&r.entities, &[rect("r", 105.0, 55.0, 10.0, 10.0, 0.0), line("b", 95.0, 47.0, 105.0, 47.0)], 5e-7);
    assert_pass(&r, 0, true, &[], &[]);
}

// solveKeepingAxes: an L drawn with a horizontal foot and a vertical leg, the foot re-dimensioned from 10 to 14.

fn foot() -> Entity {
    line("h", 100.0, 50.0, 110.0, 50.0)
}
fn leg() -> Entity {
    line("v", 110.0, 50.0, 110.0, 58.0)
}
fn held() -> Vec<Entity> {
    vec![line("h", 100.0, 50.0, 114.0, 50.0), line("v", 114.0, 50.0, 114.0, 58.0)]
}

fn dim_h(value: i32) -> Value {
    json!({ "type": "distance", "line": "h", "value": value })
}

#[test]
fn the_leg_stays_vertical_while_the_foot_grows() {
    let mut c = fix("h", &[0]);
    c.push(dim_h(14));
    let r = solve_keeping_axes(&[foot(), leg()], &cs(c), None).unwrap();
    entities_near(&r.entities, &held(), 5e-7);
    assert_pass(&r, 3, true, &[], &[]);
}

#[test]
fn the_anchor_stays_in_place_when_nothing_is_fixed() {
    let r = solve_keeping_axes(&[foot(), leg()], &cs(vec![dim_h(14)]), Some(v(100.0, 50.0))).unwrap();
    entities_near(&r.entities, &held(), 5e-7);
    assert_pass(&r, 5, true, &[], &[]);
}

#[test]
fn a_leg_drawn_within_1e_6_of_vertical_is_held() {
    let mut c = fix("h", &[0]);
    c.push(dim_h(14));
    let r = solve_keeping_axes(&[foot(), line("v", 110.0, 50.0, 110.0 + 5e-7, 58.0)], &cs(c), None).unwrap();
    let leg = ln(&r.entities[1]);
    assert!(r.ok);
    near(leg.2 - leg.0, 0.0, digits(9));
    near(leg.3, 58.0, digits(9));
}

#[test]
fn no_axis_is_held_on_a_slanted_leg_drawn_leftwards() {
    let mut c = fix("h", &[0]);
    c.push(dim_h(14));
    let r = solve_keeping_axes(&[foot(), line("v", 110.0, 50.0, 104.0, 58.0)], &cs(c), None).unwrap();
    entities_near(&r.entities, &[line("h", 100.0, 50.0, 114.0, 50.0), line("v", 114.0, 50.0, 104.0, 58.0)], 5e-7);
    assert_pass(&r, 3, true, &[], &[]);
}

#[test]
fn held_axes_fall_back_to_the_plain_solve_when_they_would_conflict() {
    let mut c = fix("h", &[0]);
    c.push(json!({ "type": "angle", "l1": "h", "l2": "v", "value": 80 }));
    let c = cs(c);
    let kept = solve_keeping_axes(&[foot(), leg()], &c, None).unwrap();
    assert_eq!(kept, solve(&[foot(), leg()], &c));
}

#[test]
fn an_off_origin_foot_grows_with_the_leg_held_vertical() {
    let ents = [line("h", -42.0, -30.5, -32.0, -30.5), line("v", -32.0, -30.5, -32.0, -22.5)];
    let mut c = fix("h", &[0]);
    c.push(dim_h(14));
    let r = solve_keeping_axes(&ents, &cs(c), None).unwrap();
    entities_near(
        &r.entities,
        &[line("h", -42.0, -30.5, -28.0, -30.5), line("v", -28.0, -30.5, -28.0, -22.5)],
        5e-7,
    );
    assert_pass(&r, 3, true, &[], &[]);
}

// Merged ends.

fn spline() -> Entity {
    Entity::Spline { id: "s".into(), points: vec![v(100.0, 50.0), v(105.0, 56.0), v(112.0, 53.0)] }
}

#[test]
fn a_spline_end_drags_with_the_line_end_on_it_and_its_inner_points_stay() {
    let ents = [spline(), line("b", 112.0, 53.0, 120.0, 60.0), line("c", 105.0, 56.0, 98.0, 62.0)];
    let r = solve_drag(&ents, &[], drag((112.0, 53.0), (113.0, 55.5)));
    let want = [
        Entity::Spline { id: "s".into(), points: vec![v(100.0, 50.0), v(105.0, 56.0), v(113.0, 55.5)] },
        line("b", 113.0, 55.5, 120.0, 60.0),
        line("c", 105.0, 56.0, 98.0, 62.0),
    ];
    entities_near(&r.entities, &want, 5e-7);
    assert_pass(&r, 12, true, &[], &[]);
}

// The line comes first next to the closed one, so the drag grabs the line's end and not the unmerged pole under it.
#[test]
fn an_open_bsplines_end_pole_drags_with_the_line_end_on_it_but_not_a_closed_ones() {
    let poles = vec![v(112.0, 53.0), v(108.0, 60.0), v(101.0, 57.0), v(99.0, 51.0)];
    let open = Entity::Bspline { id: "s".into(), poles: poles.clone(), closed: false };
    let closed = Entity::Bspline { id: "s".into(), poles: poles.clone(), closed: true };
    let d = || drag((112.0, 53.0), (113.0, 55.5));
    let ro = solve_drag(&[open, line("b", 112.0, 53.0, 120.0, 60.0)], &[], d());
    let rc = solve_drag(&[line("b", 112.0, 53.0, 120.0, 60.0), closed.clone()], &[], d());
    let mut moved = poles;
    moved[0] = v(113.0, 55.5);
    entities_near(
        &ro.entities,
        &[Entity::Bspline { id: "s".into(), poles: moved, closed: false }, line("b", 113.0, 55.5, 120.0, 60.0)],
        5e-7,
    );
    entities_near(&rc.entities, &[line("b", 113.0, 55.5, 120.0, 60.0), closed], 5e-7);
}

#[test]
fn a_spline_end_snaps_coincident_onto_a_line_through_its_last_point() {
    let mut c = fix("b", &[0, 1]);
    c.push(json!({ "type": "coincident", "e1": "s", "p1": 1, "e2": "b", "p2": 0 }));
    let r = solve(&[spline(), line("b", 118.0, 49.0, 124.0, 57.0)], &cs(c));
    entities_near(
        &r.entities,
        &[
            Entity::Spline { id: "s".into(), points: vec![v(100.0, 50.0), v(105.0, 56.0), v(118.0, 49.0)] },
            line("b", 118.0, 49.0, 124.0, 57.0),
        ],
        5e-7,
    );
}

#[test]
fn a_line_end_is_pulled_coincident_onto_the_last_sample_of_a_projected_poly() {
    let p = poly("P", &[(100.0, 50.0), (104.0, 53.0), (110.0, 51.0)]);
    let mut c = fix("b", &[1]);
    c.push(json!({ "type": "coincident", "e1": "b", "p1": 0, "e2": "P", "p2": 1 }));
    let r = solve(&[p.clone(), line("b", 112.0, 56.0, 120.0, 60.0)], &cs(c));
    entities_near(&r.entities, &[p, line("b", 110.0, 51.0, 120.0, 60.0)], 5e-7);
    assert_pass(&r, 0, true, &[], &[]);
}

#[test]
fn points_merge_into_one_thousandth_bucket() {
    assert_eq!(coinc_key(100.4996, 50.0004), (100_500, 50_000));
    assert_eq!(coinc_key(100.5004, 49.9996), (100_500, 50_000));
    assert_eq!(coinc_key(100.5006, 50.0), (100_501, 50_000));
}

#[test]
fn points_in_the_negative_quadrant_round_halves_up_like_javascript() {
    assert_eq!(coinc_key(-100.4996, -50.0004), (-100_500, -50_000));
    assert_eq!(coinc_key(-0.0005, 0.0005), (0, 1));
    assert_eq!(coinc_key(-0.0015, -0.0025), (-1, -2));
}

#[test]
fn a_user_constraint_index_decodes_from_a_sub_id_and_none_from_an_implicit_one() {
    let got: Vec<_> = ["k12p3", "k3", "r~h0", "Rp_rules", "Rp~radius", "x7"].map(constraint_index_of).into();
    assert_eq!(got, [Some(12), Some(3), None, None, None, None]);
}

// Drags.

#[test]
fn a_drag_grabs_the_first_of_two_points_at_the_same_distance() {
    let r = solve_drag(&[pt("a", 100.0, 50.0), pt("b", 104.0, 53.0)], &[], drag((102.0, 51.5), (101.0, 49.0)));
    entities_near(&r.entities, &[pt("a", 101.0, 49.0), pt("b", 104.0, 53.0)], 5e-7);
    assert_pass(&r, 4, true, &[], &[]);
}

#[test]
fn a_drag_grabs_the_nearer_point_whichever_comes_first() {
    let r = solve_drag(&[pt("a", -100.0, 50.0), pt("b", -96.0, 53.0)], &[], drag((-95.0, 54.0), (-90.0, 60.5)));
    entities_near(&r.entities, &[pt("a", -100.0, 50.0), pt("b", -90.0, 60.5)], 5e-7);
    assert_pass(&r, 4, true, &[], &[]);
}

#[test]
fn a_drag_on_projected_geometry_and_on_a_fixed_point_is_refused_naming_which() {
    let ents = [pl("P", 100.0, 50.0, 110.0, 56.0), pt("f", 120.0, 40.0)];
    let on_projected = solve_drag(&ents, &cs(fix("f", &[0])), drag((110.0, 56.1), (112.0, 59.0)));
    let on_fixed = solve_drag(&ents, &cs(fix("f", &[0])), drag((120.1, 40.0), (125.0, 42.0)));
    for (r, why) in [(on_projected, DragRefused::Projected), (on_fixed, DragRefused::Fix)] {
        assert_eq!(r.entities, ents.to_vec());
        assert_pass(&r, 0, true, &[], &[]);
        assert_eq!(r.drag_refused, Some(why));
    }
}
