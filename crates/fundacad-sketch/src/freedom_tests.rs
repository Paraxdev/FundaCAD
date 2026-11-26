//! FundaCAD 1's freedom.test.ts: shape freedom from probe solves, on the native planegcs solver.

use std::collections::HashMap;

use serde_json::json;

use crate::compile::{compile_and_solve, constraint_index_of, Probe, ProbeAxis, SolveOpts};
use crate::freedom::{shape_freedom, Freedom, MAX_PROBED};
use crate::geom::v;
use crate::model::{Constraint, Entity};
use crate::test_fixtures::*;

fn f(x: bool, y: bool, size: bool) -> Freedom {
    Freedom { x, y, size }
}

const FIXED: Freedom = Freedom { x: false, y: false, size: false };

fn expect(rows: &[(&str, Freedom)]) -> HashMap<String, Freedom> {
    rows.iter().map(|(id, fr)| (id.to_string(), *fr)).collect()
}

fn polygon() -> Entity {
    Entity::Other { id: "g".into() }
}

// A horizontal line held 22.1 above a fixed point: x1 and x2 stay free, y is set.
fn held_line() -> Vec<Entity> {
    vec![pt("o", -18.4, 9.6), line("h", 14.2, 31.7, 52.9, 31.7)]
}

fn held_rules() -> Vec<Constraint> {
    cons(json!([
        { "type": "fix", "e": "o", "p": 0 },
        { "type": "horizontal", "line": "h" },
        { "type": "vDistance", "e1": "o", "p1": 0, "e2": "h", "p2": 0, "value": 22.1 },
    ]))
}

fn probed_dof(ents: &[Entity], cs: &[Constraint], entity: &str, axis: ProbeAxis) -> i32 {
    let opts = SolveOpts { probe: Some(Probe { entity: entity.into(), axis }), ..Default::default() };
    compile_and_solve(ents, cs, None, &opts).unwrap().dof
}

#[test]
fn a_lone_slanted_line_is_free_in_x_and_y() {
    let r = shape_freedom(&[line("a", 12.5, 7.25, 41.75, 23.5)], &[]);
    assert_eq!(r, Some(expect(&[("a", f(true, true, false))])));
}

#[test]
fn a_lone_line_in_the_negative_quadrant_is_free_in_x_and_y() {
    let r = shape_freedom(&[line("a", -52.5, -17.25, -41.75, -63.5)], &[]);
    assert_eq!(r, Some(expect(&[("a", f(true, true, false))])));
}

#[test]
fn an_empty_sketch_has_no_rows() {
    assert_eq!(shape_freedom(&[], &[]), Some(HashMap::new()));
}

#[test]
fn a_horizontal_line_set_in_y_by_a_fixed_point_is_free_in_x_only_and_the_point_is_fixed() {
    let r = shape_freedom(&held_line(), &held_rules());
    assert_eq!(r, Some(expect(&[("o", FIXED), ("h", f(true, false, false))])));
}

#[test]
fn a_vertical_line_set_in_x_by_a_fixed_point_is_free_in_y_only() {
    let ents = vec![pt("o", 18.4, -9.6), line("v", -31.7, 14.2, -31.7, 52.9)];
    let cs = cons(json!([
        { "type": "fix", "e": "o", "p": 0 },
        { "type": "vertical", "line": "v" },
        { "type": "hDistance", "e1": "o", "p1": 0, "e2": "v", "p2": 0, "value": -50.1 },
    ]));
    let r = shape_freedom(&ents, &cs);
    assert_eq!(r, Some(expect(&[("o", FIXED), ("v", f(false, true, false))])));
}

#[test]
fn many_shapes_are_read_at_once_with_fixed_ends_a_fixed_centre_a_projected_line_a_polygon_a_tilted_rectangle_and_free_curves() {
    let ents = vec![
        line("both", -7.3, 18.9, 26.1, 4.4),
        circle("c", 27.3, -14.6, 8.4),
        pl("p", -40.2, -11.5, -12.7, 6.8),
        polygon(),
        arc("ar", 61.2, 8.3, 48.6, 27.9, 63.5, 22.1),
        pt("q", 33.8, 41.6),
        rect("tilt", 71.4, -22.6, 14.5, 9.2, 0.35),
        Entity::Spline { id: "sp".into(), points: vec![v(-14.2, -27.5), v(-3.6, -19.8), v(8.9, -31.3)] },
    ];
    let cs = cons(json!([
        { "type": "fix", "e": "both", "p": 0 },
        { "type": "fix", "e": "both", "p": 1 },
        { "type": "fix", "e": "c", "p": 0 },
        { "type": "fix", "e": "sp", "p": 0 },
    ]));
    let r = shape_freedom(&ents, &cs);
    assert_eq!(
        r,
        Some(expect(&[
            ("both", FIXED),
            ("c", f(false, false, true)),
            ("p", FIXED),
            ("ar", f(true, true, true)),
            ("q", f(true, true, false)),
            // A rotated rectangle compiles pinned rigid, so the solver holds it fixed.
            ("tilt", FIXED),
            ("sp", f(true, true, false)),
        ]))
    );
}

