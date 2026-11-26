//! The feature tools, featureStarters.ts: each makes its feature from what is selected and names the target field a
//! click picks into when the selection did not fill it. The viewport runs the session, the shell shows the card.

pub mod build;
pub mod run;
mod starters;
#[cfg(test)]
mod tests;

use serde_json::{json, Map, Value};

#[cfg(test)]
pub use starters::tool;
pub use starters::TOOLS;
pub use starters::{fit, sources_extent, Fitted};
pub use starters::{press, replace};
pub use starters::{offer, place, places};

use crate::selection::{Pick, PickKind, Selection};

pub type Doc = Map<String, Value>;

/// A tool's feature before it is added, and the targets it cannot build without, in the order they are picked.
#[derive(Clone, Debug, PartialEq)]
pub struct Start {
    pub feature: Value,
    pub need: Vec<Target>,
}

impl Start {
    /// The first needed field the selection left empty.
    pub fn arm(&self) -> Option<Target> {
        self.need.iter().copied().find(|t| empty(&self.feature, t.field))
    }
}

/// Tools kept off the command list until the view can show what they make.
pub const HELD: &[&str] = &[];

/// Whether a feature's field holds nothing.
pub fn empty(feature: &Value, field: &str) -> bool {
    match feature.get(field) {
        None | Some(Value::Null) => true,
        Some(Value::Array(a)) => a.is_empty(),
        Some(Value::String(s)) => s.is_empty(),
        Some(_) => false,
    }
}

/// What a field holds, a single value as a list of one.
pub fn entries(doc: &Doc, id: &str, field: &str) -> Vec<Value> {
    match feature(doc, id).and_then(|f| f.get(field)) {
        Some(Value::Array(a)) => a.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(one) => vec![one.clone()],
    }
}

pub fn feature<'a>(doc: &'a Doc, id: &str) -> Option<&'a Value> {
    features(doc).iter().find(|f| f.get("id").and_then(Value::as_str) == Some(id))
}

pub fn index_of(doc: &Doc, id: &str) -> Option<usize> {
    features(doc).iter().position(|f| f.get("id").and_then(Value::as_str) == Some(id))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub field: &'static str,
    pub kind: PickKind,
    pub many: bool,
}

pub struct Tool {
    /// The command id, as the key table and the ribbon name it.
    pub id: &'static str,
    pub label: &'static str,
    pub start: fn(&Doc, &Selection) -> Result<Start, String>,
}

/// `f1`, `f2`, as FundaCAD 1's store.nextId: the count plus one, then up past any taken.
pub fn next_id(doc: &Doc) -> String {
    let ids: Vec<&str> = features(doc).iter().filter_map(|f| f.get("id").and_then(Value::as_str)).collect();
    let mut n = ids.len() + 1;
    while ids.contains(&format!("f{n}").as_str()) {
        n += 1;
    }
    format!("f{n}")
}

fn features(doc: &Doc) -> &[Value] {
    doc.get("features").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Adds `feature` at the rollback marker, which moves past it, as FundaCAD 1's addFeature.
pub fn insert(doc: &mut Doc, feature: Value) -> Result<(), String> {
    let list = doc.entry("features").or_insert_with(|| json!([]));
    let list = list.as_array_mut().ok_or("the document's features are not a list")?;
    let len = list.len();
    let rollback = doc.get("rollback").and_then(Value::as_u64).map(|r| r as usize);
    let at = rollback.map_or(len, |r| r.min(len));
    doc.get_mut("features").and_then(Value::as_array_mut).expect("made above").insert(at, feature);
    if let Some(r) = rollback.filter(|r| at <= *r) {
        doc.insert("rollback".into(), json!(r + 1));
    }
    Ok(())
}

fn feature_mut<'a>(doc: &'a mut Doc, id: &str) -> Result<&'a mut Map<String, Value>, String> {
    doc.get_mut("features")
        .and_then(Value::as_array_mut)
        .and_then(|fs| fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(id)))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("the document has no feature {id}"))
}

/// What a pick stores in a target field: a selector for a face or an edge, the id of a body.
pub fn entry(pick: &Pick) -> Option<Value> {
    match pick {
        Pick::Body { body } => Some(json!(body)),
        Pick::Area { sketch, point } => Some(json!({"sketch": sketch, "point": point})),
        Pick::Plane { id } => Some(json!({"plane": id})),
        _ => pick.selector(),
    }
}

/// Adds `value` to a list field or sets a single one, or takes it out again when `drop`.
pub fn set_target(doc: &mut Doc, id: &str, field: &str, value: Value, many: bool, drop: bool) -> Result<(), String> {
    let f = feature_mut(doc, id)?;
    if !many {
        match drop {
            true => f.remove(field),
            false => f.insert(field.into(), value),
        };
        return Ok(());
    }
    let mut list = match f.get(field) {
        Some(Value::Array(a)) => a.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(one) => vec![one.clone()],
    };
    match drop {
        true => list.retain(|v| v != &value),
        false if !list.contains(&value) => list.push(value),
        false => {}
    }
    f.insert(field.into(), Value::Array(list));
    Ok(())
}

/// The bodies the selection reaches, in the order first picked.
pub fn bodies(sel: &Selection) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for b in sel.picks.iter().filter_map(Pick::body) {
        if !out.iter().any(|o| o == b) {
            out.push(b.to_string());
        }
    }
    out
}

/// The feature `start` makes, given its id, and the field to pick into.
pub fn started(tool: &Tool, doc: &Doc, sel: &Selection) -> Result<(String, Start), String> {
    let id = next_id(doc);
    let mut start = (tool.start)(doc, sel)?;
    let mut f = Map::new();
    f.insert("id".into(), json!(id));
    f.extend(start.feature.as_object().cloned().unwrap_or_default());
    start.feature = Value::Object(f);
    Ok((id, start))
}
