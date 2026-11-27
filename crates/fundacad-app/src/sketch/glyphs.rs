//! One badge on the canvas per geometric constraint, FundaCAD 1's sketch/glyphs.ts. Dimensional constraints show as
//! their own number badges instead.

use std::collections::HashSet;

use fundacad_sketch::{Curve, Entity};
use glam::DVec2;
use serde_json::Value;

use super::dims::span_of;
use super::relations::{face, state_of, State};
use crate::i18n::t;

#[derive(Clone, Debug, PartialEq)]
pub struct Glyph {
    /// The constraint's index, what a click deletes.
    pub index: usize,
    pub icon: &'static str,
    /// In sketch mm.
    pub pos: DVec2,
    pub state: Option<State>,
}

fn mid(a: DVec2, b: DVec2) -> DVec2 {
    (a + b) * 0.5
}

fn center(e: &Entity) -> Option<DVec2> {
    let d = DVec2::new;
    Some(match e {
        Entity::Line { x1, y1, x2, y2, .. } => mid(d(*x1, *y1), d(*x2, *y2)),
        Entity::Arc { mx, my, .. } => d(*mx, *my),
        Entity::Circle { x, y, .. } | Entity::Rectangle { x, y, .. } | Entity::Point { x, y, .. } => d(*x, *y),
        Entity::Spline { points, .. } => points.get(points.len() / 2).map(|p| d(p.x, p.y))?,
        Entity::Bspline { poles, .. } => poles.get(poles.len() / 2).map(|p| d(p.x, p.y))?,
        Entity::Projected { curve, .. } => match curve {
            Curve::Line { x1, y1, x2, y2 } => mid(d(*x1, *y1), d(*x2, *y2)),
            Curve::Circle { x, y, .. } => d(*x, *y),
            Curve::Arc { mx, my, .. } => d(*mx, *my),
            Curve::Poly(pts) => pts.get(pts.len() / 2).map(|p| d(p.x, p.y))?,
        },
        Entity::Other { .. } => return None,
    })
}

/// Where each geometric constraint's badge sits, as glyphs.ts's constraintGlyphs.
pub fn constraint_glyphs(
    solved: &[Entity],
    constraints: &[Value],
    conflicts: &HashSet<usize>,
    over: &HashSet<usize>,
) -> Vec<Glyph> {
    let by_id = |id: &str| solved.iter().find(|e| e.id() == id);
    let field = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let at = |c: &Value, k: &str| -> Option<DVec2> {
        let id = field(c, k);
        match by_id(&id) {
            Some(e) => center(e),
            None => span_of(solved, &id).map(|(a, b)| mid(a, b)),
        }
    };
    let point = |c: &Value, e: &str, p: &str| -> Option<DVec2> {
        let q = by_id(&field(c, e))?.ref_point(c.get(p).and_then(Value::as_i64).unwrap_or(0))?;
        Some(DVec2::new(q.x, q.y))
    };
    let both = |a: Option<DVec2>, b: Option<DVec2>| Some(mid(a?, b?));
    constraints
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let kind = c.get("type").and_then(Value::as_str).unwrap_or_default();
            let pos = match kind {
                "horizontal" | "vertical" => at(c, "line"),
                "parallel" | "perpendicular" | "equal" => at(c, "l1"),
                "collinear" => both(at(c, "l1"), at(c, "l2")),
                "equalRadius" => at(c, "a"),
                "tangent" => both(at(c, "line"), at(c, "circle")),
                "tangent2" => both(at(c, "a"), at(c, "b")),
                "coincident" => point(c, "e1", "p1"),
                "concentric" => at(c, "c1"),
                "midpoint" | "symmetric" => at(c, "line"),
                "pointOnCurve" => point(c, "e", "p"),
                "horizontalPoints" | "verticalPoints" => both(point(c, "e1", "p1"), point(c, "e2", "p2")),
                "fix" => point(c, "e", "p"),
                _ => None,
            }?;
            Some(Glyph { index: i, icon: face(kind).0, pos, state: state_of(i, conflicts, over) })
        })
        .collect()
}

/// The badge's hover line, annotationFormat.ts's glyphTitle.
pub fn title(state: Option<State>) -> String {
    t(match state {
        Some(State::Conflict) => "sketch.glyph.conflictDelete",
        Some(State::Over) => "sketch.glyph.overDelete",
        None => "sketch.glyph.delete",
    })
}

/// The glyph under a point, the last drawn one when they overlap, given each glyph's screen centre and the badge's
/// half width and half height.
pub fn hit(screen: &[(usize, f32, f32)], x: f32, y: f32, half: (f32, f32)) -> Option<usize> {
    screen.iter().rev().find(|(_, gx, gy)| (gx - x).abs() <= half.0 && (gy - y).abs() <= half.1).map(|(i, _, _)| *i)
}

/// The shapes a constraint acts on, a rectangle edge as its rectangle, lit while its glyph is hovered.
pub fn shapes_of(c: &Value) -> Vec<String> {
    let kind = c.get("type").and_then(Value::as_str).unwrap_or_default();
    face(kind)
        .2
        .iter()
        .filter_map(|f| c.get(*f).and_then(Value::as_str))
        .map(|o| o.split('~').next().unwrap_or(o).to_string())
        .collect()
}
