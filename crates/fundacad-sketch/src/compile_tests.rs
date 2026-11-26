//! FundaCAD 1's sketchSolve.test.ts: projected geometry, offsets, rotated rectangles, coincident operands, a corner
//! pinned to the origin and held axes.

use serde_json::json;

use crate::compile::{compile_and_solve, constraint_index_of, solve_keeping_axes, DragRefused, DragReq, SolveOpts, SolvePass};
use crate::geom::{rect_corners, v};
use crate::model::{resolve_entities, write_back, Entity};
use crate::test_fixtures::*;

type L = (f64, f64, f64, f64);

#[test]
fn constraint_index_decodes_user_ids_and_rejects_implicit_ones() {
    assert_eq!(constraint_index_of("k7"), Some(7));
    assert_eq!(constraint_index_of("k7a"), Some(7));
    assert_eq!(constraint_index_of("k12p3"), Some(12));
    assert_eq!(constraint_index_of("e3~r"), None);
    assert_eq!(constraint_index_of("e3~h0"), None);
    assert_eq!(constraint_index_of("__dragc"), None);
}

#[test]
fn projected_line_removes_no_dof_from_a_horizontal_user_line() {
    let ents = [pl("pl", 0.0, 0.0, 40.0, 0.0), line("u", 5.0, 5.0, 15.0, 5.0)];
    let r = solve(&ents, &cons(json!([{ "type": "horizontal", "line": "u" }])));
    assert!(r.ok);
    assert_eq!(r.dof, 3);
}

#[test]
fn slanted_projected_line_removes_no_dof_from_an_off_origin_user_line() {
    let ents = [pl("pl", -3.0, -7.0, 31.0, 11.0), line("u", 12.0, 9.0, 20.5, 14.0)];
    let r = solve(&ents, &cons(json!([{ "type": "horizontal", "line": "u" }])));
    assert!(r.ok);
    assert_eq!(r.dof, 3);
}

/// A user line hung off a projected line's end follows when the projection moves.
fn follows_a_projection(from: L, start_u: L, to: L) {
    let cs = cons(json!([
        { "type": "coincident", "e1": "u", "p1": 0, "e2": "pl", "p2": 1 },
        { "type": "horizontal", "line": "u" },
        { "type": "distance", "line": "u", "value": 20 },
    ]));
    let before = [pl("pl", from.0, from.1, from.2, from.3), line("u", start_u.0, start_u.1, start_u.2, start_u.3)];
    let r1 = solve(&before, &cs);
    assert!(r1.ok);
    assert!(r1.conflicts.is_empty());
    let u1 = ln_of(&r1, "u");
    near(u1.0, from.2, 1e-9);
    near(u1.1, from.3, 1e-9);
    near(len(u1), 20.0, digits(6));

    let moved = [pl("pl", to.0, to.1, to.2, to.3), find(&r1.entities, "u").clone()];
    let r2 = solve(&moved, &cs);
    assert!(r2.ok);
    let u2 = ln_of(&r2, "u");
    near(u2.0, to.2, digits(6));
    near(u2.1, to.3, digits(6));
    near(u2.3, to.3, digits(6));
    near(len(u2), 20.0, digits(6));
    assert_eq!(projected_of(&r2.entities), projected_of(&moved));
}

#[test]
fn user_line_coincident_to_a_projected_endpoint_follows_when_the_projection_moves() {
    follows_a_projection((0.0, 0.0, 40.0, 0.0), (40.0, 0.0, 60.0, 2.0), (0.0, 5.0, 40.0, 5.0));
}

#[test]
fn user_line_follows_a_slanted_projection_that_moves_off_origin() {
    follows_a_projection((-6.0, -4.0, 33.5, 12.25), (33.5, 12.25, 52.0, 9.0), (-10.5, 3.25, 29.0, 19.5));
}

fn conflicting_dim_on(l: L, value: f64) {
    let ents = [pl("pl", l.0, l.1, l.2, l.3)];
    let r = solve(&ents, &cons(json!([{ "type": "p2pDistance", "e1": "pl", "p1": 0, "e2": "pl", "p2": 1, "value": value }])));
    assert_eq!(projected_of(&r.entities), ents.to_vec());
    assert!(flagged(&r).contains(&0), "{r:?}");
}

#[test]
fn projected_coords_never_change_even_under_a_conflicting_dim() {
    conflicting_dim_on((0.0, 0.0, 40.0, 0.0), 30.0);
}

#[test]
fn a_slanted_projected_line_never_changes_under_a_conflicting_dim() {
    conflicting_dim_on((-3.0, 2.0, 21.0, 20.0), 25.0);
}

fn fixed_pair_dim(a: L, b: L, value: f64) {
    let ents = [pl("pa", a.0, a.1, a.2, a.3), pl("pb", b.0, b.1, b.2, b.3)];
    let r = solve(&ents, &cons(json!([{ "type": "p2pDistance", "e1": "pa", "p1": 0, "e2": "pb", "p2": 0, "value": value }])));
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    assert!(r.over_defined.iter().filter_map(|i| constraint_index_of(i)).any(|i| i == 0), "{r:?}");
    assert_eq!(projected_of(&r.entities), ents.to_vec());
}

