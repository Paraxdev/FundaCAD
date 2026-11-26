use super::solver::*;

const EPS: f64 = 1e-8;

fn free(id: &str, x: f64, y: f64) -> SPoint {
    SPoint { id: id.into(), x, y, fixed: false }
}

fn fixed(id: &str, x: f64, y: f64) -> SPoint {
    SPoint { id: id.into(), x, y, fixed: true }
}

fn line(id: &str, a: &str, b: &str) -> SLine {
    SLine { id: id.into(), p1: a.into(), p2: b.into() }
}

fn circle(id: &str, center: &str, radius: f64) -> SCircle {
    SCircle { id: id.into(), center: center.into(), radius }
}

/// Endpoints `<id>s` and `<id>e` at the given angles.
fn arc_at(id: &str, center: &str, c: (f64, f64), r: f64, a0: f64, a1: f64, fix_ends: bool) -> (Vec<SPoint>, SArc) {
    let (s, e) = (format!("{id}s"), format!("{id}e"));
    let mk = |pid: &str, a: f64| SPoint { id: pid.into(), x: c.0 + r * a.cos(), y: c.1 + r * a.sin(), fixed: fix_ends };
    let pts = vec![mk(&s, a0), mk(&e, a1)];
    let arc =
        SArc { id: id.into(), center: center.into(), start: s, end: e, radius: r, start_angle: a0, end_angle: a1 };
    (pts, arc)
}

fn k(id: &str, c: SConstraint) -> Constraint {
    Constraint { id: id.into(), c }
}

fn ok(input: SolveInput) -> SolveResult {
    let r = solve_sketch(&input).unwrap();
    assert!(r.ok && r.conflicts.is_empty() && r.redundant.is_empty(), "{r:?}");
    r
}

fn p(r: &SolveResult, id: &str) -> (f64, f64) {
    r.points[id]
}

fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

fn perp(q: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    ((q.0 - a.0) * (b.1 - a.1) - (q.1 - a.1) * (b.0 - a.0)).abs() / dist(a, b)
}

fn dir(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    let l = dist(a, b);
    ((b.0 - a.0) / l, (b.1 - a.1) / l)
}

/// A slanted fixed line `L` from (0.5, 1.0) to (9.0, 4.2).
fn fixed_line() -> (Vec<SPoint>, SLine) {
    (vec![fixed("la", 0.5, 1.0), fixed("lb", 9.0, 4.2)], line("L", "la", "lb"))
}

fn two_free_lines() -> (Vec<SPoint>, Vec<SLine>) {
    (
        vec![free("a", 1.2, -0.7), free("b", 6.9, 2.3), free("c", -2.4, 3.1), free("d", 3.3, 7.8)],
        vec![line("l1", "a", "b"), line("l2", "c", "d")],
    )
}

#[test]
fn coincident_joins_two_free_points() {
    let r = ok(SolveInput {
        points: vec![free("a", 1.3, 2.1), free("b", 4.7, -0.6)],
        constraints: vec![k("k0", SConstraint::Coincident { a: "a".into(), b: "b".into() })],
        ..Default::default()
    });
    assert!(dist(p(&r, "a"), p(&r, "b")) < EPS);
    assert_eq!(r.dof, 2);
}

#[test]
fn parallel_perpendicular_and_equal_each_take_one_dof_from_two_lines() {
    for (c, check) in [
        (SConstraint::Parallel { l1: "l1".into(), l2: "l2".into() }, 0),
        (SConstraint::Perpendicular { l1: "l1".into(), l2: "l2".into() }, 1),
        (SConstraint::Equal { l1: "l1".into(), l2: "l2".into() }, 2),
    ] {
        let (points, lines) = two_free_lines();
        let r = ok(SolveInput { points, lines, constraints: vec![k("k0", c)], ..Default::default() });
        let (d1, d2) = (dir(p(&r, "a"), p(&r, "b")), dir(p(&r, "c"), p(&r, "d")));
        let res = match check {
            0 => d1.0 * d2.1 - d1.1 * d2.0,
            1 => d1.0 * d2.0 + d1.1 * d2.1,
            _ => dist(p(&r, "a"), p(&r, "b")) - dist(p(&r, "c"), p(&r, "d")),
        };
        assert!(res.abs() < EPS, "check {check}: {res}");
        assert_eq!(r.dof, 7);
    }
}

