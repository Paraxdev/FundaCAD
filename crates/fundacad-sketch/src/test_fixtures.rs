//! Entity builders and assertion helpers shared by the sketch compiler tests, FundaCAD 1's `solveFixtures.ts`.

use serde_json::Value;

use crate::compile::{compile_and_solve, SolveOpts, SolvePass};
use crate::geom::V;
use crate::model::{Constraint, Curve, Entity};

pub fn line(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Entity {
    Entity::Line { id: id.into(), x1, y1, x2, y2 }
}

pub fn circle(id: &str, x: f64, y: f64, radius: f64) -> Entity {
    Entity::Circle { id: id.into(), x, y, radius }
}

pub fn arc(id: &str, x1: f64, y1: f64, x2: f64, y2: f64, mx: f64, my: f64) -> Entity {
    Entity::Arc { id: id.into(), x1, y1, x2, y2, mx, my }
}

pub fn pt(id: &str, x: f64, y: f64) -> Entity {
    Entity::Point { id: id.into(), x, y }
}

pub fn rect(id: &str, x: f64, y: f64, width: f64, height: f64, angle: f64) -> Entity {
    Entity::Rectangle { id: id.into(), x, y, width, height, angle }
}

pub fn pl(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Entity {
    Entity::Projected { id: id.into(), curve: Curve::Line { x1, y1, x2, y2 } }
}

pub fn pc(id: &str, x: f64, y: f64, r: f64) -> Entity {
    Entity::Projected { id: id.into(), curve: Curve::Circle { x, y, r } }
}

pub fn pa(id: &str, x1: f64, y1: f64, x2: f64, y2: f64, mx: f64, my: f64) -> Entity {
    Entity::Projected { id: id.into(), curve: Curve::Arc { x1, y1, x2, y2, mx, my } }
}

pub fn poly(id: &str, pts: &[(f64, f64)]) -> Entity {
    Entity::Projected { id: id.into(), curve: Curve::Poly(pts.iter().map(|&(x, y)| V { x, y }).collect()) }
}

/// An arc of radius r about (cx, cy) running counterclockwise from direction angle a0 to a1, in radians.
pub fn arc_at(id: &str, cx: f64, cy: f64, r: f64, a0: f64, a1: f64, projected: bool) -> Entity {
    let m = (a0 + a1) / 2.0;
    let at = |a: f64| (cx + r * a.cos(), cy + r * a.sin());
    let ((x1, y1), (x2, y2), (mx, my)) = (at(a0), at(a1), at(m));
    if projected {
        pa(id, x1, y1, x2, y2, mx, my)
    } else {
        arc(id, x1, y1, x2, y2, mx, my)
    }
}

pub fn cons(v: Value) -> Vec<Constraint> {
    serde_json::from_value(v).expect("constraints parse")
}

pub fn solve(ents: &[Entity], cs: &[Constraint]) -> SolvePass {
    compile_and_solve(ents, cs, None, &SolveOpts::default()).expect("solve runs")
}

pub fn find<'a>(ents: &'a [Entity], id: &str) -> &'a Entity {
    ents.iter().find(|e| e.id() == id).unwrap_or_else(|| panic!("entity {id} lost"))
}

pub fn ln(e: &Entity) -> (f64, f64, f64, f64) {
    match e {
        Entity::Line { x1, y1, x2, y2, .. } => (*x1, *y1, *x2, *y2),
        other => panic!("not a line: {other:?}"),
    }
}

pub fn cir(e: &Entity) -> (f64, f64, f64) {
    match e {
        Entity::Circle { x, y, radius, .. } => (*x, *y, *radius),
        other => panic!("not a circle: {other:?}"),
    }
}

pub fn pnt(e: &Entity) -> (f64, f64) {
    match e {
        Entity::Point { x, y, .. } => (*x, *y),
        other => panic!("not a point: {other:?}"),
    }
}

pub fn ln_of(p: &SolvePass, id: &str) -> (f64, f64, f64, f64) {
    ln(find(&p.entities, id))
}

pub fn len(l: (f64, f64, f64, f64)) -> f64 {
    (l.2 - l.0).hypot(l.3 - l.1)
}

/// Vitest's `toBeCloseTo(x, digits)` bound.
pub fn digits(n: i32) -> f64 {
    10f64.powi(-n) / 2.0
}

pub fn near(a: f64, b: f64, tol: f64) {
    assert!((a - b).abs() < tol, "{a} is not within {tol} of {b}");
}

