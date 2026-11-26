//! Snapping and inference, FundaCAD 1's snap.ts and inferRelations.ts: points of existing shapes, alignment with them,
//! then the grid, and the relations a drawn shape keeps with what it snapped to.

use fundacad_sketch::Entity;
use glam::DVec2;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Free,
    Grid,
    Endpoint,
    Midpoint,
    Center,
    Align,
}

/// What a snapped point lies on: point `at` of `entity`, or the middle of line `entity`.
#[derive(Clone, Debug, PartialEq)]
pub enum Ref {
    Point { entity: String, at: i64 },
    Mid { line: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cand {
    pub p: DVec2,
    pub kind: Kind,
    pub priority: u8,
    pub r: Option<Ref>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snap {
    pub p: DVec2,
    pub kind: Kind,
    pub r: Option<Ref>,
    /// The points the cursor lines up with, for the dotted guides.
    pub guides: Vec<DVec2>,
}

impl Snap {
    pub fn free(p: DVec2) -> Self {
        Self { p, kind: Kind::Free, r: None, guides: Vec::new() }
    }
}

pub const PIXEL_TOL: f64 = 10.0;

pub fn candidates(entities: &[Entity]) -> Vec<Cand> {
    let mut out = vec![Cand { p: DVec2::ZERO, kind: Kind::Center, priority: 95, r: None }];
    let mut add = |x: f64, y: f64, kind, priority, r| out.push(Cand { p: DVec2::new(x, y), kind, priority, r });
    let pt = |e: &str, at| Some(Ref::Point { entity: e.to_string(), at });
    for e in entities {
        match e {
            Entity::Line { id, x1, y1, x2, y2 } => {
                add(*x1, *y1, Kind::Endpoint, 100, pt(id, 0));
                add(*x2, *y2, Kind::Endpoint, 100, pt(id, 1));
                add((x1 + x2) / 2.0, (y1 + y2) / 2.0, Kind::Midpoint, 80, Some(Ref::Mid { line: id.clone() }));
            }
            Entity::Rectangle { id, x, y, width, height, angle } => {
                let c = fundacad_sketch::geom::rect_corners(*x, *y, *width, *height, *angle);
                for (k, q) in c.iter().enumerate() {
                    add(q.x, q.y, Kind::Endpoint, 100, pt(id, k as i64));
                    let b = c[(k + 1) % 4];
                    let mid = Some(Ref::Mid { line: format!("{id}~{k}") });
                    add((q.x + b.x) / 2.0, (q.y + b.y) / 2.0, Kind::Midpoint, 80, mid);
                }
                add(*x, *y, Kind::Center, 90, None);
            }
            Entity::Circle { id, x, y, .. } => add(*x, *y, Kind::Center, 90, pt(id, 0)),
            Entity::Arc { id, x1, y1, x2, y2, .. } => {
                add(*x1, *y1, Kind::Endpoint, 100, pt(id, 0));
                add(*x2, *y2, Kind::Endpoint, 100, pt(id, 1));
                if let Some((c, _)) = e.as_round() {
                    add(c.x, c.y, Kind::Center, 90, pt(id, 2));
                }
            }
            Entity::Point { id, x, y } => add(*x, *y, Kind::Endpoint, 110, pt(id, 0)),
            _ => {}
        }
    }
    out
}

/// A grid step that is a round number near 20 pixels.
pub fn grid_step(px_per_mm: f64) -> f64 {
    let want = 20.0 / px_per_mm.max(1e-9);
    let base = 10f64.powf(want.log10().floor());
    [1.0, 2.0, 5.0, 10.0].into_iter().map(|m| m * base).find(|s| *s >= want).unwrap_or(base * 10.0)
}

/// The best snap of `raw` within `PIXEL_TOL` pixels: a point by priority then distance, else alignment with points,
/// else the grid. `skip` leaves out the point a drag holds.
pub fn snap(raw: DVec2, cands: &[Cand], px_per_mm: f64, grid: bool) -> Snap {
    let tol = PIXEL_TOL / px_per_mm.max(1e-9);
    let mut best: Option<(&Cand, f64)> = None;
    let (mut ax, mut ay): (Option<(DVec2, f64)>, Option<(DVec2, f64)>) = (None, None);
    for c in cands {
        let d = c.p.distance(raw);
        if d <= tol && best.is_none_or(|(b, bd)| c.priority > b.priority || (c.priority == b.priority && d < bd)) {
            best = Some((c, d));
        }
        let dx = (c.p.x - raw.x).abs();
        if dx <= tol && ax.is_none_or(|(_, b)| dx < b) {
            ax = Some((c.p, dx));
        }
        let dy = (c.p.y - raw.y).abs();
        if dy <= tol && ay.is_none_or(|(_, b)| dy < b) {
            ay = Some((c.p, dy));
        }
    }
    if let Some((c, _)) = best {
        return Snap { p: c.p, kind: c.kind, r: c.r.clone(), guides: Vec::new() };
    }
    if ax.is_some() || ay.is_some() {
        let step = grid_step(px_per_mm);
        let g = |v: f64| if grid { (v / step).round() * step } else { v };
        let p = DVec2::new(ax.map_or(g(raw.x), |(p, _)| p.x), ay.map_or(g(raw.y), |(p, _)| p.y));
        return Snap { p, kind: Kind::Align, r: None, guides: [ax, ay].into_iter().flatten().map(|(p, _)| p).collect() };
    }
    if grid {
        let step = grid_step(px_per_mm);
        return Snap { p: (raw / step).round() * step, kind: Kind::Grid, r: None, guides: Vec::new() };
    }
    Snap::free(raw)
}

/// The relation a new shape's point `p` keeps with what it snapped to, FundaCAD 1's pointRelation.
pub fn point_relation(id: &str, p: i64, r: &Option<Ref>) -> Option<Value> {
    match r.as_ref()? {
        Ref::Point { entity, at } => Some(json!({"type": "coincident", "e1": id, "p1": p, "e2": entity, "p2": at})),
        Ref::Mid { line } => Some(json!({"type": "midpoint", "e": id, "p": p, "line": line})),
    }
}

/// Degrees within which a drawn line is taken as horizontal or vertical.
pub const AXIS_TOL_DEG: f64 = 3.0;

/// "horizontal" or "vertical" when the line from `a` to `b` is within `AXIS_TOL_DEG` of one, and the end squared to it.
pub fn axis_of(a: DVec2, b: DVec2) -> Option<(&'static str, DVec2)> {
    let d = b - a;
    if d.length() < 1e-9 {
        return None;
    }
    let deg = d.y.atan2(d.x).to_degrees().abs();
    let off_h = deg.min(180.0 - deg);
    let off_v = (deg - 90.0).abs();
    if off_h <= AXIS_TOL_DEG {
        Some(("horizontal", DVec2::new(b.x, a.y)))
    } else if off_v <= AXIS_TOL_DEG {
        Some(("vertical", DVec2::new(a.x, b.y)))
    } else {
        None
    }
}
