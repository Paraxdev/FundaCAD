//! The sketch's relations as the palette lists them, FundaCAD 1's sketch/relations.ts: each recorded constraint in the
//! order it was added, then the joins the geometry implies. Endpoints at one position compile to one solver point, a
//! real join with no record, so it is listed but cannot be deleted.

use std::collections::HashSet;

use fundacad_sketch::geom::coinc_key;
use fundacad_sketch::Entity;
use serde_json::Value;

use super::dims::shape_name;
use crate::i18n::{t, tr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Conflict,
    Over,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// None for an implied join, which has no record to delete.
    pub index: Option<usize>,
    pub icon: &'static str,
    pub name: String,
    /// "Line 1 and Line 3", empty when it acts on nothing that still exists.
    pub detail: String,
    /// Only on dimensional constraints.
    pub value: Option<String>,
    /// The shapes lit while the row is hovered.
    pub entities: Vec<String>,
    pub state: Option<State>,
}

impl Row {
    pub fn implied(&self) -> bool {
        self.index.is_none()
    }
}

/// The glyph, the name's key and the fields naming the operands, as glyphs.ts's constraintFace.
fn face(kind: &str) -> (&'static str, &'static str, &'static [&'static str]) {
    match kind {
        "horizontal" => ("horizontal", "sketch.constraint.horizontal", &["line"]),
        "vertical" => ("vertical", "sketch.constraint.vertical", &["line"]),
        "parallel" => ("parallel", "sketch.constraint.parallel", &["l1", "l2"]),
        "perpendicular" => ("perpendicular", "sketch.constraint.perpendicular", &["l1", "l2"]),
        "collinear" => ("collinear", "sketch.constraint.collinear", &["l1", "l2"]),
        "equal" => ("equal", "sketch.constraint.equal", &["l1", "l2"]),
        "equalRadius" => ("equal", "sketch.constraint.equalRadius", &["a", "b"]),
        "tangent" => ("tangent", "sketch.constraint.tangent", &["line", "circle"]),
        "tangent2" => ("tangent", "sketch.constraint.tangent", &["a", "b"]),
        "coincident" => ("coincident", "sketch.constraint.coincident", &["e1", "e2"]),
        "concentric" => ("concentric", "sketch.constraint.concentric", &["c1", "c2"]),
        "midpoint" => ("midpoint", "sketch.constraint.midpoint", &["e", "line"]),
        "pointOnCurve" => ("coincident", "sketch.constraint.onCurve", &["e", "curve"]),
        "symmetric" => ("symmetric", "sketch.constraint.symmetric", &["e1", "e2", "line"]),
        "horizontalPoints" => ("horizontal", "sketch.constraint.alignedHorizontally", &["e1", "e2"]),
        "verticalPoints" => ("vertical", "sketch.constraint.alignedVertically", &["e1", "e2"]),
        "fix" => ("fix", "sketch.constraint.fixed", &["e"]),
        "distance" => ("distance", "sketch.constraint.length", &["line"]),
        "diameter" => ("diameter", "sketch.constraint.diameter", &["circle"]),
        "radius" => ("radius", "sketch.constraint.radius", &["e"]),
        "angle" => ("angle", "sketch.constraint.angle", &["l1", "l2"]),
        "p2pDistance" => ("distance", "sketch.constraint.distance", &["e1", "e2"]),
        "hDistance" => ("distance", "sketch.constraint.hDistance", &["e1", "e2"]),
        "vDistance" => ("distance", "sketch.constraint.vDistance", &["e1", "e2"]),
        "p2lDistance" => ("distance", "sketch.constraint.distanceToLine", &["e", "line"]),
        "radialGap" => ("distance", "sketch.constraint.radialGap", &["inner", "outer"]),
        "c2cDistance" => ("distance", "sketch.constraint.rimToRim", &["c1", "c2"]),
        "c2lDistance" => ("distance", "sketch.constraint.rimToLine", &["circle", "line"]),
        "p2cDistance" => ("distance", "sketch.constraint.pointToRim", &["e", "circle"]),
        _ => ("warning", "", &[]),
    }
}

/// "Line 2", or "Rectangle 1 edge 3" for a rectangle edge operand, None for an id nothing answers to.
pub fn label(entities: &[Value], id: &str) -> Option<String> {
    if let Some((base, k)) = id.split_once('~') {
        let name = label(entities, base)?;
        return Some(match k.parse::<usize>() {
            Ok(k) => tr!("sketch.name.edge", name = name, n = k + 1),
            Err(_) => name,
        });
    }
    entities.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(id)).then(|| shape_name(entities, id))
}

fn and(labels: Vec<String>) -> String {
    labels.join(&format!(" {} ", t("sketch.relations.and")))
}

