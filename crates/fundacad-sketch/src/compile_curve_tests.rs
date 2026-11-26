//! FundaCAD 1's coincidence.test.ts, bsplineSolve.test.ts and projectedArcSolve.test.ts: joins by position, control
//! point poles as solver points, and geometry tied to a projected arc.

use serde_json::{json, Value};

use crate::compile::{compile_and_solve, solve_keeping_axes, DragReq, SolveOpts};
use crate::geom::{pole_ref, v, V};
use crate::model::Entity;
use crate::test_fixtures::*;

// A drawn chain is joined by position, not by a constraint.

fn triangle(dx: f64, dy: f64) -> Vec<Entity> {
    vec![
        line("e1", 20.0 + dx, dy, 26.0 + dx, 2.0 + dy),
        line("e2", 26.0 + dx, 2.0 + dy, 20.0 + dx, 5.0 + dy),
        line("e3", 20.0 + dx, 5.0 + dy, 20.0 + dx, dy),
    ]
}

#[test]
fn a_closed_triangle_has_three_points_worth_of_freedom_not_six() {
    let r = solve(&triangle(0.0, 0.0), &[]);
    assert!(r.ok);
    assert_eq!(r.dof, 6);
}

#[test]
fn a_closed_triangle_in_the_negative_quadrant_has_the_same_freedom() {
    let r = solve(&triangle(-61.5, -19.25), &[]);
    assert!(r.ok);
    assert_eq!(r.dof, 6);
}

// The control: one corner a hundredth of a millimetre apart, past the 0.001 bucket, is four points.
#[test]
fn a_chain_whose_corners_miss_carries_the_extra_freedom() {
    let apart = [
        line("e1", 20.0, 0.0, 26.0, 2.0),
        line("e2", 26.01, 2.0, 20.0, 5.0),
        line("e3", 20.0, 5.0, 20.0, 0.0),
    ];
    let r = solve(&apart, &[]);
    assert!(r.ok);
    assert_eq!(r.dof, 8);
}

#[test]
fn a_recorded_coincident_on_a_corner_that_already_merged_is_absorbed() {
    for (dx, dy) in [(0.0, 0.0), (-61.5, -19.25)] {
        let r = solve(&triangle(dx, dy), &cons(json!([{ "type": "coincident", "e1": "e1", "p1": 1, "e2": "e2", "p2": 0 }])));
        assert_eq!(r.dof, 6);
        assert!(r.over_defined.is_empty());
        assert!(r.conflicts.is_empty());
    }
}

// Every pole of a control point spline is a solver point.

const POLES: [(f64, f64); 5] = [(0.0, 0.0), (10.0, 20.0), (25.0, -10.0), (40.0, 15.0), (50.0, 0.0)];

fn poles(dx: f64, dy: f64) -> Vec<V> {
    POLES.iter().map(|&(x, y)| v(x + dx, y + dy)).collect()
}

fn curve(closed: bool, dx: f64, dy: f64) -> Entity {
    Entity::Bspline { id: "b".into(), poles: poles(dx, dy), closed }
}

fn poles_of(e: &Entity) -> Vec<V> {
    match e {
        Entity::Bspline { poles, .. } => poles.clone(),
        other => panic!("not a bspline: {other:?}"),
    }
}

fn dist(a: V, b: V) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}

#[test]
fn every_bspline_pole_is_a_reference_point_with_ends_at_0_and_1() {
    let refs = curve(false, 0.0, 0.0).dim_ref_points();
    assert_eq!(refs.iter().map(|r| r.0).collect::<Vec<_>>(), [0, 2, 3, 4, 1]);
    assert_eq!(refs[1].1.x, 10.0);
}

fn drive_an_interior_pole(dx: f64, dy: f64) {
    let cs = cons(json!([
        { "type": "fix", "e": "b", "p": 0 },
        { "type": "p2pDistance", "id": "d", "e1": "b", "p1": 0, "e2": "b", "p2": pole_ref(2, 5), "value": 40 },
    ]));
    let r = solve(&[curve(false, dx, dy)], &cs);
    assert!(r.ok);
    let out = poles_of(&r.entities[0]);
    assert_eq!(out[0], v(dx, dy));
    near(dist(out[0], out[2]), 40.0, digits(6));
    assert_eq!(out[1], poles(dx, dy)[1]);
}

#[test]
fn an_interior_pole_is_driven_by_a_point_to_point_dimension() {
    drive_an_interior_pole(0.0, 0.0);
}

#[test]
fn an_interior_pole_of_an_off_origin_curve_is_driven_by_a_point_to_point_dimension() {
    drive_an_interior_pole(-33.0, 17.5);
}

fn hold_a_pole_while_another_drags(dx: f64, dy: f64) {
    let cs = cons(json!([{ "type": "fix", "e": "b", "p": pole_ref(1, 5) }]));
    let drag = DragReq { from: v(25.0 + dx, -10.0 + dy), to: v(30.0 + dx, -30.0 + dy) };
    let r = compile_and_solve(&[curve(true, dx, dy)], &cs, Some(drag), &SolveOpts::default()).unwrap();
    let out = poles_of(&r.entities[0]);
    assert_eq!(out[1], poles(dx, dy)[1]);
    assert!(dist(out[2], v(30.0 + dx, -30.0 + dy)) < 1e-6);
}