#[test]
fn a_fully_defined_sketch_reads_every_solved_shape_fixed_and_still_skips_the_polygon() {
    let ents = vec![rect("r", 13.7, -8.2, 24.5, 11.3, 0.0), line("l", -21.6, 5.9, -3.4, 17.2), polygon()];
    let cs = cons(json!([
        { "type": "fix", "e": "r", "p": 0 },
        { "type": "fix", "e": "r", "p": 2 },
        { "type": "fix", "e": "l", "p": 0 },
        { "type": "fix", "e": "l", "p": 1 },
    ]));
    assert_eq!(solve(&ents, &cs).dof, 0);
    assert_eq!(shape_freedom(&ents, &cs), Some(expect(&[("r", FIXED), ("l", FIXED)])));
}

#[test]
fn a_rectangle_with_one_fixed_corner_is_free_in_x_and_y() {
    let cs = cons(json!([{ "type": "fix", "e": "r", "p": 0 }]));
    let r = shape_freedom(&[rect("r", 13.7, -8.2, 24.5, 11.3, 0.0)], &cs);
    assert_eq!(r, Some(expect(&[("r", f(true, true, false))])));
}

#[test]
fn a_rectangle_in_the_negative_quadrant_with_one_fixed_corner_is_free_in_x_and_y() {
    let cs = cons(json!([{ "type": "fix", "e": "r", "p": 0 }]));
    let r = shape_freedom(&[rect("r", -63.7, -48.2, 24.5, 11.3, 0.0)], &cs);
    assert_eq!(r, Some(expect(&[("r", f(true, true, false))])));
}

#[test]
fn conflicting_constraints_give_no_result() {
    let cs = cons(json!([
        { "type": "distance", "line": "a", "value": 14.5 },
        { "type": "distance", "line": "a", "value": 27.25 },
    ]));
    let ents = [line("a", 12.5, 7.25, 41.75, 23.5)];
    assert!(!solve(&ents, &cs).conflicts.is_empty());
    assert_eq!(shape_freedom(&ents, &cs), None);
}

#[test]
fn shapes_past_the_probe_cap_get_no_row_and_the_rest_still_do() {
    let ents: Vec<Entity> = (0..MAX_PROBED + 3).map(|i| pt(&format!("p{i}"), i as f64 * 3.0 - 40.0, 7.5)).collect();
    let r = shape_freedom(&ents, &[]).unwrap();
    assert_eq!(r.len(), MAX_PROBED);
    assert_eq!(r["p0"], f(true, true, false));
    assert!(!r.contains_key(&format!("p{}", MAX_PROBED)));
}

// Probe solves.

#[test]
fn holding_a_free_direction_lowers_dof_and_holding_a_set_one_leaves_it() {
    let (ents, cs) = (held_line(), held_rules());
    assert_eq!(solve(&ents, &cs).dof, 2);
    let dofs: Vec<i32> =
        [ProbeAxis::X, ProbeAxis::Y, ProbeAxis::Size].iter().map(|&a| probed_dof(&ents, &cs, "h", a)).collect();
    assert_eq!(dofs, [0, 2, 2]);
}

#[test]
fn holding_a_free_radius_lowers_dof_by_one_and_a_held_centre_is_redundant() {
    let ents = [circle("c", 27.3, -14.6, 8.4)];
    let cs = cons(json!([{ "type": "fix", "e": "c", "p": 0 }]));
    assert_eq!(solve(&ents, &cs).dof, 1);
    let dofs: Vec<i32> =
        [ProbeAxis::X, ProbeAxis::Y, ProbeAxis::Size].iter().map(|&a| probed_dof(&ents, &cs, "c", a)).collect();
    assert_eq!(dofs, [1, 1, 0]);
}

#[test]
fn a_probe_that_holds_nothing_leaves_the_pass_exactly_as_the_plain_one() {
    let mut ents = held_line();
    ents.push(polygon());
    let cs = held_rules();
    let plain = solve(&ents, &cs);
    for (entity, axis) in [("g", ProbeAxis::X), ("h", ProbeAxis::Size)] {
        let opts = SolveOpts { probe: Some(Probe { entity: entity.into(), axis }), ..Default::default() };
        assert_eq!(compile_and_solve(&ents, &cs, None, &opts).unwrap(), plain);
    }
}

#[test]
fn probe_ids_never_reach_the_users_diagnostics() {
    let opts = SolveOpts { probe: Some(Probe { entity: "o".into(), axis: ProbeAxis::Y }), ..Default::default() };
    let r = compile_and_solve(&held_line(), &held_rules(), None, &opts).unwrap();
    assert_pass(&r, 2, true, &[], &["o~probe0"]);
    assert_eq!(constraint_index_of("o~probe0"), None);
}
