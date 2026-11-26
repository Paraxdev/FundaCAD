use super::solver::*;

fn pt(id: &str, x: f64, y: f64) -> SPoint {
    SPoint { id: id.into(), x, y, fixed: false }
}

fn fixed(id: &str, x: f64, y: f64) -> SPoint {
    SPoint { id: id.into(), x, y, fixed: true }
}

fn line(id: &str, a: &str, b: &str) -> SLine {
    SLine { id: id.into(), p1: a.into(), p2: b.into() }
}

fn k(id: &str, c: SConstraint) -> Constraint {
    Constraint { id: id.into(), c }
}

#[test]
fn slanted_line_goes_horizontal_with_three_dof_left() {
    let r = solve_sketch(&SolveInput {
        points: vec![pt("a", 3.2, -1.7), pt("b", 11.9, 4.4)],
        lines: vec![line("l", "a", "b")],
        constraints: vec![k("k0", SConstraint::Horizontal { line: "l".into() })],
        ..Default::default()
    })
    .unwrap();
    assert!(r.ok);
    assert_eq!(r.dof, 3);
    let (a, b) = (r.points["a"], r.points["b"]);
    assert!((a.1 - b.1).abs() < 1e-9, "{a:?} {b:?}");
}

#[test]
fn distance_from_a_fixed_point_holds() {
    let r = solve_sketch(&SolveInput {
        points: vec![fixed("a", -2.5, 7.1), pt("b", 4.0, 1.3)],
        lines: vec![line("l", "a", "b")],
        constraints: vec![
            k("k0", SConstraint::Distance { a: "a".into(), b: "b".into(), value: 12.25 }),
            k("k1", SConstraint::Vertical { line: "l".into() }),
        ],
        ..Default::default()
    })
    .unwrap();
    assert!(r.ok);
    assert_eq!(r.dof, 0);
    let b = r.points["b"];
    assert!((b.0 + 2.5).abs() < 1e-9);
    assert!(((b.1 - 7.1).abs() - 12.25).abs() < 1e-9);
}

#[test]
fn a_repeated_constraint_is_reported_redundant() {
    let r = solve_sketch(&SolveInput {
        points: vec![pt("a", 1.4, 2.2), pt("b", 8.3, 3.9)],
        lines: vec![line("l", "a", "b")],
        constraints: vec![
            k("k0", SConstraint::Horizontal { line: "l".into() }),
            k("k1", SConstraint::Horizontal { line: "l".into() }),
        ],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(r.dof, 3);
    assert!(!r.redundant.is_empty(), "{r:?}");
}

#[test]
fn conflicting_dimensions_are_named() {
    let r = solve_sketch(&SolveInput {
        points: vec![fixed("a", 0.7, -3.1), pt("b", 6.2, 2.4)],
        constraints: vec![
            k("k0", SConstraint::Distance { a: "a".into(), b: "b".into(), value: 5.0 }),
            k("k1", SConstraint::Distance { a: "a".into(), b: "b".into(), value: 9.0 }),
        ],
        ..Default::default()
    })
    .unwrap();
    assert!(!r.ok);
    assert!(r.conflicts.contains(&"k0".to_string()) || r.conflicts.contains(&"k1".to_string()), "{r:?}");
}

#[test]
fn drag_moves_the_free_end_the_least() {
    let r = solve_sketch(&SolveInput {
        points: vec![fixed("a", 2.0, 1.5), pt("b", 9.0, 4.0)],
        lines: vec![line("l", "a", "b")],
        constraints: vec![k("k0", SConstraint::Distance { a: "a".into(), b: "b".into(), value: 7.433 })],
        drag: Some(Drag { point: "b".into(), x: 2.0, y: 20.0 }),
        ..Default::default()
    })
    .unwrap();
    assert!(r.ok, "{r:?}");
    let b = r.points["b"];
    assert!((b.0 - 2.0).abs() < 1e-6 && (b.1 - (1.5 + 7.433)).abs() < 1e-6, "{b:?}");
}

#[test]
fn arc_with_coincident_line_end_keeps_radius_constraint() {
    let r = solve_sketch(&SolveInput {
        points: vec![pt("c", 1.1, 2.3), pt("s", 6.1, 2.3), pt("e", 1.1, 7.3), pt("q", 9.0, -4.0)],
        lines: vec![line("l", "s", "q")],
        arcs: vec![SArc {
            id: "arc".into(),
            center: "c".into(),
            start: "s".into(),
            end: "e".into(),
            radius: 5.0,
            start_angle: 0.0,
            end_angle: std::f64::consts::FRAC_PI_2,
        }],
        constraints: vec![k("k0", SConstraint::ArcRadius { arc: "arc".into(), value: 3.75 })],
        ..Default::default()
    })
    .unwrap();
    assert!(r.ok, "{r:?}");
    assert!((r.arcs["arc"] - 3.75).abs() < 1e-9);
    let (c, s) = (r.points["c"], r.points["s"]);
    assert!((((s.0 - c.0).powi(2) + (s.1 - c.1).powi(2)).sqrt() - 3.75).abs() < 1e-9);
    // Center 2, start/end each 2 but tied by rules (circle 3 + 2 angles = 5), q 2, minus radius 1.
    assert_eq!(r.dof, 6);
}

#[test]
fn unknown_operand_is_an_error() {
    let e = solve_sketch(&SolveInput {
        points: vec![pt("a", 0.0, 0.0)],
        constraints: vec![k("k0", SConstraint::Horizontal { line: "nope".into() })],
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(e, SolveError::UnknownPrimitive("nope".into()));
}