#[test]
fn a_fixed_interior_pole_holds_while_another_is_dragged() {
    hold_a_pole_while_another_drags(0.0, 0.0);
}

#[test]
fn a_fixed_interior_pole_holds_while_another_is_dragged_off_origin() {
    hold_a_pole_while_another_drags(-33.0, 17.5);
}

fn join_the_end_not_an_interior_pole(dx: f64, dy: f64) {
    let l = line("l", 50.0 + dx, dy, 50.0 + dx, -20.0 + dy);
    let m = line("m", 10.0 + dx, 20.0 + dy, dx, 30.0 + dy);
    let drag = DragReq { from: v(50.0 + dx, dy), to: v(55.0 + dx, 5.0 + dy) };
    let r = compile_and_solve(&[curve(false, dx, dy), l, m], &[], Some(drag), &SolveOpts::default()).unwrap();
    near(poles_of(&r.entities[0])[4].x, 55.0 + dx, digits(6));
    near(ln(&r.entities[1]).0, 55.0 + dx, digits(6));
    // The interior pole sat on m's end without joining it.
    assert_eq!(ln(&r.entities[2]).0, 10.0 + dx);
}

#[test]
fn an_open_curves_end_joins_a_line_but_never_an_interior_pole() {
    join_the_end_not_an_interior_pole(0.0, 0.0);
}

#[test]
fn an_open_curves_end_joins_a_line_but_never_an_interior_pole_off_origin() {
    join_the_end_not_an_interior_pole(-33.0, 17.5);
}

#[test]
fn a_pole_moves_when_the_value_of_its_dimension_changes() {
    let entities = json!([{ "type": "bspline", "id": "b", "poles": POLES.iter().map(|&(x, y)| json!({ "x": x, "y": y })).collect::<Vec<_>>() }]);
    let pole_at = |reach: f64| {
        let constraints = json!([
            { "type": "fix", "e": "b", "p": 0 },
            { "type": "fix", "e": "b", "p": 1 },
            { "type": "p2pDistance", "id": "d", "e1": "b", "p1": 0, "e2": "b", "p2": pole_ref(3, 5), "value": reach },
        ]);
        poles_of(&headless_solve(entities.clone(), constraints).expect("solves").remove(0))
    };
    let a = pole_at(30.0);
    near(dist(a[0], a[3]), 30.0, digits(6));
    let b = pole_at(45.0);
    near(dist(b[0], b[3]), 45.0, digits(6));
    assert_eq!(b[4], poles(0.0, 0.0)[4]);
}

// Geometry tied to a projected arc, the arc is rigid reference, never a conflict.

fn r6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

/// Radius `r` about (cx, cy) counterclockwise from a0 to a1, rounded to 6 decimals like an engine projection.
fn projected_arc(cx: f64, cy: f64, r: f64, a0: f64, a1: f64) -> Entity {
    let at = |a: f64| (r6(cx + r * a.cos()), r6(cy + r * a.sin()));
    let (s, e, m) = (at(a0), at(a1), at((a0 + a1) / 2.0));
    pa("Rp", s.0, s.1, e.0, e.1, m.0, m.1)
}

fn rp() -> Entity {
    projected_arc(150.0, 60.0, 5.0, -0.4, 2.2)
}

fn on_arc(dx: f64) -> Value {
    json!([
        { "type": "hDistance", "e1": "Rp", "p1": 2, "e2": "q", "p2": 0, "value": dx },
        { "type": "pointOnCurve", "e": "q", "p": 0, "curve": "Rp" },
    ])
}

#[test]
fn a_projected_arc_on_its_own_is_neither_over_defined_nor_in_conflict() {
    let r = solve(&[rp()], &[]);
    assert_eq!(r.entities, vec![rp()]);
    assert_pass(&r, 0, true, &[], &[]);
}

#[test]
fn a_projected_arc_holds_a_point_put_on_it() {
    let r = solve(&[rp(), pt("q", 154.0, 64.0)], &cons(on_arc(3.0)));
    entities_near(&r.entities, &[rp(), pt("q", 153.0, 64.0)], 5e-6);
    assert_pass(&r, 0, true, &[], &[]);
}

#[test]
fn a_negative_quadrant_projected_arc_holds_a_point_put_on_it() {
    let arc = projected_arc(-35.0, -20.0, 7.0, 2.2, 5.5);
    let r = solve(&[arc.clone(), pt("q", -31.8, -26.5)], &cons(on_arc(3.0)));
    let want_y = -20.0 - (49.0f64 - 9.0).sqrt();
    entities_near(&r.entities, &[arc, pt("q", -32.0, want_y)], 5e-6);
    assert_pass(&r, 0, true, &[], &[]);
}