fn number(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// `fmtDim`: degrees for an angle, millimetres else, a reference dimension in brackets.
fn value(v: f64, angle: bool, driven: bool) -> String {
    let s = if angle { format!("{}°", number(v)) } else { format!("{} mm", number(v)) };
    if driven {
        format!("({s})")
    } else {
        s
    }
}

pub fn constraint_rows(
    entities: &[Value],
    constraints: &[Value],
    conflicts: &HashSet<usize>,
    over: &HashSet<usize>,
) -> Vec<Row> {
    constraints
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let kind = c.get("type").and_then(Value::as_str).unwrap_or_default();
            let (icon, key, fields) = face(kind);
            let operands: Vec<&str> = fields.iter().filter_map(|f| c.get(*f).and_then(Value::as_str)).collect();
            let driven = c.get("driven").and_then(Value::as_bool) == Some(true);
            let state = if conflicts.contains(&i) {
                Some(State::Conflict)
            } else if over.contains(&i) {
                Some(State::Over)
            } else {
                None
            };
            Row {
                index: Some(i),
                icon,
                name: if key.is_empty() { kind.to_string() } else { t(key) },
                detail: and(operands.iter().filter_map(|o| label(entities, o)).collect()),
                value: c.get("value").and_then(Value::as_f64).map(|v| value(v, kind == "angle", driven)),
                entities: operands.iter().map(|o| o.split('~').next().unwrap_or(o).to_string()).collect(),
                state,
            }
        })
        .collect()
}

/// Whether recorded coincidents between these ids already tie all of them together.
fn joined_by_records(ids: &[String], recorded: &[Value]) -> bool {
    let mut reached: HashSet<&str> = ids.first().map(|s| s.as_str()).into_iter().collect();
    let mut grew = true;
    while grew {
        grew = false;
        for c in recorded {
            if c.get("type").and_then(Value::as_str) != Some("coincident") {
                continue;
            }
            let (Some(a), Some(b)) = (c.get("e1").and_then(Value::as_str), c.get("e2").and_then(Value::as_str)) else {
                continue;
            };
            if !ids.iter().any(|i| i == a) || !ids.iter().any(|i| i == b) {
                continue;
            }
            if reached.contains(a) != reached.contains(b) {
                reached.insert(a);
                reached.insert(b);
                grew = true;
            }
        }
    }
    ids.iter().all(|i| reached.contains(i.as_str()))
}

/// Endpoints that compile to one solver point, keyed as the solver merges them. A lone endpoint is not a join.
pub fn implied_joins(
    entities: &[Value],
    solved: &[Entity],
    construction: &dyn Fn(&str) -> bool,
    recorded: &[Value],
) -> Vec<Row> {
    let mut at: Vec<((i64, i64), Vec<String>)> = Vec::new();
    let mut add = |x: f64, y: f64, id: &str| {
        let k = coinc_key(x, y);
        match at.iter_mut().find(|(key, _)| *key == k) {
            Some((_, list)) if !list.iter().any(|i| i == id) => list.push(id.to_string()),
            Some(_) => {}
            None => at.push((k, vec![id.to_string()])),
        }
    };
    for e in solved {
        if construction(e.id()) {
            continue;
        }
        match e {
            Entity::Line { id, x1, y1, x2, y2 } | Entity::Arc { id, x1, y1, x2, y2, .. } => {
                add(*x1, *y1, id);
                add(*x2, *y2, id);
            }
            Entity::Spline { id, points } => {
                for p in [points.first(), points.last()].into_iter().flatten() {
                    add(p.x, p.y, id);
                }
            }
            Entity::Bspline { id, poles, closed: false } => {
                for p in [poles.first(), poles.last()].into_iter().flatten() {
                    add(p.x, p.y, id);
                }
            }
            Entity::Point { id, x, y } => add(*x, *y, id),
            _ => {}
        }
    }
    at.into_iter()
        .filter(|(_, ids)| ids.len() >= 2 && !joined_by_records(ids, recorded))
        .map(|(_, ids)| Row {
            index: None,
            icon: "coincident",
            name: t("sketch.constraint.coincident"),
            detail: and(ids.iter().filter_map(|i| label(entities, i)).collect()),
            value: None,
            entities: ids,
            state: None,
        })
        .collect()
}

/// `dof < 0` means no solve has run, which a sketch without constraints stays in, and is not fully defined.
pub fn summary(dof: i32, conflict: bool) -> String {
    if conflict {
        t("sketch.relations.conflicting")
    } else if dof < 0 {
        t("sketch.relations.notConstrained")
    } else if dof == 0 {
        t("sketch.relations.fullyDefined")
    } else {
        tr!("sketch.relations.dof", n = dof)
    }
}