/// The constraint indices a pass blames, conflicts and over defined together, implicit ids dropped.
pub fn flagged(p: &SolvePass) -> Vec<usize> {
    p.conflicts.iter().chain(&p.over_defined).filter_map(|id| crate::compile::constraint_index_of(id)).collect()
}

/// The pass's projected entities, for asserting they never move.
pub fn projected_of(ents: &[Entity]) -> Vec<Entity> {
    ents.iter().filter(|e| matches!(e, Entity::Projected { .. })).cloned().collect()
}

/// The projected curve becomes a native entity under the same id, as FundaCAD 1's breakLink did. A closed poly turns
/// into a spline.
pub fn break_link(ents: &[Entity], ids: &[&str]) -> Vec<Entity> {
    ents.iter()
        .map(|e| match e {
            Entity::Projected { id, curve } if ids.contains(&id.as_str()) => match curve {
                Curve::Line { x1, y1, x2, y2 } => line(id, *x1, *y1, *x2, *y2),
                Curve::Circle { x, y, r } => circle(id, *x, *y, *r),
                Curve::Arc { x1, y1, x2, y2, mx, my } => arc(id, *x1, *y1, *x2, *y2, *mx, *my),
                Curve::Poly(pts) => Entity::Spline { id: id.clone(), points: pts.clone() },
            },
            other => other.clone(),
        })
        .collect()
}

/// A pass's DOF, ok flag and both diagnostic lists.
pub fn assert_pass(p: &SolvePass, dof: i32, ok: bool, conflicts: &[&str], over_defined: &[&str]) {
    assert_eq!((p.dof, p.ok), (dof, ok), "{p:?}");
    assert_eq!(p.conflicts, conflicts, "{p:?}");
    assert_eq!(p.over_defined, over_defined, "{p:?}");
}

fn numbers(e: &Entity) -> (String, Vec<f64>) {
    let flat = |pts: &[V]| pts.iter().flat_map(|p| [p.x, p.y]).collect::<Vec<_>>();
    match e {
        Entity::Line { id, x1, y1, x2, y2 } => (format!("line {id}"), vec![*x1, *y1, *x2, *y2]),
        Entity::Circle { id, x, y, radius } => (format!("circle {id}"), vec![*x, *y, *radius]),
        Entity::Rectangle { id, x, y, width, height, angle } => {
            (format!("rect {id}"), vec![*x, *y, *width, *height, *angle])
        }
        Entity::Arc { id, x1, y1, x2, y2, mx, my } => (format!("arc {id}"), vec![*x1, *y1, *x2, *y2, *mx, *my]),
        Entity::Spline { id, points } => (format!("spline {id}"), flat(points)),
        Entity::Bspline { id, poles, closed } => (format!("bspline {id} {closed}"), flat(poles)),
        Entity::Point { id, x, y } => (format!("point {id}"), vec![*x, *y]),
        other => (format!("{other:?}"), Vec::new()),
    }
}

/// Same kinds and ids, every number within tol, FundaCAD 1's `near` matcher over entities.
pub fn entities_near(got: &[Entity], want: &[Entity], tol: f64) {
    assert_eq!(got.len(), want.len(), "{got:?} vs {want:?}");
    for (g, w) in got.iter().zip(want) {
        let ((gk, gn), (wk, wn)) = (numbers(g), numbers(w));
        assert_eq!(gk, wk);
        assert_eq!(gn.len(), wn.len());
        for (a, b) in gn.iter().zip(&wn) {
            assert!((a - b).abs() < tol, "{g:?} is not within {tol} of {w:?}");
        }
    }
}

/// FundaCAD 1's `solveSketchFeature`, a closed sketch's headless re-solve through the document schema. None when the
/// solve fails or conflicts, the caller keeps the old coordinates.
pub fn headless_solve(entities: Value, constraints: Value) -> Option<Vec<Entity>> {
    use crate::compile::solve_keeping_axes;
    use crate::model::{constraints_from_core, resolve_entities, write_back};
    use fundacad_core::schema::sketch::{SketchConstraint, SketchEntity};

    let docs: Vec<SketchEntity> = serde_json::from_value(entities).unwrap();
    let cs: Vec<SketchConstraint> = serde_json::from_value(constraints).unwrap();
    let ents = resolve_entities(&docs, &|_| None).unwrap();
    let r = solve_keeping_axes(&ents, &constraints_from_core(&cs), None).ok()?;
    if !r.ok || !r.conflicts.is_empty() {
        return None;
    }
    let out: Vec<SketchEntity> = docs.iter().zip(&r.entities).map(|(d, e)| write_back(d, e)).collect();
    Some(resolve_entities(&out, &|_| None).unwrap())
}
