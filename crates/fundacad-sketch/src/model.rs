//! Sketch entities with every number resolved, and constraints in FundaCAD 1's shape, with the conversions from and
//! back to the document schema.

use fundacad_core::schema::sketch::{ProjectedCurve, SketchConstraint, SketchEntity};
use fundacad_core::schema::{Num, UnresolvedNum};
use serde::Deserialize;

use crate::geom::{circumcenter, pole_ref, rect_corners, v, V};

#[derive(Debug, Clone, PartialEq)]
pub enum Curve {
    Line { x1: f64, y1: f64, x2: f64, y2: f64 },
    Circle { x: f64, y: f64, r: f64 },
    Arc { x1: f64, y1: f64, x2: f64, y2: f64, mx: f64, my: f64 },
    Poly(Vec<V>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entity {
    Line { id: String, x1: f64, y1: f64, x2: f64, y2: f64 },
    Circle { id: String, x: f64, y: f64, radius: f64 },
    /// `angle` in degrees about the centre, 0 when the document has none.
    Rectangle { id: String, x: f64, y: f64, width: f64, height: f64, angle: f64 },
    /// Start, end and a point the arc passes through.
    Arc { id: String, x1: f64, y1: f64, x2: f64, y2: f64, mx: f64, my: f64 },
    Spline { id: String, points: Vec<V> },
    Bspline { id: String, poles: Vec<V>, closed: bool },
    Point { id: String, x: f64, y: f64 },
    Projected { id: String, curve: Curve },
    /// Ellipses, polygons, slots and text never reach the solver.
    Other { id: String },
}

impl Entity {
    pub fn id(&self) -> &str {
        match self {
            Entity::Line { id, .. }
            | Entity::Circle { id, .. }
            | Entity::Rectangle { id, .. }
            | Entity::Arc { id, .. }
            | Entity::Spline { id, .. }
            | Entity::Bspline { id, .. }
            | Entity::Point { id, .. }
            | Entity::Projected { id, .. }
            | Entity::Other { id } => id,
        }
    }

    pub fn as_line_seg(&self) -> Option<(V, V)> {
        match self {
            Entity::Line { x1, y1, x2, y2, .. } | Entity::Projected { curve: Curve::Line { x1, y1, x2, y2 }, .. } => {
                Some((v(*x1, *y1), v(*x2, *y2)))
            }
            _ => None,
        }
    }

    /// Centre and radius of a circle or arc, projected or not, None for a degenerate arc.
    pub fn as_round(&self) -> Option<(V, f64)> {
        match self {
            Entity::Circle { x, y, radius, .. } => Some((v(*x, *y), *radius)),
            Entity::Projected { curve: Curve::Circle { x, y, r }, .. } => Some((v(*x, *y), *r)),
            Entity::Arc { x1, y1, x2, y2, mx, my, .. }
            | Entity::Projected { curve: Curve::Arc { x1, y1, x2, y2, mx, my }, .. } => {
                let c = circumcenter(v(*x1, *y1), v(*x2, *y2), v(*mx, *my))?;
                Some((c, (x1 - c.x).hypot(y1 - c.y)))
            }
            _ => None,
        }
    }

    /// The points a dimension can name, by reference index.
    pub fn dim_ref_points(&self) -> Vec<(i64, V)> {
        match self {
            Entity::Line { x1, y1, x2, y2, .. } | Entity::Projected { curve: Curve::Line { x1, y1, x2, y2 }, .. } => {
                vec![(0, v(*x1, *y1)), (1, v(*x2, *y2))]
            }
            Entity::Arc { x1, y1, x2, y2, .. } | Entity::Projected { curve: Curve::Arc { x1, y1, x2, y2, .. }, .. } => {
                let mut out = vec![(0, v(*x1, *y1)), (1, v(*x2, *y2))];
                if let Some((c, _)) = self.as_round() {
                    out.push((2, c));
                }
                out
            }
            Entity::Circle { x, y, .. } | Entity::Point { x, y, .. } => vec![(0, v(*x, *y))],
            Entity::Projected { curve: Curve::Circle { x, y, .. }, .. } => vec![(0, v(*x, *y))],
            Entity::Rectangle { x, y, width, height, angle, .. } => {
                rect_corners(*x, *y, *width, *height, *angle).into_iter().enumerate().map(|(k, q)| (k as i64, q)).collect()
            }
            Entity::Spline { points, .. } => {
                let mut out = Vec::new();
                if let Some(a) = points.first() {
                    out.push((0, *a));
                }
                if let (Some(b), true) = (points.last(), points.len() > 1) {
                    out.push((1, *b));
                }
                out
            }
            Entity::Bspline { poles, .. } => {
                poles.iter().enumerate().map(|(k, q)| (pole_ref(k, poles.len()), *q)).collect()
            }
            Entity::Projected { curve: Curve::Poly(pts), .. } => {
                proj_end_samples(pts).into_iter().enumerate().map(|(k, q)| (k as i64, q)).collect()
            }
            Entity::Other { .. } => Vec::new(),
        }
    }

    pub fn ref_point(&self, p: i64) -> Option<V> {
        self.dim_ref_points().into_iter().find(|(k, _)| *k == p).map(|(_, q)| q)
    }
}

/// A poly's first and last points, one entry when it is closed.
pub fn proj_end_samples(pts: &[V]) -> Vec<V> {
    match (pts.first(), pts.last()) {
        (None, _) => Vec::new(),
        (Some(a), Some(b)) if a.x == b.x && a.y == b.y => vec![*a],
        (Some(a), Some(b)) => vec![*a, *b],
        (Some(a), None) => vec![*a],
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct OffsetPair {
    pub src: String,
    pub cpy: String,
    /// The copy's radius moves by -value.
    #[serde(default)]
    pub flip: bool,
}

/// FundaCAD 1's constraint union. `p` indices are 0 and 1 for start and end, 0 to 3 for rectangle corners and 2 for an
/// arc centre. A rectangle edge is named `<rect>~<k>`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Constraint {
    Horizontal { line: String },
    Vertical { line: String },
    Parallel { l1: String, l2: String },
    Perpendicular { l1: String, l2: String },
    Equal { l1: String, l2: String },
    Distance { line: String, value: f64, #[serde(default)] driven: bool },
    Diameter { circle: String, value: f64, #[serde(default)] driven: bool },
    P2pDistance { e1: String, p1: f64, e2: String, p2: f64, value: f64, #[serde(default)] driven: bool },
    HDistance { e1: String, p1: f64, e2: String, p2: f64, value: f64, #[serde(default)] driven: bool },
    VDistance { e1: String, p1: f64, e2: String, p2: f64, value: f64, #[serde(default)] driven: bool },
    P2lDistance { e: String, p: f64, line: String, value: f64, #[serde(default)] driven: bool },
    RadialGap { inner: String, outer: String, value: f64, #[serde(default)] driven: bool },
    C2cDistance { c1: String, c2: String, value: f64, #[serde(default)] driven: bool },
    C2lDistance { circle: String, line: String, value: f64, #[serde(default)] driven: bool },
    P2cDistance { e: String, p: f64, circle: String, value: f64, #[serde(default)] driven: bool },
    Tangent { line: String, circle: String },
    Coincident { e1: String, p1: f64, e2: String, p2: f64 },
    Concentric { c1: String, c2: String },
    HorizontalPoints { e1: String, p1: f64, e2: String, p2: f64 },
    VerticalPoints { e1: String, p1: f64, e2: String, p2: f64 },
    Midpoint { e: String, p: f64, line: String },
    PointOnCurve { e: String, p: f64, curve: String },
    Symmetric { e1: String, p1: f64, e2: String, p2: f64, line: String },
    /// Degrees. Without `rays` the signed angle from l1 to l2, with them l1 and l2 times rays[0] and rays[1] bound it.
    Angle { l1: String, l2: String, value: f64, #[serde(default)] rays: Option<[i8; 2]>, #[serde(default)] driven: bool },
    Radius { e: String, value: f64, #[serde(default)] driven: bool },
    Fix { e: String, p: f64 },
    Collinear { l1: String, l2: String },
    EqualRadius { a: String, b: String },
    Tangent2 { a: String, b: String },
    Offset { pairs: Vec<OffsetPair>, value: f64, #[serde(default)] driven: bool },
    /// Kept so the constraint indices, and with them the `k<i>` ids, stay those of the document.
    #[serde(other)]
    Unknown,
}

impl Constraint {
    /// A reference dimension is measured only, it never constrains.
    pub fn is_driven(&self) -> bool {
        matches!(
            self,
            Constraint::Distance { driven: true, .. }
                | Constraint::Diameter { driven: true, .. }
                | Constraint::P2pDistance { driven: true, .. }
                | Constraint::HDistance { driven: true, .. }
                | Constraint::VDistance { driven: true, .. }
                | Constraint::P2lDistance { driven: true, .. }
                | Constraint::RadialGap { driven: true, .. }
                | Constraint::C2cDistance { driven: true, .. }
                | Constraint::C2lDistance { driven: true, .. }
                | Constraint::P2cDistance { driven: true, .. }
                | Constraint::Angle { driven: true, .. }
                | Constraint::Radius { driven: true, .. }
                | Constraint::Offset { driven: true, .. }
        )
    }

    /// Goes through the saved JSON, so fields and types the core schema keeps as extra or unknown
    /// (`rays`, `flip`, `pointOnCurve`, `horizontalPoints`) arrive too.
    pub fn from_core(c: &SketchConstraint) -> Constraint {
        serde_json::to_value(c).ok().and_then(|j| serde_json::from_value(j).ok()).unwrap_or(Constraint::Unknown)
    }
}

pub fn constraints_from_core(cs: &[SketchConstraint]) -> Vec<Constraint> {
    cs.iter().map(Constraint::from_core).collect()
}

/// Resolves every number, the counterpart of FundaCAD 1's resolveRealEntities. An entity without an id gets `_e<n>`.
pub fn resolve_entities(
    entities: &[SketchEntity],
    params: &dyn Fn(&str) -> Option<f64>,
) -> Result<Vec<Entity>, UnresolvedNum> {
    let r = |n: &Num| n.resolve(params);
    let opt = |n: &Option<Num>| n.as_ref().map_or(Ok(0.0), |n| n.resolve(params));
    let pts = |ps: &[fundacad_core::schema::sketch::SplinePoint]| -> Result<Vec<V>, UnresolvedNum> {
        ps.iter().map(|p| Ok(v(p.x.resolve(params)?, p.y.resolve(params)?))).collect()
    };
    entities
        .iter()
        .enumerate()
        .map(|(n, e)| {
            let id = e.id().map_or_else(|| format!("_e{n}"), str::to_string);
            Ok(match e {
                SketchEntity::Line(l) => Entity::Line { id, x1: r(&l.x1)?, y1: r(&l.y1)?, x2: r(&l.x2)?, y2: r(&l.y2)? },
                SketchEntity::Circle(c) => Entity::Circle { id, x: opt(&c.x)?, y: opt(&c.y)?, radius: r(&c.radius)? },
                SketchEntity::Rectangle(c) => Entity::Rectangle {
                    id,
                    x: opt(&c.x)?,
                    y: opt(&c.y)?,
                    width: r(&c.width)?,
                    height: r(&c.height)?,
                    angle: opt(&c.angle)?,
                },
                SketchEntity::Arc(a) => Entity::Arc {
                    id,
                    x1: r(&a.x1)?,
                    y1: r(&a.y1)?,
                    x2: r(&a.x2)?,
                    y2: r(&a.y2)?,
                    mx: r(&a.mx)?,
                    my: r(&a.my)?,
                },
                SketchEntity::Spline(s) => Entity::Spline { id, points: pts(&s.points)? },
                SketchEntity::Bspline(b) => {
                    Entity::Bspline { id, poles: pts(&b.poles)?, closed: b.closed.unwrap_or(false) }
                }
                SketchEntity::Point(p) => Entity::Point { id, x: r(&p.x)?, y: r(&p.y)? },
                SketchEntity::Projected(p) => {
                    let curve = match &p.curve {
                        ProjectedCurve::Line(l) => {
                            Curve::Line { x1: l.x1.get(), y1: l.y1.get(), x2: l.x2.get(), y2: l.y2.get() }
                        }
                        ProjectedCurve::Circle(c) => Curve::Circle { x: c.x.get(), y: c.y.get(), r: c.r.get() },
                        ProjectedCurve::Arc(a) => Curve::Arc {
                            x1: a.x1.get(),
                            y1: a.y1.get(),
                            x2: a.x2.get(),
                            y2: a.y2.get(),
                            mx: a.mx.get(),
                            my: a.my.get(),
                        },
                        ProjectedCurve::Poly(p) => Curve::Poly(p.pts.iter().map(|[x, y]| v(x.get(), y.get())).collect()),
                        _ => return Ok(Entity::Other { id }),
                    };
                    Entity::Projected { id, curve }
                }
                _ => Entity::Other { id },
            })
        })
        .collect()
}

fn num(x: f64) -> Num {
    Num::from(x)
}

/// Writes a solved entity's numbers into its document entity, the counterpart of FundaCAD 1's toSketchEntity.
/// Projected and unsolved entities come back unchanged.
pub fn write_back(doc: &SketchEntity, solved: &Entity) -> SketchEntity {
    let mut out = doc.clone();
    match (&mut out, solved) {
        (SketchEntity::Line(l), Entity::Line { x1, y1, x2, y2, .. }) => {
            (l.x1, l.y1, l.x2, l.y2) = (num(*x1), num(*y1), num(*x2), num(*y2));
        }
        (SketchEntity::Circle(c), Entity::Circle { x, y, radius, .. }) => {
            (c.x, c.y, c.radius) = (Some(num(*x)), Some(num(*y)), num(*radius));
        }
        (SketchEntity::Rectangle(c), Entity::Rectangle { x, y, width, height, angle, .. }) => {
            (c.x, c.y, c.width, c.height) = (Some(num(*x)), Some(num(*y)), num(*width), num(*height));
            if c.angle.is_some() || *angle != 0.0 {
                c.angle = Some(num(*angle));
            }
        }
        (SketchEntity::Arc(a), Entity::Arc { x1, y1, x2, y2, mx, my, .. }) => {
            (a.x1, a.y1, a.x2, a.y2, a.mx, a.my) = (num(*x1), num(*y1), num(*x2), num(*y2), num(*mx), num(*my));
        }
        (SketchEntity::Spline(s), Entity::Spline { points, .. }) => {
            for (p, q) in s.points.iter_mut().zip(points) {
                (p.x, p.y) = (num(q.x), num(q.y));
            }
        }
        (SketchEntity::Bspline(b), Entity::Bspline { poles, .. }) => {
            for (p, q) in b.poles.iter_mut().zip(poles) {
                (p.x, p.y) = (num(q.x), num(q.y));
            }
        }
        (SketchEntity::Point(p), Entity::Point { x, y, .. }) => {
            (p.x, p.y) = (num(*x), num(*y));
        }
        _ => {}
    }
    out
}
