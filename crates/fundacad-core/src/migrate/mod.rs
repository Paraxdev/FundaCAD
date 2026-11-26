//! Brings a document of an older version up to `DOCUMENT_VERSION` as it opens, the twin of FundaCAD 1's
//! src/document/migrate.ts. Idempotent: the steps that do not look at the version only add what is missing.

#[cfg(test)]
mod tests;

use serde_json::{json, Map, Value};

use crate::params::edit::next_d_name;
use crate::params::targets::{field_holder_mut, COMMON_NUM_FIELDS, FEATURE_NUM_FIELDS, RIGID_ENTITY_NUM_FIELDS};
use crate::params::FieldKind;
use crate::schema::DOCUMENT_VERSION;

/// A file written by a newer build, which this one cannot read without losing what it does not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Newer {
    pub version: u64,
}

impl std::fmt::Display for Newer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "it was saved by a newer FundaCAD (document version {}, this build reads up to {DOCUMENT_VERSION}), update FundaCAD to open it",
            self.version
        )
    }
}

/// The version a document is stamped with, 1 when it has none.
pub fn version_of(doc: &Map<String, Value>) -> u64 {
    doc.get("version").and_then(Value::as_u64).unwrap_or(1)
}

/// Upgrades `doc` in place and stamps it with this build's version. Returns the version it had.
pub fn migrate(doc: &mut Map<String, Value>) -> Result<u64, Newer> {
    let version = version_of(doc);
    if version > u64::from(DOCUMENT_VERSION) {
        return Err(Newer { version });
    }
    let mut empty = Vec::new();
    let mut taken = doc.get_mut("features").and_then(Value::as_array_mut).map(std::mem::take);
    let features = taken.as_mut().unwrap_or(&mut empty);
    if version < 9 {
        combine_to_boolean(features);
    }
    if version < 2 {
        polygon_angles_to_degrees(features);
    }
    constraint_ids(features);
    let params = doc.get("parameters").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut defs = doc.get("paramDefs").and_then(Value::as_object).cloned().unwrap_or_default();
    for (name, value) in &params {
        if !defs.contains_key(name) {
            defs.insert(name.clone(), json!({"expr": js_string(value), "value": value, "unit": "mm"}));
        }
    }
    bind_bare_names(features, &params, &mut defs);
    if let Some(features) = taken {
        doc.insert("features".into(), Value::Array(features));
    }
    if defs.is_empty() {
        doc.shift_remove("paramDefs");
    } else {
        doc.insert("paramDefs".into(), Value::Object(defs));
    }
    doc.insert("version".into(), json!(DOCUMENT_VERSION));
    Ok(version)
}

fn objects(features: &mut [Value]) -> impl Iterator<Item = &mut Map<String, Value>> {
    features.iter_mut().filter_map(Value::as_object_mut)
}

fn sketch_list<'a>(f: &'a mut Map<String, Value>, key: &str) -> impl Iterator<Item = &'a mut Map<String, Value>> {
    let is_sketch = f.get("type").and_then(Value::as_str) == Some("sketch");
    f.get_mut(key)
        .filter(|_| is_sketch)
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object_mut)
}

/// v8 -> v9, `combine` became `boolean`.
fn combine_to_boolean(features: &mut [Value]) {
    for f in objects(features) {
        if f.get("type").and_then(Value::as_str) != Some("combine") {
            continue;
        }
        f.insert("type".into(), json!("boolean"));
        let op = match f.get("operation").and_then(Value::as_str) {
            Some("cut") => "subtract",
            Some("intersect") => "intersect",
            _ => "union",
        };
        f.insert("operation".into(), json!(op));
        if let Some(keep) = f.shift_remove("keepTools") {
            // Omitted when false, as the writers do.
            if is_truthy(&keep) {
                f.insert("keepOriginals".into(), json!(true));
            }
        }
    }
}

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// v1 -> v2, a polygon's `angle` was in radians.
fn polygon_angles_to_degrees(features: &mut [Value]) {
    for f in objects(features) {
        for e in sketch_list(f, "entities") {
            if e.get("type").and_then(Value::as_str) != Some("polygon") {
                continue;
            }
            if let Some(rad) = e.get("angle").and_then(Value::as_f64) {
                e.insert("angle".into(), js_number((rad * 180.0) / std::f64::consts::PI));
            }
        }
    }
}

