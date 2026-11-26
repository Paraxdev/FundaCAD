//! The document's sketch JSON through the native solver and back.

use std::collections::{HashMap, HashSet};

use fundacad_core::schema::sketch::SketchEntity;
use fundacad_sketch::compile::constraint_index_of;
use fundacad_sketch::geom::v;
use fundacad_sketch::{compile_and_solve, resolve_entities, solve_keeping_axes, shape_freedom, write_back, Constraint, DragReq, Entity, Freedom, SolveOpts};
use glam::DVec2;
use serde_json::{Map, Value};

#[derive(Clone, Debug, Default)]
pub struct Solved {
    pub entities: Vec<Entity>,
    pub dof: i32,
    pub ok: bool,
    /// Constraint indices that cannot all hold.
    pub conflicts: HashSet<usize>,
    pub over: HashSet<usize>,
    pub freedom: Option<HashMap<String, Freedom>>,
}

impl Solved {
    /// Fully defined: the solver found no freedom left on the shape.
    pub fn defined(&self, id: &str) -> bool {
        self.freedom.as_ref().and_then(|f| f.get(id)).is_some_and(|f| !f.x && !f.y && !f.size)
    }
}

pub fn params(doc: &Map<String, Value>) -> HashMap<String, f64> {
    doc.get("parameters")
        .and_then(Value::as_object)
        .map(|p| p.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()?))).collect())
        .unwrap_or_default()
}

fn core(entities: &[Value]) -> Vec<SketchEntity> {
    entities.iter().filter_map(|e| serde_json::from_value(e.clone()).ok()).collect()
}

pub fn constraints(cs: &[Value]) -> Vec<Constraint> {
    cs.iter().map(|c| serde_json::from_value(c.clone()).unwrap_or(Constraint::Unknown)).collect()
}

pub fn resolve(entities: &[Value], params: &HashMap<String, f64>) -> Vec<Entity> {
    resolve_entities(&core(entities), &|n| params.get(n).copied())
}

fn keys(ids: &[String]) -> HashSet<usize> {
    ids.iter().filter_map(|k| constraint_index_of(k)).collect()
}

#[derive(Clone, Copy, Debug)]
pub enum How {
    Plain,
    /// The point at the first position dragged to the second.
    Drag(DVec2, DVec2),
    /// After a typed number: drawn axes hold and the anchor stays put.
    Typed(Option<DVec2>),
}

/// Solves, with an optional drag of the point at `from` to `to`, and writes the solved numbers into a copy of the
/// entities. A field holding a parameter name keeps it, the engine resolves it.
pub fn solve(
    entities: &[Value],
    cs: &[Value],
    params: &HashMap<String, f64>,
    how: How,
    freedom: bool,
) -> (Vec<Value>, Solved) {
    let resolved = resolve(entities, params);
    let constraints = constraints(cs);
    let pass = match how {
        How::Plain => compile_and_solve(&resolved, &constraints, None, &SolveOpts::default()),
        How::Drag(a, b) => {
            let drag = DragReq { from: v(a.x, a.y), to: v(b.x, b.y) };
            compile_and_solve(&resolved, &constraints, Some(drag), &SolveOpts::default())
        }
        How::Typed(anchor) => solve_keeping_axes(&resolved, &constraints, anchor.map(|a| v(a.x, a.y))),
    };
    let pass = match pass {
        Ok(p) => p,
        Err(e) => {
            log::warn!("sketch solve: {e:?}");
            return (entities.to_vec(), Solved { entities: resolved, ..Default::default() });
        }
    };
    let out = entities
        .iter()
        .map(|e| {
            let Ok(doc) = serde_json::from_value::<SketchEntity>(e.clone()) else { return e.clone() };
            let id = doc.id().unwrap_or_default().to_string();
            let Some(s) = pass.entities.iter().find(|s| s.id() == id) else { return e.clone() };
            let mut written = serde_json::to_value(write_back(&doc, s)).unwrap_or_else(|_| e.clone());
            if let (Some(w), Some(o)) = (written.as_object_mut(), e.as_object()) {
                for (k, val) in o.iter().filter(|(k, val)| val.is_string() && *k != "id" && *k != "type") {
                    w.insert(k.clone(), val.clone());
                }
            }
            written
        })
        .collect();
    let freedom = if freedom && pass.ok && pass.conflicts.is_empty() {
        shape_freedom(&pass.entities, &constraints)
    } else {
        None
    };
    let solved = Solved {
        dof: pass.dof,
        ok: pass.ok,
        conflicts: keys(&pass.conflicts),
        over: keys(&pass.over_defined),
        entities: pass.entities,
        freedom,
    };
    (out, solved)
}

/// The sketch feature `id` solved again and its entities rewritten, after one of its numbers changed.
/// `key` names the dimension that changed, its first point stays put.
pub fn resolve_feature(doc: &mut Map<String, Value>, id: &str, key: Option<&str>) {
    let params = params(doc);
    let Some(f) = doc
        .get_mut("features")
        .and_then(Value::as_array_mut)
        .and_then(|fs| fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(id)))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let list = |k: &str| f.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let (entities, cs) = (list("entities"), list("constraints"));
    let anchor = key.and_then(|k| super::dims::feature_dims(f).into_iter().find(|d| d.key == k)).map(|d| d.from);
    let (out, solved) = solve(&entities, &cs, &params, How::Typed(anchor), false);
    if solved.ok {
        f.insert("entities".into(), Value::Array(out));
    }
}

/// Every sketch with constraints solved again, after a parameter changed.
pub fn resolve_sketches(doc: &mut Map<String, Value>) {
    let ids: Vec<String> = doc
        .get("features")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|f| f["type"] == "sketch" && f.get("constraints").is_some())
        .filter_map(|f| f["id"].as_str().map(String::from))
        .collect();
    for id in ids {
        resolve_feature(doc, &id, None);
    }
}