#[test]
fn a_dim_between_two_fully_fixed_projected_points_is_over_defined() {
    fixed_pair_dim((0.0, 0.0, 40.0, 0.0), (0.0, 10.0, 40.0, 10.0), 10.0);
}

#[test]
fn a_slanted_dim_between_two_fixed_projected_points_is_over_defined() {
    fixed_pair_dim((2.5, -1.5, 40.0, 13.0), (8.5, 6.5, -20.0, 30.0), 10.0);
}

fn projected_circle_dim(c: (f64, f64, f64), u: L, dist: f64) {
    let ents = [pc("pc", c.0, c.1, c.2), line("u", u.0, u.1, u.2, u.3)];
    let cs = cons(json!([
        { "type": "horizontal", "line": "u" },
        { "type": "distance", "line": "u", "value": 15 },
        { "type": "p2pDistance", "e1": "u", "p1": 0, "e2": "pc", "p2": 0, "value": dist },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    assert!(flagged(&r).is_empty(), "no internal pin surfaces as a user constraint problem: {r:?}");
    assert_eq!(projected_of(&r.entities), vec![ents[0].clone()]);
    let l = ln_of(&r, "u");
    near((l.0 - c.0).hypot(l.1 - c.1), dist, digits(5));
}

#[test]
fn projected_circle_pins_centre_and_radius_so_a_dimensioned_user_line_moves() {
    projected_circle_dim((10.0, 10.0, 5.0), (30.0, 10.0, 45.0, 10.0), 12.0);
}

#[test]
fn projected_circle_off_origin_moves_a_slightly_slanted_user_line() {
    projected_circle_dim((-8.5, 13.25, 4.5), (20.0, -3.0, 34.0, -3.5), 12.0);
}

/// An arc slides by `shift` and a vertical line hung on its end follows.
fn projected_arc_refresh(centre: (f64, f64), r: f64, a0: f64, a1: f64, shift: (f64, f64)) {
    let cs = cons(json!([
        { "type": "coincident", "e1": "u", "p1": 0, "e2": "pa", "p2": 1 },
        { "type": "vertical", "line": "u" },
        { "type": "distance", "line": "u", "value": 8 },
    ]));
    let end = (centre.0 + r * a1.cos(), centre.1 + r * a1.sin());
    let before = [arc_at("pa", centre.0, centre.1, r, a0, a1, true), line("u", end.0, end.1, end.0, end.1 - 8.0)];
    let r1 = solve(&before, &cs);
    assert!(r1.ok);
    assert_eq!(projected_of(&r1.entities), vec![before[0].clone()]);
    let moved = arc_at("pa", centre.0 + shift.0, centre.1 + shift.1, r, a0, a1, true);
    let r2 = solve(&[moved, find(&r1.entities, "u").clone()], &cs);
    assert!(r2.ok);
    let u2 = ln_of(&r2, "u");
    near(u2.0, end.0 + shift.0, digits(6));
    near(u2.1, end.1 + shift.1, digits(6));
    near((u2.3 - u2.1).abs(), 8.0, digits(6));
}

#[test]
fn projected_arc_fixes_all_three_points_and_coincident_geometry_follows_a_refresh() {
    projected_arc_refresh((5.0, 0.0), 5.0, std::f64::consts::PI, 0.0, (3.0, 0.0));
}

#[test]
fn a_rotated_off_origin_projected_arc_is_followed_by_coincident_geometry() {
    projected_arc_refresh((-3.0, 4.5), 6.0, 0.4, 2.9, (3.0, -2.25));
}

fn projected_poly_anchor(pts: &[(f64, f64)], u: L) {
    let last = pts[pts.len() - 1];
    let ents = [poly("pp", pts), line("u", u.0, u.1, u.2, u.3)];
    let cs = cons(json!([
        { "type": "coincident", "e1": "u", "p1": 0, "e2": "pp", "p2": 1 },
        { "type": "horizontal", "line": "u" },
        { "type": "distance", "line": "u", "value": 5 },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    let l = ln_of(&r, "u");
    near(l.0, last.0, digits(6));
    near(l.1, last.1, digits(6));
    near(l.3, last.1, digits(6));
    assert_eq!(projected_of(&r.entities), vec![ents[0].clone()]);
}

#[test]
fn projected_poly_first_and_last_samples_anchor_coincident_geometry() {
    projected_poly_anchor(&[(0.0, 0.0), (2.0, 1.0), (4.0, 1.5), (6.0, 1.0)], (6.0, 1.0, 11.0, 2.0));
}

#[test]
fn an_off_origin_projected_poly_anchors_on_its_last_sample() {
    projected_poly_anchor(&[(-3.0, 1.5), (-1.0, 2.5), (1.0, 3.0), (3.25, 2.5)], (3.25, 2.5, 8.0, 4.0));
}

fn snapped_projected_endpoint(p: L, u: L) {
    let ents = [pl("pl", p.0, p.1, p.2, p.3), line("u", u.0, u.1, u.2, u.3)];
    let r = solve(&ents, &cons(json!([{ "type": "coincident", "e1": "u", "p1": 0, "e2": "pl", "p2": 1 }])));
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    assert!(r.over_defined.is_empty(), "{r:?}");
}

#[test]
fn coincident_on_an_exactly_snapped_projected_endpoint_merges_without_conflict() {
    snapped_projected_endpoint((0.0, 0.0, 40.0, 0.0), (40.0, 0.0, 55.0, 5.0));
}

#[test]
fn coincident_on_an_exactly_snapped_slanted_endpoint_merges_without_conflict() {
    snapped_projected_endpoint((-4.0, 2.5, 30.0, 16.75), (30.0, 16.75, 45.0, 21.0));
}

fn drag_to_projected(p: L, u: L, to: (f64, f64)) {
    let ents = [pl("pl", p.0, p.1, p.2, p.3), line("u", u.0, u.1, u.2, u.3)];
    let cs = cons(json!([{ "type": "distance", "line": "u", "value": 20 }]));
    let drag = DragReq { from: v(p.2, p.3), to: v(to.0, to.1) };
    let r = compile_and_solve(&ents, &cs, Some(drag), &SolveOpts::default()).unwrap();
    assert!(r.conflicts.is_empty());
    assert_eq!(r.drag_refused, Some(DragRefused::Projected));
    let l = ln_of(&r, "u");
    assert_eq!((l.0, l.1), (u.0, u.1));
    assert_eq!(projected_of(&r.entities), vec![ents[0].clone()]);
}

#[test]
fn dragging_a_user_endpoint_merged_onto_a_projected_point_is_refused() {
    drag_to_projected((0.0, 0.0, 40.0, 0.0), (40.0, 0.0, 60.0, 0.0), (45.0, 9.0));
}

#[test]
fn dragging_an_endpoint_merged_onto_a_slanted_projected_point_is_refused() {
    drag_to_projected((-5.0, -3.0, 35.0, 9.5), (35.0, 9.5, 54.0, 14.0), (40.0, 20.0));
}

fn drag_user_line(l: L, fix_start: bool, grab: (f64, f64), to: (f64, f64)) -> SolvePass {
    let cs = if fix_start { cons(json!([{ "type": "fix", "e": "u", "p": 0 }])) } else { cons(json!([])) };
    let drag = DragReq { from: v(grab.0, grab.1), to: v(to.0, to.1) };
    compile_and_solve(&[line("u", l.0, l.1, l.2, l.3)], &cs, Some(drag), &SolveOpts::default()).unwrap()
}

#[test]
fn drag_refused_names_a_user_fix_pin() {
    let r = drag_user_line((0.0, 0.0, 20.0, 0.0), true, (0.0, 0.0), (5.0, 5.0));
    assert_eq!(r.drag_refused, Some(DragRefused::Fix));
    let l = ln_of(&r, "u");
    assert_eq!((l.0, l.1), (0.0, 0.0));
}

#[test]
fn a_free_drag_reports_nothing_and_moves_the_grabbed_end() {
    let r = drag_user_line((0.0, 0.0, 20.0, 0.0), false, (20.0, 0.0), (25.0, 5.0));
    assert_eq!(r.drag_refused, None);
    let l = ln_of(&r, "u");
    near(l.2, 25.0, 1e-9);
    near(l.3, 5.0, 1e-9);
}

#[test]
fn an_off_origin_fix_pin_refuses_a_drag_and_a_free_slanted_line_drags() {
    let r = drag_user_line((4.0, -3.0, 19.5, 6.0), true, (4.2, -2.9), (-5.0, 8.0));
    assert_eq!(r.drag_refused, Some(DragRefused::Fix));
    let l = ln_of(&r, "u");
    assert_eq!((l.0, l.1), (4.0, -3.0));
    let r = drag_user_line((4.0, -3.0, 19.5, 6.0), false, (19.4, 6.2), (-5.0, 8.0));
    assert_eq!(r.drag_refused, None);
    let l = ln_of(&r, "u");
    near(l.2, -5.0, 1e-9);
    near(l.3, 8.0, 1e-9);
}

fn break_link_keeps_constraints(pl_line: L, u: L, grab: (f64, f64), to: (f64, f64)) {
    let cs = cons(json!([
        { "type": "coincident", "e1": "u", "p1": 0, "e2": "pl", "p2": 1 },
        { "type": "p2pDistance", "e1": "u", "p1": 1, "e2": "pl", "p2": 0, "value": 50 },
    ]));
    let before = [pl("pl", pl_line.0, pl_line.1, pl_line.2, pl_line.3), line("u", u.0, u.1, u.2, u.3)];
    let r1 = solve(&before, &cs);
    assert!(r1.ok);
    assert!(r1.conflicts.is_empty());

    let broken = break_link(&r1.entities, &["pl"]);
    assert!(matches!(&broken[0], Entity::Line { id, .. } if id == "pl"));
    let r2 = solve(&broken, &cs);
    assert!(r2.ok);
    assert!(r2.conflicts.is_empty());
    assert!(r2.dof > r1.dof, "the ex-projected line's 4 DOF joined the sketch, {} vs {}", r2.dof, r1.dof);

    let drag = DragReq { from: v(grab.0, grab.1), to: v(to.0, to.1) };
    let r3 = compile_and_solve(&broken, &cs, Some(drag), &SolveOpts::default()).unwrap();
    assert_eq!(r3.drag_refused, None);
    let d = ln_of(&r3, "pl");
    near(d.0, to.0, digits(6));
    near(d.1, to.1, digits(6));
}

#[test]
fn constraints_survive_break_link_and_the_ex_projected_line_drags() {
    break_link_keeps_constraints((0.0, 0.0, 40.0, 0.0), (40.0, 0.0, 55.0, 5.0), (0.0, 0.0), (-5.0, 3.0));
}

#[test]
fn a_slanted_off_origin_link_keeps_its_constraints_through_break_link() {
    break_link_keeps_constraints((-6.0, 3.5, 33.0, 21.0), (33.0, 21.0, 48.0, 29.0), (-6.0, 3.5), (-9.5, 0.25));
}

fn dim_to_broken_closed_poly(pts: &[(f64, f64)], u: L) {
    let cs = cons(json!([{ "type": "p2pDistance", "e1": "u", "p1": 0, "e2": "pq", "p2": 0, "value": 10 }]));
    let ents = [poly("pq", pts), line("u", u.0, u.1, u.2, u.3)];
    let r1 = solve(&ents, &cs);
    assert!(r1.ok);
    assert!(r1.conflicts.is_empty());

    let broken = break_link(&ents, &["pq"]);
    assert!(matches!(&broken[0], Entity::Spline { id, .. } if id == "pq"));
    let r2 = solve(&broken, &cs);
    assert!(r2.ok);
    assert!(r2.conflicts.is_empty());
    let u = ln_of(&r2, "u");
    let Entity::Spline { points, .. } = find(&r2.entities, "pq") else { panic!("spline lost") };
    near((u.0 - points[0].x).hypot(u.1 - points[0].y), 10.0, digits(5));
}

#[test]
fn a_p2p_dim_to_a_broken_closed_poly_still_resolves_at_index_zero() {
    dim_to_broken_closed_poly(&[(0.0, 0.0), (4.0, 4.0), (8.0, 0.0), (0.0, 0.0)], (10.0, 0.0, 20.0, 0.0));
}

#[test]
fn a_p2p_dim_to_a_broken_off_origin_closed_poly_resolves_at_index_zero() {
    dim_to_broken_closed_poly(&[(-5.5, 3.0), (-1.5, 8.5), (4.0, 2.0), (-5.5, 3.0)], (4.5, 3.0, 17.0, 9.0));
}

// Offset keeps a copy tied to its source, against the real solver.

fn ring_pulled_back(src: (f64, f64, f64), cpy: (f64, f64, f64)) {
    let ents = [circle("c1", src.0, src.1, src.2), circle("c2", cpy.0, cpy.1, cpy.2)];
    let r = solve(&ents, &cons(json!([{ "type": "offset", "pairs": [{ "src": "c1", "cpy": "c2" }], "value": 3 }])));
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    let (a, b) = (cir(find(&r.entities, "c1")), cir(find(&r.entities, "c2")));
    near((b.0 - a.0).hypot(b.1 - a.1), 0.0, digits(5));
    near(b.2 - a.2, 3.0, digits(5));
}

#[test]
fn offset_pulls_a_drifted_copy_back_to_concentric_at_the_gap() {
    ring_pulled_back((0.0, 0.0, 5.0), (0.7, -0.4, 7.1));
}

#[test]
fn offset_pulls_a_drifted_off_origin_copy_back_to_concentric_at_the_gap() {
    ring_pulled_back((-13.5, 8.25, 5.0), (-12.0, 9.5, 7.1));
}

fn copy_follows_upstream_radius(x: f64, y: f64) {
    let ents = [circle("c1", x, y, 5.0), circle("c2", x, y, 8.0)];
    let cs = cons(json!([
        { "type": "offset", "pairs": [{ "src": "c1", "cpy": "c2" }], "value": 3 },
        { "type": "radius", "e": "c1", "value": 9 },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    near(cir(find(&r.entities, "c1")).2, 9.0, digits(5));
    near(cir(find(&r.entities, "c2")).2, 12.0, digits(5));
}

#[test]
fn offset_copy_follows_an_upstream_radius_change() {
    copy_follows_upstream_radius(0.0, 0.0);
}

#[test]
fn offset_copy_off_origin_follows_an_upstream_radius_change() {
    copy_follows_upstream_radius(7.25, -11.5);
}

#[test]
fn offset_takes_a_negative_value_as_an_inward_offset() {
    let ents = [circle("c1", 0.0, 0.0, 5.0), circle("c2", 0.0, 0.0, 3.0)];
    let cs = cons(json!([
        { "type": "offset", "pairs": [{ "src": "c1", "cpy": "c2" }], "value": -2 },
        { "type": "radius", "e": "c1", "value": 10 },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    near(cir(find(&r.entities, "c2")).2, 8.0, digits(5));
}

/// A square of side 10 turned by `deg` and moved to `(ox, oy)`, with a sloppy inward copy, so the chain's
/// perpendicular distance is measured against a slanted source.
fn offset_chain(deg: f64, ox: f64, oy: f64) {
    let (s, c) = deg.to_radians().sin_cos();
    let at = |p: (f64, f64)| (ox + p.0 * c - p.1 * s, oy + p.0 * s + p.1 * c);
    let seg = |id: String, a: (f64, f64), b: (f64, f64)| {
        let (p, q) = (at(a), at(b));
        line(&id, p.0, p.1, q.0, q.1)
    };
    let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
    let mut ents: Vec<Entity> = (0..4).map(|k| seg(format!("s{k}"), square[k], square[(k + 1) % 4])).collect();
    let copy = [(1.4, 1.4), (8.7, 1.4), (8.7, 8.6), (1.3, 8.6)];
    ents.extend((0..4).map(|k| seg(format!("c{k}"), copy[k], copy[(k + 1) % 4])));
    let cs = cons(json!([
        { "type": "coincident", "e1": "c0", "p1": 1, "e2": "c1", "p2": 0 },
        { "type": "coincident", "e1": "c1", "p1": 1, "e2": "c2", "p2": 0 },
        { "type": "coincident", "e1": "c2", "p1": 1, "e2": "c3", "p2": 0 },
        { "type": "coincident", "e1": "c3", "p1": 1, "e2": "c0", "p2": 0 },
        { "type": "offset", "value": 2, "pairs": [
            { "src": "s0", "cpy": "c0" }, { "src": "s1", "cpy": "c1" },
            { "src": "s2", "cpy": "c2" }, { "src": "s3", "cpy": "c3" } ] },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok, "{r:?}");
    assert!(r.conflicts.is_empty());
    for k in 0..4 {
        let (s, c) = (ln_of(&r, &format!("s{k}")), ln_of(&r, &format!("c{k}")));
        let (dx, dy) = (s.2 - s.0, s.3 - s.1);
        let l = dx.hypot(dy);
        near(((c.0 - s.0) * dy - (c.1 - s.1) * dx).abs() / l, 2.0, digits(4));
        near(((c.2 - c.0) * dy - (c.3 - c.1) * dx).abs() / (l * l), 0.0, digits(4));
    }
}

#[test]
fn one_offset_value_governs_a_whole_four_line_chain() {
    offset_chain(0.0, 0.0, 0.0);
}

#[test]
fn one_offset_value_governs_a_slanted_off_origin_chain() {
    offset_chain(31.0, 13.5, -9.25);
}

#[test]
fn offset_survives_losing_one_copy_and_the_live_pair_still_holds() {
    let ents = [circle("c1", 0.0, 0.0, 5.0), circle("c2", 0.0, 0.0, 8.0)];
    let cs = cons(json!([{ "type": "offset", "value": 3, "pairs": [
        { "src": "c1", "cpy": "c2" }, { "src": "gone", "cpy": "alsogone" } ] }]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    near(cir(find(&r.entities, "c2")).2, 8.0, digits(5));
}

// A rotated rectangle survives the solver. It is pinned rigid, the axis rules would straighten it, and parallel sides
// plus a square corner leave the angle free.

fn rect_out(e: &Entity) -> (f64, f64, f64, f64, f64) {
    match e {
        Entity::Rectangle { x, y, width, height, angle, .. } => (*x, *y, *width, *height, *angle),
        other => panic!("not a rectangle: {other:?}"),
    }
}

fn rotated_rectangle_is_kept(x: f64, y: f64, angle: f64) {
    let mut e = rect("r1", x, y, 10.0, 4.0, angle);
    // Every edit re-solves, so a small error per pass is a rectangle that walks.
    for _ in 0..6 {
        e = solve(std::slice::from_ref(&e), &[]).entities.remove(0);
        let (ox, oy, w, h, a) = rect_out(&e);
        near(a, angle, digits(6));
        near(w, 10.0, digits(6));
        near(h, 4.0, digits(6));
        near(ox, x, digits(6));
        near(oy, y, digits(6));
    }
}

#[test]
fn rotated_rectangle_keeps_its_angle_size_and_place_across_repeated_solves() {
    rotated_rectangle_is_kept(-7.0, 2.0, 37.5);
}

#[test]
fn rotated_rectangle_with_a_negative_angle_keeps_its_angle_size_and_place() {
    rotated_rectangle_is_kept(11.25, -6.5, -143.2);
}

fn rigid_against_other_constraints(x: f64, y: f64, angle: f64) {
    let ents = [rect("r1", x, y, 10.0, 4.0, angle), line("u", 0.0, 0.0, 10.0, 0.0)];
    let cs = cons(json!([
        { "type": "distance", "id": "k0", "line": "u", "value": 25 },
        { "type": "vertical", "line": "u" },
    ]));
    let r = solve(&ents, &cs);
    let (_, _, w, h, a) = rect_out(&r.entities[0]);
    near(a, angle, digits(9));
    near(w, 10.0, digits(9));
    near(h, 4.0, digits(9));
}

#[test]
fn rotated_rectangle_is_rigid_against_another_entitys_constraints() {
    rigid_against_other_constraints(-7.0, 2.0, 37.5);
}

#[test]
fn a_steeply_turned_off_origin_rectangle_is_rigid_against_another_entitys_constraints() {
    rigid_against_other_constraints(14.5, -9.0, 112.5);
}

#[test]
fn an_axis_aligned_rectangle_stays_exactly_as_it_was() {
    let e = rect("r1", -7.0, 2.0, 10.0, 4.0, 0.0);
    let r = solve(std::slice::from_ref(&e), &[]);
    assert_eq!(r.entities[0], e);
}

#[test]
fn no_angle_is_written_into_a_plain_rectangle_document_entity() {
    let doc: fundacad_core::schema::sketch::SketchEntity =
        serde_json::from_value(json!({ "type": "rectangle", "id": "r1", "x": -7, "y": 2, "width": 10, "height": 4 })).unwrap();
    let ents = resolve_entities(std::slice::from_ref(&doc), &|_| None);
    let solved = solve(&ents, &[]);
    let out = serde_json::to_value(write_back(&doc, &solved.entities[0])).unwrap();
    assert!(out.get("angle").is_none(), "{out}");
}

#[test]
fn the_axis_rules_still_straighten_a_rectangle_that_has_no_angle() {
    let e = rect("r1", -7.0, 2.0, 10.0, 4.0, 0.0);
    let r = solve(&[e], &cons(json!([{ "type": "distance", "id": "k0", "line": "r1~1", "value": 9 }])));
    let (_, _, w, h, _) = rect_out(&r.entities[0]);
    near(h, 9.0, digits(4));
    near(w, 10.0, digits(4));
}

#[test]
fn an_off_origin_axis_aligned_rectangle_takes_a_typed_height() {
    let e = rect("r1", 18.5, -12.25, 10.0, 4.0, 0.0);
    let r = solve(&[e], &cons(json!([{ "type": "distance", "line": "r1~1", "value": 9 }])));
    let (_, _, w, h, _) = rect_out(&r.entities[0]);
    near(h, 9.0, digits(4));
    near(w, 10.0, digits(4));
}

// Coincident reaches a circle centre and a rectangle corner, they used to resolve to nothing and the constraint was
// dropped silently.

fn circle_centre_on_a_rectangle_corner(rx: f64, ry: f64, cx: f64, cy: f64) {
    let corner3 = rect_corners(rx, ry, 20.0, 10.0, 0.0)[3];
    let ents = [rect("r1", rx, ry, 20.0, 10.0, 0.0), circle("c1", cx, cy, 5.0)];
    // Two opposite corners pin the rectangle, so the circle's centre is the only freedom left.
    let cs = cons(json!([
        { "type": "fix", "e": "r1", "p": 1 },
        { "type": "fix", "e": "r1", "p": 3 },
        { "type": "diameter", "circle": "c1", "value": 10 },
        { "type": "coincident", "e1": "c1", "p1": 0, "e2": "r1", "p2": 3 },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    assert_eq!(r.dof, 0);
    let c = cir(find(&r.entities, "c1"));
    near(c.0, corner3.x, digits(6));
    near(c.1, corner3.y, digits(6));
}

#[test]
fn a_circle_centre_is_pulled_onto_a_rectangle_corner() {
    circle_centre_on_a_rectangle_corner(0.0, 0.0, 50.0, 50.0);
}

#[test]
fn a_circle_centre_is_pulled_onto_an_off_origin_rectangle_corner() {
    circle_centre_on_a_rectangle_corner(12.5, -7.25, -30.0, 41.5);
}

fn two_centres_together(a: (f64, f64), b: (f64, f64)) {
    let ents = [circle("c1", a.0, a.1, 5.0), circle("c2", b.0, b.1, 3.0)];
    let r = solve(&ents, &cons(json!([{ "type": "coincident", "e1": "c1", "p1": 0, "e2": "c2", "p2": 0 }])));
    assert!(r.ok);
    let (a, b) = (cir(find(&r.entities, "c1")), cir(find(&r.entities, "c2")));
    near(a.0, b.0, digits(6));
    near(a.1, b.1, digits(6));
}

#[test]
fn two_circle_centres_are_pulled_together_by_a_plain_coincident() {
    two_centres_together((0.0, 0.0), (30.0, 30.0));
}

#[test]
fn two_off_origin_circle_centres_are_pulled_together_by_a_plain_coincident() {
    two_centres_together((-14.5, 6.25), (33.0, -21.5));
}

fn point_onto_an_arc_centre(centre: (f64, f64), r: f64, start: f64, end: f64, p: (f64, f64)) {
    let ents = [arc_at("a1", centre.0, centre.1, r, start, end, false), pt("p1", p.0, p.1)];
    let cs = cons(json!([
        { "type": "fix", "e": "a1", "p": 2 },
        { "type": "coincident", "e1": "p1", "p1": 0, "e2": "a1", "p2": 2 },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    let q = pnt(find(&r.entities, "p1"));
    near(q.0, centre.0, 1e-3);
    near(q.1, centre.1, 1e-3);
}

#[test]
fn a_point_is_pulled_onto_an_arc_centre_not_the_arcs_end() {
    point_onto_an_arc_centre((0.0, 0.0), 10.0, 0.0, std::f64::consts::FRAC_PI_2, (40.0, 40.0));
}

#[test]
fn a_point_is_pulled_onto_the_centre_of_an_off_origin_three_quarter_arc() {
    point_onto_an_arc_centre((-9.5, 14.25), 7.5, -0.6, 3.9, (40.0, -20.0));
}

// A corner pinned to the origin stays put under an unrelated dim.

fn origin_pinned_rect(ox: f64, oy: f64) {
    let ents = [pt("o", ox, oy), rect("r1", ox + 25.0, oy + 10.0, 50.0, 20.0, 0.0), circle("c1", ox + 12.0, oy + 6.0, 3.0)];
    let cs = cons(json!([
        { "type": "fix", "e": "o", "p": 0 },
        { "type": "distance", "line": "r1~0", "value": 50 },
        { "type": "distance", "line": "r1~1", "value": 20 },
        { "type": "p2lDistance", "e": "c1", "p": 0, "line": "r1~3", "value": 15 },
    ]));
    let r = solve(&ents, &cs);
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    let (x, y, w, h, _) = rect_out(find(&r.entities, "r1"));
    near(x, ox + 25.0, digits(6));
    near(y, oy + 10.0, digits(6));
    near(w, 50.0, digits(6));
    near(h, 20.0, digits(6));
    near(cir(find(&r.entities, "c1")).0, ox + 15.0, digits(6));
}

#[test]
fn a_dim_to_the_edge_moves_the_circle_not_the_rectangle_pinned_to_the_origin() {
    origin_pinned_rect(0.0, 0.0);
}

#[test]
fn a_dim_to_the_edge_moves_the_circle_not_the_rectangle_pinned_off_origin() {
    origin_pinned_rect(-13.5, 8.25);
}

fn corner_merges_with_a_fixed_point(ox: f64, oy: f64) {
    let ents = [pt("o", ox, oy), rect("r1", ox + 25.0, oy + 10.0, 50.0, 20.0, 0.0)];
    let r = solve(&ents, &cons(json!([{ "type": "fix", "e": "o", "p": 0 }])));
    assert!(r.ok);
    // Two free corners are 4 DOF, minus the 2 the fixed corner removes. Width and height stay free, which is what
    // sharing the point's solver id predicts.
    assert_eq!(r.dof, 2);
    let (x, y, ..) = rect_out(find(&r.entities, "r1"));
    near(x, ox + 25.0, digits(6));
    near(y, oy + 10.0, digits(6));
}

#[test]
fn the_corner_merges_with_the_origin_point_instead_of_adding_a_second_point() {
    corner_merges_with_a_fixed_point(0.0, 0.0);
}

#[test]
fn the_corner_merges_with_a_fixed_point_off_origin() {
    corner_merges_with_a_fixed_point(-13.5, 8.25);
}

// A rectangle's typed width and height hold its free corner.

fn typed_width_and_height(ox: f64, oy: f64) {
    let ents = [rect("r1", ox + 10.0, oy + 10.0, 20.0, 20.0, 0.0), pt("o", ox, oy)];
    let fix = json!({ "type": "fix", "e": "o", "p": 0 });
    let cs = cons(json!([fix, { "type": "distance", "line": "r1~0", "value": 42 }, { "type": "distance", "line": "r1~1", "value": 42 }]));
    assert_eq!(solve(&ents, &cons(json!([fix]))).dof, 2);
    let r = solve(&ents, &cs);
    assert!(r.ok);
    assert_eq!(r.dof, 0);
    let (x, y, w, h, _) = rect_out(&r.entities[0]);
    near(x, ox + 21.0, 1e-9);
    near(y, oy + 21.0, 1e-9);
    near(w, 42.0, 1e-9);
    near(h, 42.0, 1e-9);
}

#[test]
fn typed_width_and_height_hold_the_corner_on_the_origin_and_grow_the_far_side() {
    typed_width_and_height(0.0, 0.0);
}

#[test]
fn typed_width_and_height_hold_a_corner_pinned_off_origin() {
    typed_width_and_height(-8.5, 12.25);
}

// A typed line length keeps a rectangle drawn as four lines square.

fn frame() -> Vec<Entity> {
    vec![
        line("e1", 0.0, 0.0, 20.0, 0.0),
        line("e2", 20.0, 0.0, 20.0, 40.0),
        line("e3", 20.0, 40.0, 0.0, 40.0),
        line("e4", 0.0, 40.0, 0.0, 0.0),
    ]
}

fn lengths(ents: &[Entity]) -> Vec<f64> {
    ents.iter().map(|e| len(ln(e))).collect()
}

#[test]
fn a_plain_solve_skews_the_two_neighbours_which_is_what_the_held_solve_is_for() {
    let r = solve(&frame(), &cons(json!([{ "type": "distance", "line": "e2", "value": 45 }])));
    let l = lengths(&r.entities);
    assert!((l[0] - 20.0).abs() + (l[2] - 20.0).abs() > 0.01);
}

#[test]
fn a_held_solve_moves_only_the_far_side_and_the_start_stays_put() {
    let cs = cons(json!([{ "type": "distance", "line": "e2", "value": 45 }]));
    let r = solve_keeping_axes(&frame(), &cs, Some(v(20.0, 0.0))).unwrap();
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    let l = lengths(&r.entities);
    near(l[0], 20.0, 1e-9);
    near(l[1], 45.0, 1e-9);
    near(l[2], 20.0, 1e-9);
    near(l[3], 45.0, 1e-9);
    let e2 = ln(&r.entities[1]);
    assert_eq!((e2.0, e2.1, e2.2), (20.0, 0.0, 20.0));
    near(e2.3, 45.0, 1e-9);
    assert_eq!(r.dof, 7);
}

#[test]
fn a_held_solve_on_a_frame_off_origin_moves_only_the_far_side() {
    let ents = [
        line("e1", 12.5, -8.0, 32.5, -8.0),
        line("e2", 32.5, -8.0, 32.5, 32.0),
        line("e3", 32.5, 32.0, 12.5, 32.0),
        line("e4", 12.5, 32.0, 12.5, -8.0),
    ];
    let cs = cons(json!([{ "type": "distance", "line": "e2", "value": 45 }]));
    let r = solve_keeping_axes(&ents, &cs, Some(v(32.5, -8.0))).unwrap();
    assert!(r.ok && r.conflicts.is_empty());
    let l = lengths(&r.entities);
    near(l[0], 20.0, 1e-9);
    near(l[1], 45.0, 1e-9);
    near(l[3], 45.0, 1e-9);
    let e2 = ln(&r.entities[1]);
    assert_eq!((e2.0, e2.1, e2.2), (32.5, -8.0, 32.5));
    near(e2.3, 37.0, 1e-9);
    assert_eq!(r.dof, 7);
}

fn box_of(ents: &[Entity]) -> [f64; 4] {
    let ls: Vec<_> = ents.iter().map(ln).collect();
    let xs = ls.iter().flat_map(|l| [l.0, l.2]);
    let ys = ls.iter().flat_map(|l| [l.1, l.3]);
    let r = |x: f64| (x * 1e6).round() / 1e6;
    [
        r(xs.clone().fold(f64::INFINITY, f64::min)),
        r(ys.clone().fold(f64::INFINITY, f64::min)),
        r(xs.fold(f64::NEG_INFINITY, f64::max)),
        r(ys.fold(f64::NEG_INFINITY, f64::max)),
    ]
}

#[test]
fn the_same_frame_grows_from_the_same_corner_whichever_way_it_was_drawn() {
    let ccw = [
        line("a", 10.0, 10.0, 30.0, 10.0),
        line("b", 30.0, 10.0, 30.0, 50.0),
        line("c", 30.0, 50.0, 10.0, 50.0),
        line("d", 10.0, 50.0, 10.0, 10.0),
    ];
    let cw = [
        line("a", 10.0, 10.0, 10.0, 50.0),
        line("b", 10.0, 50.0, 30.0, 50.0),
        line("c", 30.0, 50.0, 30.0, 10.0),
        line("d", 30.0, 10.0, 10.0, 10.0),
    ];
    // The anchor is the dimensioned side's lower end, what the app's dimAnchor hands over.
    for (ents, right) in [(&ccw, "b"), (&cw, "c")] {
        let cs = cons(json!([{ "type": "distance", "line": right, "value": 60 }]));
        let r = solve_keeping_axes(ents, &cs, Some(v(30.0, 10.0))).unwrap();
        assert!(r.conflicts.is_empty());
        assert_eq!(box_of(&r.entities), [10.0, 10.0, 30.0, 70.0]);
    }
}

fn falls_back_when_a_line_has_to_turn(a: L, b: L) {
    let two = [line("a", a.0, a.1, a.2, a.3), line("b", b.0, b.1, b.2, b.3)];
    let cs = cons(json!([
        { "type": "parallel", "l1": "a", "l2": "b" },
        { "type": "distance", "line": "a", "value": 12 },
    ]));
    let r = solve_keeping_axes(&two, &cs, Some(v(a.0, a.1))).unwrap();
    assert!(r.ok);
    assert!(r.conflicts.is_empty());
    let (a, b) = (ln(&r.entities[0]), ln(&r.entities[1]));
    assert!(((a.2 - a.0) * (b.3 - b.1) - (a.3 - a.1) * (b.2 - b.0)).abs() < 1e-6);
    near(len(a), 12.0, digits(6));
}

#[test]
fn the_held_solve_falls_back_to_the_plain_solve_when_a_line_has_to_turn() {
    falls_back_when_a_line_has_to_turn((0.0, 0.0, 10.0, 0.0), (20.0, 0.0, 20.0, 10.0));
}

#[test]
fn the_held_solve_falls_back_for_slanted_off_origin_lines_that_have_to_turn() {
    falls_back_when_a_line_has_to_turn((3.0, -2.0, 11.0, 4.0), (20.5, 1.0, 26.0, 9.0));
}

#[test]
fn a_closed_sketchs_rotated_rectangle_keeps_its_angle_through_the_headless_solve() {
    let doc: fundacad_core::schema::sketch::SketchEntity =
        serde_json::from_value(json!({ "type": "rectangle", "id": "r1", "width": 10, "height": 4, "x": 3, "y": -2, "angle": 30 }))
            .unwrap();
    let ents = resolve_entities(std::slice::from_ref(&doc), &|_| None);
    let r = solve_keeping_axes(&ents, &[], None).unwrap();
    assert!(r.ok && r.conflicts.is_empty());
    let out = write_back(&doc, &r.entities[0]);
    let (_, _, w, h, a) = rect_out(&resolve_entities(&[out], &|_| None)[0]);
    near(a, 30.0, digits(6));
    near(w, 10.0, digits(6));
    near(h, 4.0, digits(6));
}
