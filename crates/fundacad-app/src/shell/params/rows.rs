//! The rows the Parameters panel lists, read from the document as ParamsDialog.vue reads them.

use fundacad_core::params::{edit, targets::target_resolves};
use serde_json::{Map, Value};

use super::super::history::format_value;
use crate::document::meta;
use crate::i18n::tr;

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub name: String,
    pub expr: String,
    pub value: String,
    pub unit: String,
    pub comment: String,
    /// What a model parameter's target is, None on a user parameter.
    pub drives: Option<String>,
    /// Why the value is a stale cache.
    pub issue: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rows {
    pub user: Vec<Row>,
    pub model: Vec<Row>,
}

impl Rows {
    pub fn find(&self, name: &str) -> Option<&Row> {
        self.user.iter().chain(&self.model).find(|r| r.name == name)
    }
}

/// A value in its unit: lengths in mm, angles in degrees, counts plain.
pub fn value_text(value: f64, unit: &str) -> String {
    let v = format_value(value);
    match unit {
        "deg" => format!("{v}\u{b0}"),
        "count" => v,
        _ => format!("{v} mm"),
    }
}

fn feature_name(features: &[Value], id: &str) -> String {
    match features.iter().filter_map(Value::as_object).find(|f| f.get("id").and_then(Value::as_str) == Some(id)) {
        Some(f) => format!("{} {id}", meta(f).1),
        None => id.to_owned(),
    }
}

/// What a target drives, in the words of the Vue panel.
pub fn drives(features: &[Value], target: &Value) -> String {
    let s = |k: &str| target.get(k).and_then(Value::as_str).unwrap_or_default();
    match s("kind") {
        "feature" => format!("{} \u{b7} {}", feature_name(features, s("feature")), s("field")),
        "constraint" => tr!("params.drives.dimension", feature = feature_name(features, s("sketch"))),
        "entity" => tr!("params.drives.field", field = s("field"), feature = feature_name(features, s("sketch"))),
        "pattern" => tr!("params.drives.pattern", field = s("field"), feature = feature_name(features, s("sketch"))),
        other => other.to_owned(),
    }
}

pub fn rows(doc: &Map<String, Value>) -> Rows {
    let defs = edit::table(doc);
    let mut trial = doc.clone();
    if !trial.contains_key("paramDefs") {
        trial.insert("paramDefs".into(), Value::Object(defs.clone()));
    }
    let issues = edit::recompute(&mut trial).issues;
    let features = doc.get("features").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut out = Rows::default();
    for (name, d) in &defs {
        let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let target = d.get("target");
        let row = Row {
            name: name.clone(),
            expr: s("expr"),
            value: value_text(d.get("value").and_then(Value::as_f64).unwrap_or(0.), &s("unit")),
            unit: s("unit"),
            comment: s("comment"),
            drives: target.map(|t| drives(features, t)),
            issue: issues
                .get(name)
                .cloned()
                .or_else(|| target.filter(|t| !target_resolves(features, t)).map(|_| edit::TARGET_GONE.to_owned())),
        };
        if target.is_some() {
            out.model.push(row);
        } else {
            out.user.push(row);
        }
    }
    out
}

#[cfg(test)]
mod tests;