#[test]
fn axis_distance_is_signed_b_minus_a() {
    for (axis, value) in [(Axis::X, 4.25), (Axis::Y, -3.5)] {
        let r = ok(SolveInput {
            points: vec![fixed("a", 2.5, -1.2), free("b", 7.1, 3.3)],
            constraints: vec![k("k0", SConstraint::AxisDistance { a: "a".into(), b: "b".into(), axis, value })],
            ..Default::default()
        });
        let b = p(&r, "b");
        let got = if axis == Axis::X { b.0 - 2.5 } else { b.1 + 1.2 };
        assert!((got - value).abs() < EPS, "{axis:?} {b:?}");
        assert_eq!(r.dof, 1);
    }
}

#[test]
fn point_to_line_distance_holds_off_a_slanted_line() {
    let (mut points, l) = fixed_line();
    points.push(free("q", 3.0, 6.5));
    let r = ok(SolveInput {
        points,
        lines: vec![l],
        constraints: vec![k("k0", SConstraint::P2lDistance { p: "q".into(), line: "L".into(), value: 2.75 })],
        ..Default::default()
    });
    assert!((perp(p(&r, "q"), (0.5, 1.0), (9.0, 4.2)) - 2.75).abs() < EPS);
    assert_eq!(r.dof, 1);
}

#[test]
fn diameter_and_radius_set_the_circle() {
    for (c, want) in [
        (SConstraint::Diameter { circle: "c".into(), value: 7.3 }, 3.65),
        (SConstraint::CircleRadius { circle: "c".into(), value: 2.2 }, 2.2),
    ] {
        let r = ok(SolveInput {
            points: vec![fixed("o", -3.1, 4.4)],
            circles: vec![circle("c", "o", 5.0)],
            constraints: vec![k("k0", c)],
            ..Default::default()
        });
        assert!((r.circles["c"] - want).abs() < EPS);
        assert_eq!(r.dof, 0);
    }
}

#[test]
fn tangent_line_circle_sizes_the_circle_to_the_line() {
    let (mut points, l) = fixed_line();
    points.push(fixed("o", 4.0, -2.5));
    let r = ok(SolveInput {
        points,
        lines: vec![l],
        circles: vec![circle("c", "o", 3.0)],
        constraints: vec![k("k0", SConstraint::TangentLC { line: "L".into(), circle: "c".into() })],
        ..Default::default()
    });
    assert!((perp((4.0, -2.5), (0.5, 1.0), (9.0, 4.2)) - r.circles["c"]).abs() < EPS);
    assert_eq!(r.dof, 0);
}

/// A rigid circle `F` at (-4.2, 1.7) with radius 2, and an arc `A` at (3.6, -1.1) whose ends are free.
fn rigid_circle_and_free_arc(r0: f64) -> SolveInput {
    let (ends, arc) = arc_at("A", "ao", (3.6, -1.1), r0, 0.4, 2.1, false);
    let mut points = vec![fixed("fo", -4.2, 1.7), fixed("ao", 3.6, -1.1)];
    points.extend(ends);
    SolveInput {
        points,
        circles: vec![circle("F", "fo", 2.0)],
        arcs: vec![arc],
        constraints: vec![k("~fr", SConstraint::CircleRadius { circle: "F".into(), value: 2.0 })],
        ..Default::default()
    }
}

fn arc_radius_from_points(r: &SolveResult) -> f64 {
    let c = p(r, "ao");
    let (rs, re) = (dist(c, p(r, "As")), dist(c, p(r, "Ae")));
    assert!((rs - re).abs() < EPS && (rs - r.arcs["A"]).abs() < EPS, "{rs} {re} {}", r.arcs["A"]);
    rs
}

#[test]
fn arc_with_fixed_centre_has_three_dof() {
    let r = ok(rigid_circle_and_free_arc(3.0));
    assert_eq!(r.dof, 3);
}