/// Every dimension constraint, one that carries a `value`, gets a `c` id past the highest already used.
fn constraint_ids(features: &mut [Value]) {
    let mut next = 0u64;
    for f in objects(features) {
        for c in sketch_list(f, "constraints") {
            if let Some(n) =
                c.get("id").and_then(Value::as_str).and_then(|id| id.strip_prefix('c')?.parse::<u64>().ok())
            {
                next = next.max(n + 1);
            }
        }
    }
    for f in objects(features) {
        for c in sketch_list(f, "constraints") {
            if c.contains_key("value") && !c.get("id").is_some_and(|id| !id.is_null()) {
                c.insert("id".into(), json!(format!("c{next}")));
                next += 1;
            }
        }
    }
}

/// A field that names a plain parameter takes its value, and a model parameter owns the field.
fn bind_bare_names(features: &mut [Value], params: &Map<String, Value>, defs: &mut Map<String, Value>) {
    for f in objects(features) {
        let id = f.get("id").cloned().unwrap_or(Value::Null);
        let ty = f.get("type").and_then(Value::as_str).unwrap_or_default().to_owned();
        let mut rows: Vec<(&str, FieldKind)> =
            FEATURE_NUM_FIELDS.iter().find(|(k, _)| *k == ty).map(|(_, rows)| rows.to_vec()).unwrap_or_default();
        rows.extend(COMMON_NUM_FIELDS.iter().filter(|(field, _)| f.contains_key(*field)).copied());
        for (field, kind) in rows {
            bind(f, field, kind, json!({"kind": "feature", "feature": id, "field": field}), params, defs);
        }
        for e in sketch_list(f, "entities") {
            let Some(entity) = e.get("id").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).cloned() else {
                continue;
            };
            let ety = e.get("type").and_then(Value::as_str).unwrap_or_default();
            let Some((_, rows)) = RIGID_ENTITY_NUM_FIELDS.iter().find(|(k, _)| *k == ety) else { continue };
            for &(field, kind) in *rows {
                let target = json!({"kind": "entity", "sketch": id, "entity": entity, "field": field});
                bind(e, field, kind, target, params, defs);
            }
        }
    }
}

fn bind(
    holder: &mut Map<String, Value>,
    field: &str,
    kind: FieldKind,
    target: Value,
    params: &Map<String, Value>,
    defs: &mut Map<String, Value>,
) {
    let Some((h, key)) = field_holder_mut(holder, field) else { return };
    let Some(Value::String(raw)) = h.get(key) else { return };
    let raw = raw.clone();
    // A name that is no parameter is left for the engine to report.
    let Some(value) = params.get(&raw).filter(|v| !v.is_null()) else { return };
    h.insert(key.to_owned(), value.clone());
    // One definition per target: a second would override the one the panel edits.
    if let Some(existing) =
        defs.values_mut().filter_map(Value::as_object_mut).find(|d| d.get("target") == Some(&target))
    {
        existing.insert("expr".into(), json!(raw));
        existing.insert("value".into(), value.clone());
    } else {
        let unit = match kind {
            FieldKind::Length => "mm",
            FieldKind::Angle => "deg",
            FieldKind::Count => "count",
        };
        let name = next_d_name(defs);
        defs.insert(name, json!({"expr": raw, "value": value, "unit": unit, "target": target}));
    }
}

/// `String(value)` as JavaScript writes a parameter's value.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(x) if n.is_f64() && x.fract() == 0.0 && x.abs() < 1e21 => format!("{x:.0}"),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

/// A whole number is written without a fraction, as JavaScript writes it.
fn js_number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}
