//! Compiles a sketch and its constraints into the solver model and writes the solved positions back, FundaCAD 1's
//! `src/sketch/sketchSolve.ts`. Endpoints at one position merge into one solver point (`coinc_key`), centres and
//! interior points never merge. A rectangle becomes 4 corners and 4 implicit edges, so it stays rectangular yet one
//! entity in the document.

use std::collections::{HashMap, HashSet};
use std::f64::consts::{PI, TAU};

use crate::geom::{ccw_delta, circumcenter, coinc_key, pole_of_ref, rect_corners, rect_from_three_points, solver_angle_deg, v, V};
use crate::model::{proj_end_samples, Constraint, Curve, Entity};
use crate::solver::{
    self, solve_sketch, Axis, Drag, SArc, SCircle, SConstraint, SLine, SPoint, SolveError, SolveInput, SolveResult,
};

pub const RIM_EPS: f64 = 1e-9;
const AXIS_TOL: f64 = 1e-6;
/// Above the engine's 6 decimal rounding floor and matching its 1e-4 mm change tolerance, so a satisfied inert
/// dimension grades as redundant, not as a conflict. Radians for angles.
const INERT_TOL: f64 = 1e-4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragRefused {
    Projected,
    Fix,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SolvePass {
    pub entities: Vec<Entity>,
    pub dof: i32,
    pub ok: bool,
    /// Constraints that cannot all hold.
    pub conflicts: Vec<String>,
    /// Redundant and partially redundant constraints, removable or over defining.
    pub over_defined: Vec<String>,
    /// The grabbed point is fixed. The caller must keep its drag anchor, or the nearest point search re-runs from the
    /// cursor and grabs an unrelated free point.
    pub drag_refused: Option<DragRefused>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeAxis {
    X,
    Y,
    Size,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub entity: String,
    pub axis: ProbeAxis,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SolveOpts {
    pub hold_axes: bool,
    pub pin: Option<V>,
    pub probe: Option<Probe>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragReq {
    pub from: V,
    pub to: V,
}

/// A composite constraint appends a letter first suffix (`k12p3`), so the leading integer still decodes to its index.
pub fn constraint_key(i: usize) -> String {
    format!("k{i}")
}

/// None for implicit ids, any id with `~` is implicit and reporting must never blame a user constraint for one.
pub fn constraint_index_of(id: &str) -> Option<usize> {
    if id.contains('~') {
        return None;
    }
    let digits: String = id.strip_prefix('k')?.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// After a typed dimension, lines drawn horizontal or vertical keep that direction where allowed and `anchor` stays
/// put, so lengthening one side of a drawn rectangle moves only the far side. The held pass only places geometry, a
/// plain pass then reports DOF and diagnostics against the user's constraints.
pub fn solve_keeping_axes(
    entities: &[Entity],
    constraints: &[Constraint],
    anchor: Option<V>,
) -> Result<SolvePass, SolveError> {
    let mut tries = Vec::new();
    if let Some(a) = anchor {
        tries.push(SolveOpts { hold_axes: true, pin: Some(a), probe: None });
    }
    tries.push(SolveOpts { hold_axes: true, ..Default::default() });
    for opts in &tries {
        let held = compile_and_solve(entities, constraints, None, opts)?;
        if !held.ok || !held.conflicts.is_empty() {
            continue;
        }
        let settled = compile_and_solve(&held.entities, constraints, None, &SolveOpts::default())?;
        if settled.ok && settled.conflicts.is_empty() {
            return Ok(settled);
        }
    }
    compile_and_solve(entities, constraints, None, &SolveOpts::default())
}

struct ArcInfo {
    our_s: String,
    our_e: String,
    center: String,
    start_is_our_s: bool,
}

#[derive(Default)]
struct Compiler {
    points: Vec<SPoint>,
    by_key: HashMap<(i64, i64), String>,
    lines: Vec<SLine>,
    circles: Vec<SCircle>,
    arcs: Vec<SArc>,
    cons: Vec<solver::Constraint>,
    ends: HashMap<String, [String; 2]>,
    centers: HashMap<String, String>,
    arc_map: HashMap<String, ArcInfo>,
    spline_map: HashMap<String, Vec<String>>,
    pole_map: HashMap<String, Vec<String>>,
    rect_map: HashMap<String, Vec<String>>,
    point_map: HashMap<String, String>,
    /// Pinned by a `fix` constraint or projected geometry.
    fixed_pts: HashSet<String>,
    /// The part of `fixed_pts` pinned by projected geometry.
    proj_pts: HashSet<String>,
    /// Projected circles and arcs, their radius is pinned too, so they are fully rigid.
    proj_rounds: HashSet<String>,
}

fn idx(p: f64) -> i64 {
    if p.fract() == 0.0 {
        #[allow(clippy::cast_possible_truncation)]
        return p as i64;
    }
    -1
}

impl Compiler {
    fn get_point(&mut self, x: f64, y: f64, mergeable: bool) -> String {
        let key = coinc_key(x, y);
        if mergeable {
            if let Some(id) = self.by_key.get(&key) {
                return id.clone();
            }
        }
        let id = format!("P{}", self.points.len());
        if mergeable {
            self.by_key.insert(key, id.clone());
        }
        self.points.push(SPoint { id: id.clone(), x, y, fixed: false });
        id
    }

    fn push(&mut self, id: impl Into<String>, c: SConstraint) {
        self.cons.push(solver::Constraint { id: id.into(), c });
    }

    fn pin_projected(&mut self, ids: &[String]) {
        for id in ids {
            self.fixed_pts.insert(id.clone());
            self.proj_pts.insert(id.clone());
        }
    }

    /// None when degenerate.
    fn compile_arc(&mut self, id: &str, s: V, e: V, m: V) -> Option<[String; 3]> {
        let cc = circumcenter(s, e, m)?;
        let radius = (s.x - cc.x).hypot(s.y - cc.y);
        let our_s = self.get_point(s.x, s.y, true);
        let our_e = self.get_point(e.x, e.y, true);
        let center = self.get_point(cc.x, cc.y, false);
        let a_s = (s.y - cc.y).atan2(s.x - cc.x);
        let a_e = (e.y - cc.y).atan2(e.x - cc.x);
        let a_t = (m.y - cc.y).atan2(m.x - cc.x);
        // Oriented counterclockwise so the sweep passes through the through point.
        let ccw = ccw_delta(a_s, a_t) <= ccw_delta(a_s, a_e);
        let (start, start_a, end, end_a) =
            if ccw { (&our_s, a_s, &our_e, a_e) } else { (&our_e, a_e, &our_s, a_s) };
        self.arcs.push(SArc {
            id: id.to_string(),
            center: center.clone(),
            start: start.clone(),
            end: end.clone(),
            radius,
            start_angle: start_a,
            end_angle: start_a + ccw_delta(start_a, end_a),
        });
        self.arc_map.insert(
            id.to_string(),
            ArcInfo { our_s: our_s.clone(), our_e: our_e.clone(), center: center.clone(), start_is_our_s: ccw },
        );
        Some([our_s, our_e, center])
    }

    fn entity(&mut self, e: &Entity, hold_axes: bool) {
        match e {
            Entity::Line { id, x1, y1, x2, y2 } => {
                let p1 = self.get_point(*x1, *y1, true);
                let p2 = self.get_point(*x2, *y2, true);
                self.lines.push(SLine { id: id.clone(), p1: p1.clone(), p2: p2.clone() });
                self.ends.insert(id.clone(), [p1.clone(), p2.clone()]);
                if hold_axes && p1 != p2 {
                    if (y2 - y1).abs() <= AXIS_TOL {
                        self.push(format!("{id}~holdH"), SConstraint::Horizontal { line: id.clone() });
                    } else if (x2 - x1).abs() <= AXIS_TOL {
                        self.push(format!("{id}~holdV"), SConstraint::Vertical { line: id.clone() });
                    }
                }
            }
            Entity::Circle { id, x, y, radius } => {
                let c = self.get_point(*x, *y, false);
                self.circles.push(SCircle { id: id.clone(), center: c.clone(), radius: *radius });
                self.centers.insert(id.clone(), c);
            }
            Entity::Rectangle { id, x, y, width, height, angle } => {
                let cp: Vec<String> =
                    rect_corners(*x, *y, *width, *height, *angle).iter().map(|p| self.get_point(p.x, p.y, true)).collect();
                for k in 0..4 {
                    let (a, b) = (cp[k].clone(), cp[(k + 1) % 4].clone());
                    let edge = format!("{id}~{k}");
                    self.lines.push(SLine { id: edge.clone(), p1: a.clone(), p2: b.clone() });
                    self.ends.insert(edge, [a, b]);
                }
                if *angle != 0.0 && !angle.is_nan() {
                    // A rotated rectangle is pinned rigid. The axis rules would straighten it, and parallel sides plus a
                    // square corner leave the angle free (dimensioning a 37.5 degree rectangle spun it to 33.8).
                    self.fixed_pts.extend(cp.iter().cloned());
                } else {
                    self.push(format!("{id}~h0"), SConstraint::Horizontal { line: format!("{id}~0") });
                    self.push(format!("{id}~h2"), SConstraint::Horizontal { line: format!("{id}~2") });
                    self.push(format!("{id}~v1"), SConstraint::Vertical { line: format!("{id}~1") });
                    self.push(format!("{id}~v3"), SConstraint::Vertical { line: format!("{id}~3") });
                }
                self.rect_map.insert(id.clone(), cp);
            }
            Entity::Arc { id, x1, y1, x2, y2, mx, my } => {
                self.compile_arc(id, v(*x1, *y1), v(*x2, *y2), v(*mx, *my));
            }
            Entity::Spline { id, points } => {
                let last = points.len().saturating_sub(1);
                let ids = points.iter().enumerate().map(|(k, p)| self.get_point(p.x, p.y, k == 0 || k == last)).collect();
                self.spline_map.insert(id.clone(), ids);
            }
            Entity::Bspline { id, poles, closed } => {
                // An open curve's end poles are on the curve and chain like endpoints.
                let last = poles.len().saturating_sub(1);
                let ids =
                    poles.iter().enumerate().map(|(k, p)| self.get_point(p.x, p.y, !closed && (k == 0 || k == last))).collect();
                self.pole_map.insert(id.clone(), ids);
            }
            Entity::Point { id, x, y } => {
                let p = self.get_point(*x, *y, true);
                self.point_map.insert(id.clone(), p);
            }
            Entity::Projected { id, curve } => match curve {
                // Endpoints are mergeable on purpose, a coincident user endpoint fuses with the fixed point.
                Curve::Line { x1, y1, x2, y2 } => {
                    let p1 = self.get_point(*x1, *y1, true);
                    let p2 = self.get_point(*x2, *y2, true);
                    self.lines.push(SLine { id: id.clone(), p1: p1.clone(), p2: p2.clone() });
                    self.ends.insert(id.clone(), [p1.clone(), p2.clone()]);
                    self.pin_projected(&[p1, p2]);
                }
                Curve::Circle { x, y, r } => {
                    let c = self.get_point(*x, *y, false);
                    self.circles.push(SCircle { id: id.clone(), center: c.clone(), radius: *r });
                    self.centers.insert(id.clone(), c.clone());
                    self.pin_projected(&[c]);
                    self.proj_rounds.insert(id.clone());
                    self.push(format!("{id}~r"), SConstraint::CircleRadius { circle: id.clone(), value: *r });
                }
                Curve::Arc { x1, y1, x2, y2, mx, my } => {
                    if let Some(m) = self.compile_arc(id, v(*x1, *y1), v(*x2, *y2), v(*mx, *my)) {
                        self.pin_projected(&m);
                        self.proj_rounds.insert(id.clone());
                    }
                }
                Curve::Poly(pts) => {
                    // Only the first and last samples are real model points, interior samples never enter the solver.
                    let ids: Vec<String> = proj_end_samples(pts).iter().map(|q| self.get_point(q.x, q.y, true)).collect();
                    if !ids.is_empty() {
                        self.pin_projected(&ids);
                        self.spline_map.insert(id.clone(), ids);
                    }
                }
            },
            Entity::Other { .. } => {}
        }
    }

    fn is_line(&self, id: &str) -> bool {
        self.ends.contains_key(id)
    }

    fn is_round(&self, id: &str) -> bool {
        self.centers.contains_key(id) || self.arc_map.contains_key(id)
    }

    fn kind_of(&self, id: &str) -> Option<Kind> {
        if self.ends.contains_key(id) {
            Some(Kind::Line)
        } else if self.centers.contains_key(id) {
            Some(Kind::Circle)
        } else if self.arc_map.contains_key(id) {
            Some(Kind::Arc)
        } else {
            None
        }
    }

    /// 0 start, 1 end, 2 arc centre.
    fn endpoint_point(&self, ent: &str, p: f64) -> Option<String> {
        let i = idx(p);
        if let Some(rc) = self.rect_map.get(ent) {
            return usize::try_from(i).ok().and_then(|i| rc.get(i)).cloned();
        }
        if let Some(c) = self.centers.get(ent) {
            return Some(c.clone());
        }
        if let Some(ln) = self.ends.get(ent) {
            return Some(if i == 0 { ln[0].clone() } else { ln[1].clone() });
        }
        if let Some(a) = self.arc_map.get(ent) {
            return Some(match i {
                2 => a.center.clone(),
                0 => a.our_s.clone(),
                _ => a.our_e.clone(),
            });
        }
        if let Some(pt) = self.point_map.get(ent) {
            return Some(pt.clone());
        }
        if let Some(sp) = self.spline_map.get(ent) {
            return if i == 0 { sp.first() } else { sp.last() }.cloned();
        }
        if let Some(poles) = self.pole_map.get(ent) {
            return pole_of_ref(i, poles.len()).and_then(|k| poles.get(k)).cloned();
        }
        None
    }

    fn center_point(&self, ent: &str) -> Option<String> {
        self.centers.get(ent).or_else(|| self.arc_map.get(ent).map(|a| &a.center)).cloned()
    }

    fn dim_point(&self, ent: &str, p: f64) -> Option<String> {
        if let Some(rc) = self.rect_map.get(ent) {
            return usize::try_from(idx(p)).ok().and_then(|i| rc.get(i)).cloned();
        }
        if let Some(c) = self.centers.get(ent) {
            return Some(c.clone());
        }
        if idx(p) == 2 {
            return self.arc_map.get(ent).map(|a| a.center.clone());
        }
        self.endpoint_point(ent, p)
    }

    fn user_constraint(&mut self, i: usize, c: &Constraint) {
        let id = constraint_key(i);
        if c.is_driven() {
            return;
        }
        let s = |x: &String| x.clone();
        match c {
            Constraint::Horizontal { line } if self.is_line(line) => {
                self.push(id, SConstraint::Horizontal { line: s(line) });
            }
            Constraint::Vertical { line } if self.is_line(line) => self.push(id, SConstraint::Vertical { line: s(line) }),
            Constraint::Parallel { l1, l2 } if self.is_line(l1) && self.is_line(l2) => {
                self.push(id, SConstraint::Parallel { l1: s(l1), l2: s(l2) });
            }
            Constraint::Perpendicular { l1, l2 } if self.is_line(l1) && self.is_line(l2) => {
                self.push(id, SConstraint::Perpendicular { l1: s(l1), l2: s(l2) });
            }
            Constraint::Equal { l1, l2 } if self.is_line(l1) && self.is_line(l2) => {
                self.push(id, SConstraint::Equal { l1: s(l1), l2: s(l2) });
            }
            Constraint::Distance { line, value, .. } => {
                if let Some([a, b]) = self.ends.get(line).cloned() {
                    self.push(id, SConstraint::Distance { a, b, value: *value });
                }
            }
            Constraint::P2pDistance { e1, p1, e2, p2, value, .. } => {
                if let (Some(a), Some(b)) = (self.dim_point(e1, *p1), self.dim_point(e2, *p2)) {
                    if a != b {
                        self.push(id, SConstraint::Distance { a, b, value: *value });
                    }
                }
            }
            Constraint::HDistance { e1, p1, e2, p2, value, .. } | Constraint::VDistance { e1, p1, e2, p2, value, .. } => {
                let axis = if matches!(c, Constraint::HDistance { .. }) { Axis::X } else { Axis::Y };
                if let (Some(a), Some(b)) = (self.dim_point(e1, *p1), self.dim_point(e2, *p2)) {
                    if a != b {
                        self.push(id, SConstraint::AxisDistance { a, b, axis, value: *value });
                    }
                }
            }
            Constraint::P2lDistance { e, p, line, value, .. } => {
                if let (Some(p), true) = (self.dim_point(e, *p), self.is_line(line)) {
                    self.push(id, SConstraint::P2lDistance { p, line: s(line), value: *value });
                }
            }
            Constraint::Diameter { circle, value, .. } => {
                if self.centers.contains_key(circle) {
                    self.push(id, SConstraint::Diameter { circle: s(circle), value: *value });
                } else if self.arc_map.contains_key(circle) {
                    // planegcs has no arc diameter, so an arc's diameter dimension is half as a radius.
                    self.push(id, SConstraint::ArcRadius { arc: s(circle), value: value / 2.0 });
                }
            }
            Constraint::RadialGap { inner, outer, value, .. } => {
                if self.is_round(inner) && self.is_round(outer) && inner != outer {
                    self.push(id, SConstraint::RadiusDifference { inner: s(inner), outer: s(outer), value: *value });
                }
            }
            Constraint::C2cDistance { c1, c2, value, .. } => {
                if self.is_round(c1) && self.is_round(c2) && c1 != c2 {
                    self.push(id, SConstraint::RimGap { round1: s(c1), round2: s(c2), value: *value });
                }
            }
            Constraint::C2lDistance { circle, line, value, .. } => {
                if self.is_round(circle) && self.is_line(line) {
                    self.push(id, SConstraint::RimLine { round: s(circle), line: s(line), value: *value });
                }
            }
            Constraint::P2cDistance { e, p, circle, value, .. } => {
                if let (Some(p), true) = (self.dim_point(e, *p), self.is_round(circle)) {
                    self.push(id, SConstraint::RimPoint { p, round: s(circle), value: *value });
                }
            }
            Constraint::Tangent { line, circle } if self.is_line(line) && self.centers.contains_key(circle) => {
                self.push(id, SConstraint::TangentLC { line: s(line), circle: s(circle) });
            }
            // A join the position merge already fused would be p2p_coincident(P, P), which planegcs reports redundant.
            Constraint::Coincident { e1, p1, e2, p2 } => {
                if let (Some(a), Some(b)) = (self.endpoint_point(e1, *p1), self.endpoint_point(e2, *p2)) {
                    if a != b {
                        self.push(id, SConstraint::Coincident { a, b });
                    }
                }
            }
            Constraint::Concentric { c1, c2 } => {
                if let (Some(a), Some(b)) = (self.center_point(c1), self.center_point(c2)) {
                    if a != b {
                        self.push(id, SConstraint::Coincident { a, b });
                    }
                }
            }
            Constraint::HorizontalPoints { e1, p1, e2, p2 } | Constraint::VerticalPoints { e1, p1, e2, p2 } => {
                let axis = if matches!(c, Constraint::HorizontalPoints { .. }) { Axis::Y } else { Axis::X };
                if let (Some(a), Some(b)) = (self.endpoint_point(e1, *p1), self.endpoint_point(e2, *p2)) {
                    if a != b {
                        self.push(id, SConstraint::AxisDistance { a, b, axis, value: 0.0 });
                    }
                }
            }
            Constraint::Midpoint { e, p, line } => {
                if let (Some(p), true) = (self.endpoint_point(e, *p), self.is_line(line)) {
                    self.push(format!("{id}a"), SConstraint::PointOnLine { p: p.clone(), line: s(line) });
                    self.push(format!("{id}b"), SConstraint::PointOnPerpBisector { p, line: s(line) });
                }
            }
            Constraint::PointOnCurve { e, p, curve } => {
                if let Some(p) = self.endpoint_point(e, *p) {
                    match self.kind_of(curve) {
                        Some(Kind::Line) => self.push(id, SConstraint::PointOnLine { p, line: s(curve) }),
                        Some(Kind::Circle) => self.push(id, SConstraint::PointOnCircle { p, circle: s(curve) }),
                        Some(Kind::Arc) => self.push(id, SConstraint::PointOnArc { p, arc: s(curve) }),
                        None => {}
                    }
                }
            }
            Constraint::Symmetric { e1, p1, e2, p2, line } => {
                if let (Some(a), Some(b), true) =
                    (self.endpoint_point(e1, *p1), self.endpoint_point(e2, *p2), self.is_line(line))
                {
                    self.push(id, SConstraint::Symmetric { a, b, line: s(line) });
                }
            }
            Constraint::Angle { l1, l2, value, rays, .. } if self.is_line(l1) && self.is_line(l2) => {
                let value = solver_angle_deg(*value, *rays) * PI / 180.0;
                self.push(id, SConstraint::AngleLL { l1: s(l1), l2: s(l2), value });
            }
            Constraint::Radius { e, value, .. } => {
                if self.centers.contains_key(e) {
                    self.push(id, SConstraint::CircleRadius { circle: s(e), value: *value });
                } else if self.arc_map.contains_key(e) {
                    self.push(id, SConstraint::ArcRadius { arc: s(e), value: *value });
                }
            }
            Constraint::Fix { e, p } => {
                if let Some(p) = self.dim_point(e, *p) {
                    self.fixed_pts.insert(p);
                }
            }
            Constraint::Collinear { l1, l2 } => {
                if let (Some(e1), Some(e2)) = (self.ends.get(l1).cloned(), self.ends.get(l2).cloned()) {
                    // Lines sharing a point need only their far end on l1, a parallel on top of it is redundant.
                    let far: Vec<String> = e2.iter().filter(|p| !e1.contains(p)).cloned().collect();
                    if far.len() == 2 {
                        self.push(format!("{id}p"), SConstraint::Parallel { l1: s(l1), l2: s(l2) });
                    }
                    if let Some(p) = far.into_iter().next() {
                        self.push(format!("{id}o"), SConstraint::PointOnLine { p, line: s(l1) });
                    }
                }
            }
            Constraint::EqualRadius { a, b } => match (self.kind_of(a), self.kind_of(b)) {
                (Some(Kind::Circle), Some(Kind::Circle)) => {
                    self.push(id, SConstraint::EqualRadiusCC { c1: s(a), c2: s(b) });
                }
                (Some(Kind::Arc), Some(Kind::Arc)) => self.push(id, SConstraint::EqualRadiusAA { a1: s(a), a2: s(b) }),
                (Some(Kind::Circle), Some(Kind::Arc)) => {
                    self.push(id, SConstraint::EqualRadiusCA { circle: s(a), arc: s(b) });
                }
                (Some(Kind::Arc), Some(Kind::Circle)) => {
                    self.push(id, SConstraint::EqualRadiusCA { circle: s(b), arc: s(a) });
                }
                _ => {}
            },
            Constraint::Tangent2 { a, b } => {
                let t = match (self.kind_of(a), self.kind_of(b)) {
                    (Some(Kind::Line), Some(Kind::Circle)) => SConstraint::TangentLC { line: s(a), circle: s(b) },
                    (Some(Kind::Circle), Some(Kind::Line)) => SConstraint::TangentLC { line: s(b), circle: s(a) },
                    (Some(Kind::Line), Some(Kind::Arc)) => SConstraint::TangentLA { line: s(a), arc: s(b) },
                    (Some(Kind::Arc), Some(Kind::Line)) => SConstraint::TangentLA { line: s(b), arc: s(a) },
                    (Some(Kind::Circle), Some(Kind::Circle)) => SConstraint::TangentCC { c1: s(a), c2: s(b) },
                    (Some(Kind::Arc), Some(Kind::Arc)) => SConstraint::TangentAA { a1: s(a), a2: s(b) },
                    (Some(Kind::Circle), Some(Kind::Arc)) => SConstraint::TangentCA { circle: s(a), arc: s(b) },
                    (Some(Kind::Arc), Some(Kind::Circle)) => SConstraint::TangentCA { circle: s(b), arc: s(a) },
                    _ => return,
                };
                self.push(id, t);
            }
            Constraint::Offset { pairs, value, .. } => {
                // p2l_distance is unsigned, the rim branch guard holds the side.
                let mag = value.abs();
                for (n, pr) in pairs.iter().enumerate() {
                    // A rectangle edge is already direction locked by the rectangle's implicit rules, so one distance
                    // and no parallel: 4 edges by 1 equation is exactly its 4 DOF.
                    let rect_edge = pr.src.contains('~') && pr.cpy.contains('~');
                    if self.is_line(&pr.src) && self.is_line(&pr.cpy) {
                        let Some([e0, _]) = self.ends.get(&pr.cpy).cloned() else { continue };
                        if !rect_edge {
                            self.push(format!("{id}p{n}"), SConstraint::Parallel { l1: s(&pr.src), l2: s(&pr.cpy) });
                        }
                        // With the copy parallel a second p2l_distance is redundant.
                        self.push(format!("{id}a{n}"), SConstraint::P2lDistance { p: e0, line: s(&pr.src), value: mag });
                    } else if self.is_round(&pr.src) && self.is_round(&pr.cpy) && pr.src != pr.cpy {
                        if let (Some(a), Some(b)) = (self.center_point(&pr.src), self.center_point(&pr.cpy)) {
                            self.push(format!("{id}c{n}"), SConstraint::Coincident { a, b });
                        }
                        // Signed, so the copy cannot cross its source as a p2l_distance can.
                        let value = if pr.flip { -value } else { *value };
                        self.push(
                            format!("{id}r{n}"),
                            SConstraint::RadiusDifference { inner: s(&pr.src), outer: s(&pr.cpy), value },
                        );
                    }
                }
            }
            _ => {}
        }
    }

    /// Holds one shape's X, Y or radius where it is. planegcs counts DOF by rank, so a hold lowers the DOF only when
    /// the shape was free that way.
    fn probe(&mut self, probe: &Probe) {
        let pid = format!("{}~probe", probe.entity);
        if probe.axis == ProbeAxis::Size {
            if let Some(c) = self.circles.iter().find(|c| c.id == probe.entity) {
                let c = SConstraint::CircleRadius { circle: c.id.clone(), value: c.radius };
                self.push(pid, c);
            } else if let Some(a) = self.arcs.iter().find(|a| a.id == probe.entity) {
                let c = SConstraint::ArcRadius { arc: a.id.clone(), value: a.radius };
                self.push(pid, c);
            }
            return;
        }
        let e = &probe.entity;
        let mut own: HashSet<String> = HashSet::new();
        own.extend(self.ends.get(e).into_iter().flatten().cloned());
        own.extend(self.rect_map.get(e).into_iter().flatten().cloned());
        own.extend(self.spline_map.get(e).into_iter().flatten().cloned());
        own.extend(self.pole_map.get(e).into_iter().flatten().cloned());
        if let Some(a) = self.arc_map.get(e) {
            own.extend([a.our_s.clone(), a.our_e.clone(), a.center.clone()]);
        }
        own.extend(self.centers.get(e).cloned());
        own.extend(self.point_map.get(e).cloned());
        let mine: Vec<(String, f64, f64)> =
            self.points.iter().filter(|q| own.contains(&q.id)).map(|q| (q.id.clone(), q.x, q.y)).collect();
        let axis = if probe.axis == ProbeAxis::X { Axis::X } else { Axis::Y };
        for (n, (pid, x, y)) in mine.into_iter().enumerate() {
            let held = self.get_point(x, y, false);
            self.fixed_pts.insert(held.clone());
            self.push(format!("{}~probe{n}", probe.entity), SConstraint::AxisDistance { a: held, b: pid, axis, value: 0.0 });
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Line,
    Circle,
    Arc,
}

pub fn compile_and_solve(
    entities: &[Entity],
    constraints: &[Constraint],
    drag: Option<DragReq>,
    opts: &SolveOpts,
) -> Result<SolvePass, SolveError> {
    let mut k = Compiler::default();
    for e in entities {
        k.entity(e, opts.hold_axes);
    }
    for (i, c) in constraints.iter().enumerate() {
        k.user_constraint(i, c);
    }
    if let Some(p) = &opts.probe {
        k.probe(p);
    }
    if let Some(pin) = opts.pin {
        if let Some(p) = k.by_key.get(&coinc_key(pin.x, pin.y)).cloned() {
            k.fixed_pts.insert(p);
        }
    }
    for p in &mut k.points {
        if k.fixed_pts.contains(&p.id) {
            p.fixed = true;
        }
    }

    let mut drag_input = None;
    let mut drag_refused = None;
    if let Some(d) = drag {
        // Coincident endpoints have merged into one point, so a grabbed corner moves as a unit.
        let mut best: Option<&SPoint> = None;
        let mut best_d = f64::INFINITY;
        for p in &k.points {
            let dd = (p.x - d.from.x).powi(2) + (p.y - d.from.y).powi(2);
            if dd < best_d {
                best_d = dd;
                best = Some(p);
            }
        }
        match best {
            Some(b) if !b.fixed => drag_input = Some(Drag { point: b.id.clone(), x: d.to.x, y: d.to.y }),
            Some(b) => {
                drag_refused =
                    Some(if k.proj_pts.contains(&b.id) { DragRefused::Projected } else { DragRefused::Fix });
            }
            None => {}
        }
    }

    let r = solve_sketch(&SolveInput {
        points: k.points.clone(),
        lines: k.lines.clone(),
        circles: k.circles.clone(),
        arcs: k.arcs.clone(),
        constraints: k.cons.clone(),
        drag: drag_input,
    })?;

    let mut conflicts = r.conflicts.clone();
    let mut redundant = r.redundant.clone();
    // planegcs never sees a constraint whose operands are all fixed and accepts it even when violated, so classify
    // these inert ones here. Without fixed points nothing can be inert, so ordinary sketches and drags skip this.
    if !k.fixed_pts.is_empty() {
        let inert = Inert::new(&k);
        for c in &k.cons {
            if constraint_index_of(&c.id).is_none() {
                continue;
            }
            let Some(res) = inert.residual(&c.c) else { continue };
            let list = if res <= INERT_TOL { &mut redundant } else { &mut conflicts };
            if !list.contains(&c.id) {
                list.push(c.id.clone());
            }
        }
    }

    let out: Vec<Entity> = entities.iter().map(|e| write_entity(&k, &r, e)).collect();

    // planegcs reports success for a radius through zero or an inside out rim distance (p2c, c2l and nested
    // c2cdistance are unsigned). Blame the constraints and return the pre-solve geometry.
    let bad = |x: f64| !x.is_finite() || x <= RIM_EPS;
    let bad_geom: HashSet<&str> =
        r.circles.iter().chain(r.arcs.iter()).filter(|(_, rad)| bad(**rad)).map(|(id, _)| id.as_str()).collect();
    let mut guard_ids: Vec<String> = Vec::new();
    if !bad_geom.is_empty() {
        for c in &k.cons {
            if constraint_index_of(&c.id).is_some() && round_refs(&c.c).iter().any(|id| bad_geom.contains(id)) {
                guard_ids.push(c.id.clone());
            }
        }
    }
    // A rim dimension must still describe the configuration it was created in, the solver's branches can't be trusted.
    if constraints.iter().any(is_rim_dim) {
        let before: HashMap<&str, &Entity> = entities.iter().map(|e| (e.id(), e)).collect();
        let after: HashMap<&str, &Entity> = out.iter().map(|e| (e.id(), e)).collect();
        for (i, c) in constraints.iter().enumerate() {
            if c.is_driven() || !is_rim_dim(c) {
                continue;
            }
            if let Some(cls) = rim_branch(c, &before) {
                let id = constraint_key(i);
                if !same_branch(&cls, rim_branch(c, &after).as_deref()) && !guard_ids.contains(&id) {
                    guard_ids.push(id);
                }
            }
        }
    }
    let mut over_defined = redundant;
    over_defined.extend(r.partially_redundant.iter().cloned());
    if !guard_ids.is_empty() || !bad_geom.is_empty() {
        for id in guard_ids {
            if !conflicts.contains(&id) {
                conflicts.push(id);
            }
        }
        return Ok(SolvePass { entities: entities.to_vec(), dof: r.dof, ok: false, conflicts, over_defined, drag_refused });
    }
    let ok = r.ok && conflicts.len() == r.conflicts.len();
    Ok(SolvePass { entities: out, dof: r.dof, ok, conflicts, over_defined, drag_refused })
}

fn write_entity(k: &Compiler, r: &SolveResult, e: &Entity) -> Entity {
    let at = |id: &String| r.points.get(id).map(|&(x, y)| v(x, y));
    match e {
        Entity::Line { id, .. } => {
            let Some([p1, p2]) = k.ends.get(id) else { return e.clone() };
            match (at(p1), at(p2)) {
                (Some(a), Some(b)) => Entity::Line { id: id.clone(), x1: a.x, y1: a.y, x2: b.x, y2: b.y },
                _ => e.clone(),
            }
        }
        Entity::Circle { id, radius, .. } => match k.centers.get(id).and_then(at) {
            Some(c) => Entity::Circle { id: id.clone(), x: c.x, y: c.y, radius: r.circles.get(id).copied().unwrap_or(*radius) },
            None => e.clone(),
        },
        Entity::Rectangle { id, x, y, width, height, angle } => {
            let Some(cp) = k.rect_map.get(id) else { return e.clone() };
            let pts: Option<Vec<V>> = cp.iter().map(at).collect();
            let Some(pts) = pts else { return e.clone() };
            if *angle != 0.0 && !angle.is_nan() {
                // Read back from the solved corners, the tool's three point recovery. Unmoved pinned corners are not
                // re-derived (200 degrees became -160.00000000000003).
                let was = rect_corners(*x, *y, *width, *height, *angle);
                if pts.iter().zip(was.iter()).all(|(p, w)| p.x == w.x && p.y == w.y) {
                    return e.clone();
                }
                return match rect_from_three_points(pts[0], pts[1], pts[2]) {
                    Some(rec) => Entity::Rectangle {
                        id: id.clone(),
                        x: rec.x,
                        y: rec.y,
                        width: rec.width,
                        height: rec.height,
                        angle: rec.angle,
                    },
                    None => e.clone(),
                };
            }
            let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
            let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
            let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
            Entity::Rectangle {
                id: id.clone(),
                x: (min_x + max_x) / 2.0,
                y: (min_y + max_y) / 2.0,
                width: max_x - min_x,
                height: max_y - min_y,
                angle: *angle,
            }
        }
        Entity::Arc { id, .. } => {
            let Some(m) = k.arc_map.get(id) else { return e.clone() };
            let (Some(s), Some(en), Some(c)) = (at(&m.our_s), at(&m.our_e), at(&m.center)) else { return e.clone() };
            // The through point is mid sweep, robust to the solver's angle normalisation.
            let rad = r.arcs.get(id).copied().unwrap_or_else(|| (s.x - c.x).hypot(s.y - c.y));
            let (from, to) = if m.start_is_our_s { (s, en) } else { (en, s) };
            let a_from = (from.y - c.y).atan2(from.x - c.x);
            let a_to = (to.y - c.y).atan2(to.x - c.x);
            let mid = a_from + ccw_delta(a_from, a_to) / 2.0;
            Entity::Arc {
                id: id.clone(),
                x1: s.x,
                y1: s.y,
                x2: en.x,
                y2: en.y,
                mx: c.x + mid.cos() * rad,
                my: c.y + mid.sin() * rad,
            }
        }
        Entity::Spline { id, points } => {
            let Some(ids) = k.spline_map.get(id) else { return e.clone() };
            let points = points.iter().enumerate().map(|(n, o)| ids.get(n).and_then(at).unwrap_or(*o)).collect();
            Entity::Spline { id: id.clone(), points }
        }
        Entity::Bspline { id, poles, closed } => {
            let Some(ids) = k.pole_map.get(id) else { return e.clone() };
            let poles = poles.iter().enumerate().map(|(n, o)| ids.get(n).and_then(at).unwrap_or(*o)).collect();
            Entity::Bspline { id: id.clone(), poles, closed: *closed }
        }
        Entity::Point { id, .. } => match k.point_map.get(id).and_then(at) {
            Some(p) => Entity::Point { id: id.clone(), x: p.x, y: p.y },
            None => e.clone(),
        },
        Entity::Projected { .. } | Entity::Other { .. } => e.clone(),
    }
}

/// Residuals of constraints whose operands are all fixed, over the input positions (fixed means input equals solved).
struct Inert<'a> {
    k: &'a Compiler,
    pos: HashMap<&'a str, V>,
    lines: HashMap<&'a str, (&'a str, &'a str)>,
    radius: HashMap<&'a str, f64>,
    center: HashMap<&'a str, &'a str>,
}

impl<'a> Inert<'a> {
    fn new(k: &'a Compiler) -> Self {
        Inert {
            k,
            pos: k.points.iter().map(|p| (p.id.as_str(), v(p.x, p.y))).collect(),
            lines: k.lines.iter().map(|l| (l.id.as_str(), (l.p1.as_str(), l.p2.as_str()))).collect(),
            radius: k
                .circles
                .iter()
                .map(|c| (c.id.as_str(), c.radius))
                .chain(k.arcs.iter().map(|a| (a.id.as_str(), a.radius)))
                .collect(),
            center: k
                .circles
                .iter()
                .map(|c| (c.id.as_str(), c.center.as_str()))
                .chain(k.arcs.iter().map(|a| (a.id.as_str(), a.center.as_str())))
                .collect(),
        }
    }

    fn fx(&self, id: &str) -> bool {
        self.k.fixed_pts.contains(id)
    }
    fn fx_line(&self, id: &str) -> bool {
        self.lines.get(id).is_some_and(|(a, b)| self.fx(a) && self.fx(b))
    }
    fn fx_round(&self, id: &str) -> bool {
        self.k.proj_rounds.contains(id)
    }
    fn p(&self, id: &str) -> V {
        self.pos[id]
    }
    fn dist(&self, a: &str, b: &str) -> f64 {
        let (a, b) = (self.p(a), self.p(b));
        (a.x - b.x).hypot(a.y - b.y)
    }
    fn ends(&self, line: &str) -> (V, V) {
        let (a, b) = self.lines[line];
        (self.p(a), self.p(b))
    }
    fn dir(&self, line: &str) -> V {
        let (a, b) = self.ends(line);
        let len = (b.x - a.x).hypot(b.y - a.y);
        let len = if len == 0.0 { 1.0 } else { len };
        v((b.x - a.x) / len, (b.y - a.y) / len)
    }
    fn perp(&self, p: &str, line: &str) -> f64 {
        let (a, b) = self.ends(line);
        let q = self.p(p);
        let len = (b.x - a.x).hypot(b.y - a.y);
        let len = if len == 0.0 { 1.0 } else { len };
        ((q.x - a.x) * (b.y - a.y) - (q.y - a.y) * (b.x - a.x)).abs() / len
    }
    fn rad(&self, id: &str) -> f64 {
        self.radius[id]
    }
    fn ctr(&self, id: &str) -> &str {
        self.center[id]
    }
    fn tangent(&self, a: &str, b: &str) -> f64 {
        let d = self.dist(self.ctr(a), self.ctr(b));
        let (r1, r2) = (self.rad(a), self.rad(b));
        (d - (r1 + r2)).abs().min((d - (r1 - r2).abs()).abs())
    }

    /// None while any operand is still free.
    fn residual(&self, c: &SConstraint) -> Option<f64> {
        use SConstraint as S;
        let lines2 = |l1: &str, l2: &str| self.fx_line(l1) && self.fx_line(l2);
        let rounds2 = |a: &str, b: &str| self.fx_round(a) && self.fx_round(b);
        Some(match c {
            // Self coincident, both ends merged into one point, is absorbed by the merge.
            S::Coincident { a, b } if a != b && self.fx(a) && self.fx(b) => self.dist(a, b),
            S::Horizontal { line } if self.fx_line(line) => {
                let (a, b) = self.ends(line);
                (a.y - b.y).abs()
            }
            S::Vertical { line } if self.fx_line(line) => {
                let (a, b) = self.ends(line);
                (a.x - b.x).abs()
            }
            S::Parallel { l1, l2 } if lines2(l1, l2) => {
                let (d1, d2) = (self.dir(l1), self.dir(l2));
                (d1.x * d2.y - d1.y * d2.x).abs()
            }
            S::Perpendicular { l1, l2 } if lines2(l1, l2) => {
                let (d1, d2) = (self.dir(l1), self.dir(l2));
                (d1.x * d2.x + d1.y * d2.y).abs()
            }
            S::Equal { l1, l2 } if lines2(l1, l2) => {
                let (a1, b1) = self.lines[l1.as_str()];
                let (a2, b2) = self.lines[l2.as_str()];
                (self.dist(a1, b1) - self.dist(a2, b2)).abs()
            }
            S::Distance { a, b, value } if self.fx(a) && self.fx(b) => (self.dist(a, b) - value).abs(),
            S::AxisDistance { a, b, axis, value } if self.fx(a) && self.fx(b) => {
                let (pa, pb) = (self.p(a), self.p(b));
                let d = if *axis == Axis::X { pb.x - pa.x } else { pb.y - pa.y };
                (d - value).abs()
            }
            S::P2lDistance { p, line, value } if self.fx(p) && self.fx_line(line) => (self.perp(p, line) - value).abs(),
            S::Diameter { circle, value } if self.fx_round(circle) => (2.0 * self.rad(circle) - value).abs(),
            S::CircleRadius { circle, value } if self.fx_round(circle) => (self.rad(circle) - value).abs(),
            S::ArcRadius { arc, value } if self.fx_round(arc) => (self.rad(arc) - value).abs(),
            S::TangentLC { line, circle: r } | S::TangentLA { line, arc: r } if self.fx_line(line) && self.fx_round(r) => {
                (self.perp(self.ctr(r), line) - self.rad(r)).abs()
            }
            S::TangentCC { c1: a, c2: b } | S::TangentCA { circle: a, arc: b } | S::TangentAA { a1: a, a2: b }
                if rounds2(a, b) =>
            {
                self.tangent(a, b)
            }
            S::AngleLL { l1, l2, value } if lines2(l1, l2) => {
                let (d1, d2) = (self.dir(l1), self.dir(l2));
                let actual = (d1.x * d2.y - d1.y * d2.x).atan2(d1.x * d2.x + d1.y * d2.y);
                ((((actual - value) % TAU) + TAU + PI) % TAU - PI).abs()
            }
            S::EqualRadiusCC { c1: a, c2: b } | S::EqualRadiusCA { circle: a, arc: b } | S::EqualRadiusAA { a1: a, a2: b }
                if rounds2(a, b) =>
            {
                (self.rad(a) - self.rad(b)).abs()
            }
            S::PointOnLine { p, line } if self.fx(p) && self.fx_line(line) => self.perp(p, line),
            S::PointOnCircle { p, circle: r } | S::PointOnArc { p, arc: r } if self.fx(p) && self.fx_round(r) => {
                (self.dist(p, self.ctr(r)) - self.rad(r)).abs()
            }
            S::PointOnPerpBisector { p, line } if self.fx(p) && self.fx_line(line) => {
                let (a, b) = self.lines[line.as_str()];
                (self.dist(p, a) - self.dist(p, b)).abs()
            }
            S::Symmetric { a, b, line } if self.fx(a) && self.fx(b) && self.fx_line(line) => {
                let (la, _) = self.ends(line);
                let d = self.dir(line);
                let (pa, pb) = (self.p(a), self.p(b));
                let t = (pa.x - la.x) * d.x + (pa.y - la.y) * d.y;
                let (mx, my) = (2.0 * (la.x + t * d.x) - pa.x, 2.0 * (la.y + t * d.y) - pa.y);
                (mx - pb.x).hypot(my - pb.y)
            }
            S::RimGap { round1, round2, value } if rounds2(round1, round2) => {
                let (g1, g2) = (self.rad(round1), self.rad(round2));
                let d = self.dist(self.ctr(round1), self.ctr(round2));
                let rd = (g1 - g2).abs();
                ((if d < rd { rd - d } else { d - g1 - g2 }) - value).abs()
            }
            S::RimLine { round, line, value } if self.fx_round(round) && self.fx_line(line) => {
                (self.perp(self.ctr(round), line) - self.rad(round) - value).abs()
            }
            S::RimPoint { p, round, value } if self.fx(p) && self.fx_round(round) => {
                ((self.dist(p, self.ctr(round)) - self.rad(round)).abs() - value).abs()
            }
            S::RadiusDifference { inner, outer, value } if rounds2(inner, outer) => {
                (self.rad(outer) - self.rad(inner) - value).abs()
            }
            _ => return None,
        })
    }
}

/// The blame list when one of them solves to a non positive radius.
fn round_refs(c: &SConstraint) -> Vec<&str> {
    use SConstraint as S;
    match c {
        S::Diameter { circle, .. } | S::CircleRadius { circle, .. } | S::TangentLC { circle, .. } => vec![circle],
        S::ArcRadius { arc, .. } | S::TangentLA { arc, .. } => vec![arc],
        S::RimGap { round1, round2, .. } => vec![round1, round2],
        S::RimLine { round, .. } | S::RimPoint { round, .. } => vec![round],
        S::RadiusDifference { inner, outer, .. } => vec![inner, outer],
        S::TangentCC { c1, c2 } | S::EqualRadiusCC { c1, c2 } => vec![c1, c2],
        S::TangentCA { circle, arc } | S::EqualRadiusCA { circle, arc } => vec![circle, arc],
        S::TangentAA { a1, a2 } | S::EqualRadiusAA { a1, a2 } => vec![a1, a2],
        _ => vec![],
    }
}

/// `radialGap` is absent on purpose, `difference` is signed so it cannot invert an annulus by itself.
fn is_rim_dim(c: &Constraint) -> bool {
    matches!(
        c,
        Constraint::C2cDistance { .. }
            | Constraint::P2cDistance { .. }
            | Constraint::C2lDistance { .. }
            | Constraint::Offset { .. }
    )
}

/// A plain entity id or a rectangle edge `<rect>~<k>`, k 0 to 3 in `rect_corners` order.
fn line_operand(by_id: &HashMap<&str, &Entity>, id: &str) -> Option<(V, V)> {
    let Some(t) = id.find('~') else { return by_id.get(id)?.as_line_seg() };
    let k: usize = id[t + 1..].parse().ok().filter(|k| *k <= 3)?;
    let Entity::Rectangle { x, y, width, height, angle, .. } = by_id.get(&id[..t])? else { return None };
    let c = rect_corners(*x, *y, *width, *height, *angle);
    Some((c[k], c[(k + 1) % 4]))
}

fn rim_nesting(c1: (V, f64), c2: (V, f64)) -> &'static str {
    if (c2.0.x - c1.0.x).hypot(c2.0.y - c1.0.y) >= (c1.1 - c2.1).abs() {
        return "null";
    }
    if c1.1 > c2.1 {
        "c2"
    } else {
        "c1"
    }
}

/// None for non rim dimensions or gone operands. Comparing it across a solve stops an annulus inverting, a point
/// crossing a rim or a circle hopping sides of a line while the number stays satisfied.
fn rim_branch(c: &Constraint, by_id: &HashMap<&str, &Entity>) -> Option<String> {
    let round = |id: &str| by_id.get(id).and_then(|e| e.as_round());
    match c {
        Constraint::C2cDistance { c1, c2, .. } => Some(format!("nest:{}", rim_nesting(round(c1)?, round(c2)?))),
        Constraint::P2cDistance { e, p, circle, .. } => {
            let q = by_id.get(e.as_str())?.ref_point(idx(*p))?;
            let (cc, r) = round(circle)?;
            Some(format!("side:{}", if (q.x - cc.x).hypot(q.y - cc.y) >= r { "out" } else { "in" }))
        }
        Constraint::C2lDistance { circle, line, .. } => {
            let (cc, r) = round(circle)?;
            let (a, b) = line_operand(by_id, line)?;
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let len = dx.hypot(dy);
            let dist = ((cc.x - a.x) * dy - (cc.y - a.y) * dx) / if len == 0.0 { 1.0 } else { len };
            let side = if dist.abs() < RIM_EPS {
                "on"
            } else if dist > 0.0 {
                "+"
            } else {
                "-"
            };
            Some(format!("side:{side}:{}", if dist.abs() >= r { "out" } else { "in" }))
        }
        Constraint::Offset { pairs, .. } => {
            // Only line pairs can flip, their p2l_distance is unsigned. Round pairs use the signed difference.
            let sides: String = pairs
                .iter()
                .map(|pr| match (line_operand(by_id, &pr.src), line_operand(by_id, &pr.cpy)) {
                    (Some((a, b)), Some((t1, t2))) => {
                        let (dx, dy) = (b.x - a.x, b.y - a.y);
                        let (mx, my) = ((t1.x + t2.x) / 2.0, (t1.y + t2.y) / 2.0);
                        if (mx - a.x) * dy - (my - a.y) * dx >= 0.0 {
                            '+'
                        } else {
                            '-'
                        }
                    }
                    _ => '.',
                })
                .collect();
            (!sides.is_empty()).then(|| format!("off:{sides}"))
        }
        _ => None,
    }
}

/// A centre on the line is on neither side, so it may leave it for either and still be the same configuration.
fn same_branch(before: &str, after: Option<&str>) -> bool {
    let a: Vec<&str> = before.split(':').collect();
    let b: Vec<&str> = after.map(|s| s.split(':').collect()).unwrap_or_default();
    a.len() == b.len() && a.iter().zip(&b).all(|(x, y)| x == y || *x == "on" || *y == "on")
}