#[test]
fn tangent_line_arc_puts_the_arc_on_the_line() {
    let (ends, arc) = arc_at("A", "ao", (3.6, -1.1), 2.0, 0.4, 2.1, false);
    let (mut points, l) = fixed_line();
    points.push(fixed("ao", 3.6, -1.1));
    points.extend(ends);
    let r = ok(SolveInput {
        points,
        lines: vec![l],
        arcs: vec![arc],
        constraints: vec![k("k0", SConstraint::TangentLA { line: "L".into(), arc: "A".into() })],
        ..Default::default()
    });
    let rad = arc_radius_from_points(&r);
    assert!((perp((3.6, -1.1), (0.5, 1.0), (9.0, 4.2)) - rad).abs() < EPS);
    assert_eq!(r.dof, 2);
}

fn touching(d: f64, r1: f64, r2: f64) -> bool {
    (d - (r1 + r2)).abs() < EPS || (d - (r1 - r2).abs()).abs() < EPS
}

#[test]
fn tangent_circle_circle_and_circle_arc_touch() {
    let mut cc = rigid_circle_and_free_arc(3.0);
    cc.points.push(fixed("go", 3.9, 2.8));
    cc.circles.push(circle("G", "go", 4.5));
    cc.constraints.push(k("k0", SConstraint::TangentCC { c1: "F".into(), c2: "G".into() }));
    let r = ok(cc);
    assert!(touching(dist((-4.2, 1.7), (3.9, 2.8)), 2.0, r.circles["G"]));
    assert_eq!(r.dof, 3);

    let mut ca = rigid_circle_and_free_arc(4.5);
    ca.constraints.push(k("k0", SConstraint::TangentCA { circle: "F".into(), arc: "A".into() }));
    let r = ok(ca);
    assert!(touching(dist((-4.2, 1.7), (3.6, -1.1)), 2.0, arc_radius_from_points(&r)));
    assert_eq!(r.dof, 2);
}

/// Arc `B` with all three points fixed, which the wrapper pins instead of giving it arc rules.
fn pinned_arc(input: &mut SolveInput) {
    let (ends, arc) = arc_at("B", "bo", (-3.4, -2.6), 3.0, -0.3, 1.2, true);
    input.points.push(fixed("bo", -3.4, -2.6));
    input.points.extend(ends);
    input.arcs.insert(0, arc);
}

#[test]
fn tangent_arc_arc_against_a_pinned_arc() {
    let mut input = rigid_circle_and_free_arc(4.5);
    pinned_arc(&mut input);
    input.constraints.push(k("k0", SConstraint::TangentAA { a1: "B".into(), a2: "A".into() }));
    let r = ok(input);
    assert!(touching(dist((-3.4, -2.6), (3.6, -1.1)), 3.0, arc_radius_from_points(&r)));
    assert_eq!(r.dof, 2);
    assert!((r.arcs["B"] - 3.0).abs() < EPS);
}

#[test]
fn angle_is_signed_from_l1_to_l2() {
    let (mut points, l) = fixed_line();
    points.extend([fixed("c", -1.5, 2.0), free("d", 2.0, 7.5)]);
    let r = ok(SolveInput {
        points,
        lines: vec![l, line("l2", "c", "d")],
        constraints: vec![k("k0", SConstraint::AngleLL { l1: "L".into(), l2: "l2".into(), value: 0.6 })],
        ..Default::default()
    });
    let (d1, d2) = (dir((0.5, 1.0), (9.0, 4.2)), dir((-1.5, 2.0), p(&r, "d")));
    let got = (d1.0 * d2.1 - d1.1 * d2.0).atan2(d1.0 * d2.0 + d1.1 * d2.1);
    assert!((got - 0.6).abs() < EPS, "{got}");
    assert_eq!(r.dof, 1);
}

