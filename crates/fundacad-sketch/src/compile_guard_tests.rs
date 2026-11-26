//! FundaCAD 1's solveGuards.test.ts: the rim branch and bad radius guards, rotated rectangle read-back and collinear.

use serde_json::{json, Value};

use crate::geom::{rect_corners, rect_from_three_points, v};
use crate::model::{Constraint, Entity};
use crate::test_fixtures::*;

fn with_fixed_line(e: &str, rest: Value) -> Vec<Constraint> {
    let mut all = vec![json!({ "type": "fix", "e": e, "p": 0 }), json!({ "type": "fix", "e": e, "p": 1 })];
    all.extend(rest.as_array().unwrap().iter().cloned());
    cons(Value::Array(all))
}

/// `l` runs from `a` to `b` and the circle sits on its midpoint, `t` along the normal, c2lDistance asks for -1.
fn centre_on_a_line(a: (f64, f64), b: (f64, f64), t: f64) {
    let l = line("l", a.0, a.1, b.0, b.1);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let h = dx.hypot(dy);
    let n = (-dy / h, dx / h);
    let m = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let cs = with_fixed_line(
        "l",
        json!([{ "type": "radius", "e": "c", "value": 2 }, { "type": "c2lDistance", "circle": "c", "line": "l", "value": -1 }]),
    );
    let c = circle("c", m.0 + t * n.0, m.1 + t * n.1, 2.0);
    let r = solve(&[l.clone(), c], &cs);
    let s = cir(&r.entities[1]);
    let dist = (s.0 - m.0) * n.0 + (s.1 - m.1) * n.1;
    if t < 0.0 {
        assert!(dist < 0.0, "{dist}");
    }
    assert_eq!(r.entities[0], l);
    near(dist.abs(), 1.0, digits(9));
    near(s.2, 2.0, digits(9));
    assert_pass(&r, 1, true, &[], &[]);
}

#[test]
fn a_c2l_distance_solve_accepts_a_centre_exactly_on_the_line() {
    centre_on_a_line((2.0, 1.0), (12.0, 6.0), 0.0);
}

#[test]
fn a_c2l_distance_solve_accepts_a_centre_within_1e_9_of_the_line() {
    centre_on_a_line((2.0, 1.0), (12.0, 6.0), 4e-10);
}

#[test]
fn a_c2l_distance_solve_accepts_a_centre_clearly_on_one_side() {
    centre_on_a_line((2.0, 1.0), (12.0, 6.0), -0.25);
}

#[test]
fn a_c2l_distance_solve_accepts_a_centre_on_a_line_in_another_quadrant() {
    centre_on_a_line((-14.5, -3.25), (-4.0, -19.0), 0.25);
    centre_on_a_line((-14.5, -3.25), (-4.0, -19.0), -0.25);
}

/// The circle starts 0.5 on one side of `l` and is welded to a point 0.5 on the other.
fn hop_across_a_line(a: (f64, f64), b: (f64, f64)) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let h = dx.hypot(dy);
    let n = (-dy / h, dx / h);
    let m = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let l = line("l", a.0, a.1, b.0, b.1);
    let q = pt("q", m.0 - 0.5 * n.0, m.1 - 0.5 * n.1);
    let c = circle("c", m.0 + 0.5 * n.0, m.1 + 0.5 * n.1, 2.0);
    let cs = with_fixed_line(
        "l",
        json!([
            { "type": "c2lDistance", "circle": "c", "line": "l", "value": -1 },
            { "type": "fix", "e": "q", "p": 0 },
            { "type": "coincident", "e1": "c", "p1": 0, "e2": "q", "p2": 0 },
        ]),
    );
    let ents = [l, q, c];
    let r = solve(&ents, &cs);
    assert_eq!(r.entities, ents.to_vec());
    assert_pass(&r, 0, false, &["k2"], &[]);
}

#[test]
fn a_solve_that_moves_the_centre_from_one_side_of_a_line_to_the_other_is_refused() {
    hop_across_a_line((2.0, 1.0), (12.0, 6.0));
}

#[test]
fn a_hop_across_an_off_origin_line_is_refused_too() {
    hop_across_a_line((-9.0, 4.0), (6.5, -11.0));
}

// A rotated rectangle keeps its fields exactly through solves.

#[test]
fn a_rotated_rectangle_comes_back_unchanged_from_one_solve_and_from_many() {
    let r0 = rect("r", 5.3, -2.7, 10.0, 4.0, 200.0);
    let mut ents = vec![r0.clone()];
    for _ in 0..4 {
        let r = solve(&ents, &[]);
        assert_eq!(r.entities, vec![r0.clone()]);
        assert_pass(&r, 0, true, &[], &[]);
        ents = r.entities;
    }
}