#[test]
fn a_projected_arc_holds_a_tangent_line_without_a_conflict() {
    // b starts fixed at (140,72) with length 6, tangency to the arc settles its end.
    let b = line("b", 140.0, 72.0, 146.0, 70.0);
    let cs = cons(json!([
        { "type": "fix", "e": "b", "p": 0 },
        { "type": "distance", "line": "b", "value": 6 },
        { "type": "tangent2", "a": "b", "b": "Rp" },
    ]));
    let r = solve(&[rp(), b], &cs);
    let s = ln(&r.entities[1]);
    let (dx, dy) = (s.2 - s.0, s.3 - s.1);
    let centre_to_line = ((150.0 - s.0) * dy - (60.0 - s.1) * dx).abs() / dx.hypot(dy);
    assert_eq!(r.entities[0], rp());
    near(s.0, 140.0, 5e-6);
    near(s.1, 72.0, 5e-6);
    near(dx.hypot(dy), 6.0, 5e-6);
    near(centre_to_line, 5.0, 5e-6);
    assert_pass(&r, 0, true, &[], &[]);
}

#[test]
fn a_dragged_point_slides_along_a_projected_arc() {
    let cs = cons(json!([{ "type": "pointOnCurve", "e": "q", "p": 0, "curve": "Rp" }]));
    let drag = DragReq { from: v(154.0, 63.0), to: v(147.0, 66.0) };
    let r = compile_and_solve(&[rp(), pt("q", 154.0, 63.0)], &cs, Some(drag), &SolveOpts::default()).unwrap();
    let q = pnt(&r.entities[1]);
    assert!(r.ok);
    assert!(r.conflicts.is_empty() && r.over_defined.is_empty(), "{r:?}");
    near((q.0 - 150.0).hypot(q.1 - 60.0), 5.0, digits(6));
    assert!(q.1 > 63.0);
}

#[test]
fn a_document_sketch_with_a_projected_arc_re_solves_after_its_dimension_changed() {
    let Entity::Projected { curve: crate::model::Curve::Arc { x1, y1, x2, y2, mx, my }, .. } = rp() else { unreachable!() };
    let entities = json!([
        { "type": "projected", "id": "Rp", "source": { "kind": "sketchCurve", "sketch": "s0", "entity": "e0" },
          "curve": { "kind": "arc", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "mx": mx, "my": my } },
        { "type": "point", "id": "q", "x": 154, "y": 64 },
    ]);
    let solved = headless_solve(entities, on_arc(4.0)).expect("solves");
    entities_near(&solved, &[rp(), pt("q", 154.0, 63.0)], 5e-6);
}

#[test]
fn a_user_arc_fixed_at_its_centre_and_both_ends_holds_a_point_put_on_it() {
    let Entity::Projected { curve: crate::model::Curve::Arc { x1, y1, x2, y2, mx, my }, .. } = rp() else { unreachable!() };
    let a = arc("Rp", x1, y1, x2, y2, mx, my);
    let mut cs = vec![
        json!({ "type": "fix", "e": "Rp", "p": 0 }),
        json!({ "type": "fix", "e": "Rp", "p": 1 }),
        json!({ "type": "fix", "e": "Rp", "p": 2 }),
    ];
    cs.extend(on_arc(3.0).as_array().unwrap().iter().cloned());
    let r = solve(&[a.clone(), pt("q", 154.0, 64.0)], &cons(Value::Array(cs)));
    entities_near(&r.entities, &[a, pt("q", 153.0, 64.0)], 5e-6);
    assert_pass(&r, 0, true, &[], &[]);
}

#[test]
fn a_negative_quadrant_user_arc_fixed_at_its_centre_and_both_ends_holds_a_point_put_on_it() {
    let Entity::Projected { curve: crate::model::Curve::Arc { x1, y1, x2, y2, mx, my }, .. } =
        projected_arc(-35.0, -20.0, 7.0, 2.2, 5.5)
    else {
        unreachable!()
    };
    let a = arc("Rp", x1, y1, x2, y2, mx, my);
    let mut cs = vec![
        json!({ "type": "fix", "e": "Rp", "p": 0 }),
        json!({ "type": "fix", "e": "Rp", "p": 1 }),
        json!({ "type": "fix", "e": "Rp", "p": 2 }),
    ];
    cs.extend(on_arc(3.0).as_array().unwrap().iter().cloned());
    let r = solve(&[a.clone(), pt("q", -31.8, -26.5)], &cons(Value::Array(cs)));
    entities_near(&r.entities, &[a, pt("q", -32.0, -20.0 - 40.0f64.sqrt())], 5e-6);
    assert_pass(&r, 0, true, &[], &[]);
}

#[test]
fn solve_keeping_axes_leaves_a_projected_arc_sketch_without_a_conflict() {
    let r = solve_keeping_axes(&[rp(), pt("q", 154.0, 64.0)], &cons(on_arc(3.0)), None).unwrap();
    assert!(r.ok && r.conflicts.is_empty());
}