#[test]
fn equal_radius_copies_a_rigid_radius() {
    let mut cc = rigid_circle_and_free_arc(3.0);
    cc.points.push(fixed("go", 3.9, 2.8));
    cc.circles.push(circle("G", "go", 4.5));
    cc.constraints.push(k("k0", SConstraint::EqualRadiusCC { c1: "F".into(), c2: "G".into() }));
    let r = ok(cc);
    assert!((r.circles["G"] - 2.0).abs() < EPS);
    assert_eq!(r.dof, 3);

    let mut ca = rigid_circle_and_free_arc(3.0);
    ca.constraints.push(k("k0", SConstraint::EqualRadiusCA { circle: "F".into(), arc: "A".into() }));
    let r = ok(ca);
    assert!((arc_radius_from_points(&r) - 2.0).abs() < EPS);
    assert_eq!(r.dof, 2);

    let mut aa = rigid_circle_and_free_arc(4.5);
    pinned_arc(&mut aa);
    aa.constraints.push(k("k0", SConstraint::EqualRadiusAA { a1: "B".into(), a2: "A".into() }));
    let r = ok(aa);
    assert!((arc_radius_from_points(&r) - 3.0).abs() < EPS);
    assert_eq!(r.dof, 2);
}

#[test]
fn point_on_line_and_on_perpendicular_bisector() {
    for bisector in [false, true] {
        let (mut points, l) = fixed_line();
        points.push(free("q", 2.2, 6.1));
        let c = if bisector {
            SConstraint::PointOnPerpBisector { p: "q".into(), line: "L".into() }
        } else {
            SConstraint::PointOnLine { p: "q".into(), line: "L".into() }
        };
        let r = ok(SolveInput { points, lines: vec![l], constraints: vec![k("k0", c)], ..Default::default() });
        let q = p(&r, "q");
        let res =
            if bisector { dist(q, (0.5, 1.0)) - dist(q, (9.0, 4.2)) } else { perp(q, (0.5, 1.0), (9.0, 4.2)) };
        assert!(res.abs() < EPS, "bisector {bisector}: {res}");
        assert_eq!(r.dof, 1);
    }
}

#[test]
fn point_on_circle_and_on_pinned_arc() {
    let mut on_c = rigid_circle_and_free_arc(3.0);
    on_c.points.push(free("q", 1.1, 5.2));
    on_c.constraints.push(k("k0", SConstraint::PointOnCircle { p: "q".into(), circle: "F".into() }));
    let r = ok(on_c);
    assert!((dist(p(&r, "q"), (-4.2, 1.7)) - 2.0).abs() < EPS);
    assert_eq!(r.dof, 4);

    let mut on_a = SolveInput::default();
    pinned_arc(&mut on_a);
    on_a.points.push(free("q", 0.9, 1.4));
    on_a.constraints.push(k("k0", SConstraint::PointOnArc { p: "q".into(), arc: "B".into() }));
    let r = ok(on_a);
    assert!((dist(p(&r, "q"), (-3.4, -2.6)) - 3.0).abs() < EPS);
    assert_eq!(r.dof, 1);
}

#[test]
fn symmetric_mirrors_across_a_slanted_line() {
    let (mut points, l) = fixed_line();
    points.extend([fixed("a", 2.0, 5.5), free("b", 6.0, -1.0)]);
    let r = ok(SolveInput {
        points,
        lines: vec![l],
        constraints: vec![k("k0", SConstraint::Symmetric { a: "a".into(), b: "b".into(), line: "L".into() })],
        ..Default::default()
    });
    let (la, d) = ((0.5, 1.0), dir((0.5, 1.0), (9.0, 4.2)));
    let t = (2.0 - la.0) * d.0 + (5.5 - la.1) * d.1;
    let m = (2.0 * (la.0 + t * d.0) - 2.0, 2.0 * (la.1 + t * d.1) - 5.5);
    assert!(dist(p(&r, "b"), m) < EPS, "{:?} {m:?}", p(&r, "b"));
    assert_eq!(r.dof, 0);
}