#[test]
fn a_rotated_rectangle_with_a_merged_corner_is_read_back_from_its_corners() {
    let r0 = rect("r", 5.3, -2.7, 10.0, 4.0, 200.0);
    let [c0, c1, c2, _] = rect_corners(5.3, -2.7, 10.0, 4.0, 200.0);
    let p = v((c0.x * 1000.0).round() / 1000.0, (c0.y * 1000.0).round() / 1000.0);
    let ln0 = line("ln", p.x, p.y, 20.5, 9.1);
    let r = solve(&[ln0.clone(), r0.clone()], &[]);
    let rec = rect_from_three_points(p, c1, c2).unwrap();
    assert_eq!(r.entities[0], ln0);
    assert_eq!(r.entities[1], rect("r", rec.x, rec.y, rec.width, rec.height, rec.angle));
    assert_ne!(r.entities[1], r0);
}

// Collinear on lines that share a point adds one equation.

fn offset_from(a: (f64, f64, f64, f64), x: f64, y: f64) -> f64 {
    ((x - a.0) * (a.3 - a.1) - (y - a.1) * (a.2 - a.0)) / (a.2 - a.0).hypot(a.3 - a.1)
}

fn collinear_adds_one_equation(a: Entity, b: Entity, dof: i32) {
    let cs = cons(json!([{ "type": "collinear", "l1": "a", "l2": "b" }]));
    let first = solve(&[a, b], &cs);
    let again = solve(&first.entities, &cs);
    for r in [&first, &again] {
        assert_pass(r, dof, true, &[], &[]);
        let (sa, sb) = (ln(&r.entities[0]), ln(&r.entities[1]));
        for off in [offset_from(sa, sb.0, sb.1), offset_from(sa, sb.2, sb.3)] {
            near(off, 0.0, 1e-9);
        }
    }
}

#[test]
fn collinear_on_lines_sharing_bs_start_has_dof_5_and_nothing_over_defined() {
    collinear_adds_one_equation(line("a", 1.5, -2.0, 11.5, 0.5), line("b", 11.5, 0.5, 21.0, 3.8), 5);
}

#[test]
fn collinear_on_lines_sharing_bs_end_has_dof_5_and_nothing_over_defined() {
    collinear_adds_one_equation(line("a", 1.5, -2.0, 11.5, 0.5), line("b", 21.0, 3.8, 11.5, 0.5), 5);
}

#[test]
fn collinear_on_lines_sharing_no_point_has_dof_6() {
    collinear_adds_one_equation(line("a", 1.5, -2.0, 11.5, 0.5), line("b", 13.0, 1.0, 21.0, 3.8), 6);
}

#[test]
fn collinear_on_steep_off_origin_lines_has_the_same_dof() {
    let a = line("a", -17.5, 12.0, -4.5, -6.5);
    collinear_adds_one_equation(a.clone(), line("b", -4.5, -6.5, 3.0, -17.25), 5);
    collinear_adds_one_equation(a.clone(), line("b", 3.0, -17.25, -4.5, -6.5), 5);
    collinear_adds_one_equation(a, line("b", -1.0, -11.0, 9.0, -25.0), 6);
}

// A radial gap that leaves the inner circle no radius is refused.

fn radial_gap_case(c: (f64, f64), ro: f64, ri: f64, gap: f64, ok: bool) {
    let (o, i) = (circle("o", c.0, c.1, ro), circle("i", c.0, c.1, ri));
    let cs = cons(json!([
        { "type": "concentric", "c1": "o", "c2": "i" },
        { "type": "radius", "e": "o", "value": ro },
        { "type": "radialGap", "inner": "i", "outer": "o", "value": gap },
    ]));
    let r = solve(&[o.clone(), i.clone()], &cs);
    if ok {
        assert_eq!(r.entities[0], o);
        let s = cir(&r.entities[1]);
        near(s.0, c.0, digits(9));
        near(s.1, c.1, digits(9));
        near(s.2, 1e-6, digits(12));
        assert_pass(&r, 2, true, &[], &[]);
    } else {
        assert_eq!(r.entities, vec![o, i]);
        assert_pass(&r, 2, false, &["k2"], &[]);
    }
}

#[test]
fn a_radial_gap_equal_to_a_small_outer_radius_is_refused() {
    radial_gap_case((3.1, -1.7), 0.7, 0.3, 0.7, false);
}

#[test]
fn a_radial_gap_equal_to_a_fractional_outer_radius_is_refused() {
    radial_gap_case((3.1, -1.7), 12.345, 6.0, 12.345, false);
}

#[test]
fn a_radial_gap_equal_to_a_whole_outer_radius_is_refused() {
    radial_gap_case((3.1, -1.7), 5.0, 3.0, 5.0, false);
}

#[test]
fn a_radial_gap_a_hair_short_of_the_outer_radius_solves() {
    radial_gap_case((3.1, -1.7), 0.7, 0.3, 0.7 - 1e-6, true);
}

#[test]
fn a_radial_gap_behaves_the_same_off_origin() {
    radial_gap_case((-8.4, 5.9), 9.25, 4.0, 9.25, false);
    radial_gap_case((-8.4, 5.9), 9.25, 4.0, 9.25 - 1e-6, true);
}