#[test]
fn rim_gap_between_separate_circles() {
    let mut input = rigid_circle_and_free_arc(3.0);
    input.points.push(fixed("go", 3.9, 2.8));
    input.circles.push(circle("G", "go", 4.0));
    input.constraints.push(k("k0", SConstraint::RimGap { round1: "F".into(), round2: "G".into(), value: 1.25 }));
    let r = ok(input);
    assert!((dist((-4.2, 1.7), (3.9, 2.8)) - 2.0 - r.circles["G"] - 1.25).abs() < EPS);
    assert_eq!(r.dof, 3);
}

#[test]
fn rim_line_and_rim_point_size_a_free_circle() {
    let (mut points, l) = fixed_line();
    points.push(fixed("o", 4.0, -4.5));
    let r = ok(SolveInput {
        points,
        lines: vec![l],
        circles: vec![circle("c", "o", 2.0)],
        constraints: vec![k("k0", SConstraint::RimLine { round: "c".into(), line: "L".into(), value: 1.5 })],
        ..Default::default()
    });
    assert!((perp((4.0, -4.5), (0.5, 1.0), (9.0, 4.2)) - r.circles["c"] - 1.5).abs() < EPS);
    assert_eq!(r.dof, 0);

    let r = ok(SolveInput {
        points: vec![fixed("q", 2.6, 7.3), fixed("o", -1.4, 2.8)],
        circles: vec![circle("c", "o", 4.0)],
        constraints: vec![k("k0", SConstraint::RimPoint { p: "q".into(), round: "c".into(), value: 1.25 })],
        ..Default::default()
    });
    assert!(((dist((2.6, 7.3), (-1.4, 2.8)) - r.circles["c"]).abs() - 1.25).abs() < EPS);
    assert_eq!(r.dof, 0);
}

#[test]
fn radius_difference_is_signed_outer_minus_inner() {
    for value in [1.75, -0.5] {
        let mut input = rigid_circle_and_free_arc(3.0);
        input.points.push(fixed("go", 3.9, 2.8));
        input.circles.push(circle("G", "go", 2.5));
        input.constraints.push(k("k0", SConstraint::RadiusDifference { inner: "F".into(), outer: "G".into(), value }));
        let r = ok(input);
        assert!((r.circles["G"] - 2.0 - value).abs() < EPS, "{value}");
        assert_eq!(r.dof, 3);
    }
}

#[test]
fn drag_pin_never_shows_up_in_diagnostics() {
    let r = solve_sketch(&SolveInput {
        points: vec![fixed("a", 0.7, -3.1), free("b", 6.2, 2.4)],
        constraints: vec![
            k("k0", SConstraint::Distance { a: "a".into(), b: "b".into(), value: 5.0 }),
            k("k1", SConstraint::Distance { a: "a".into(), b: "b".into(), value: 9.0 }),
        ],
        drag: Some(Drag { point: "b".into(), x: 12.0, y: 1.0 }),
        ..Default::default()
    })
    .unwrap();
    assert!(!r.ok);
    let all: Vec<&String> = r.conflicts.iter().chain(&r.redundant).chain(&r.partially_redundant).collect();
    assert!(!all.is_empty() && all.iter().all(|id| *id == "k0" || *id == "k1"), "{r:?}");
}

#[test]
fn diagnostics_name_constraints_after_pins_and_arc_rules() {
    let mut input = rigid_circle_and_free_arc(3.0);
    pinned_arc(&mut input);
    input.points.extend([free("a", 1.4, 2.2), free("b", 8.3, 3.9)]);
    input.lines.push(line("l", "a", "b"));
    input.constraints.extend([
        k("k0", SConstraint::ArcRadius { arc: "A".into(), value: 2.5 }),
        k("k1", SConstraint::Horizontal { line: "l".into() }),
        k("k2", SConstraint::Distance { a: "a".into(), b: "b".into(), value: 6.0 }),
        k("k3", SConstraint::Horizontal { line: "l".into() }),
        k("k4", SConstraint::ArcRadius { arc: "A".into(), value: 2.5 }),
    ]);
    let r = solve_sketch(&input).unwrap();
    let mut over = r.redundant.clone();
    over.sort();
    assert!(r.conflicts.is_empty(), "{r:?}");
    assert_eq!(over, ["k3", "k4"], "{r:?}");
    assert_eq!(r.dof, 4);
}
