//! Adding, renaming and deleting parameters and the cleanup after every edit, the twin of `src/params/engine.ts`. Each
//! edit checks first and leaves the document as it was when it refuses, then runs [`recompute`], so one call is one
//! undo step for the app.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::targets::{number, target_resolves, write_target, Wrote};
use super::{is_ident_name, is_reserved_name, parse_expr, refs_of, rename_refs, resolve, validate_expr};
use crate::schema::ParamDef;

pub const TARGET_GONE: &str = "its dimension or feature no longer exists";

/// `NON_NUM_STRING_FIELDS`: string fields that never hold a bare parameter name, skipped by the legacy scans.
pub const NON_NUM_STRING_FIELDS: &[&str] = &[
    "id",
    "type",
    "name",
    "operation",
    "font",
    "style",
    "align",
    "text",
    "pathRef",
    "plane",
    "sketch",
    "axis",
    "profile",
    "path",
    "direction",
    "body",
    "imagePath",
    "solid",
    "ground",
    "drive",
    "mode",
];

/// Names a JavaScript object already carries, refused so a document still opens in the web app.
const OBJECT_PROTO_NAMES: &[&str] = &[
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

pub const UNITS: &[&str] = &["mm", "deg", "count"];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Recomputed {
    /// Why each such parameter kept its cached value.
    pub issues: IndexMap<String, String>,
    /// Sketches a value was written into, each once, which want a re-solve.
    pub sketches: Vec<String>,
}

pub fn defs_of(doc: &Map<String, Value>) -> Option<&Map<String, Value>> {
    doc.get("paramDefs").and_then(Value::as_object)
}

/// The table, made from a plain `parameters` map when the document has none yet, as migrate.ts does on load.
pub fn table(doc: &Map<String, Value>) -> Map<String, Value> {
    if let Some(defs) = defs_of(doc) {
        return defs.clone();
    }
    doc.get("parameters")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, v)| v.is_number())
        .map(|(n, v)| {
            let mut d = Map::new();
            d.insert("expr".into(), Value::String(v.to_string()));
            d.insert("value".into(), v.clone());
            d.insert("unit".into(), Value::from("mm"));
            (n.clone(), Value::Object(d))
        })
        .collect()
}

fn defs_mut(doc: &mut Map<String, Value>) -> &mut Map<String, Value> {
    if defs_of(doc).is_none() {
        let seeded = table(doc);
        doc.insert("paramDefs".into(), Value::Object(seeded));
    }
    doc.get_mut("paramDefs").and_then(Value::as_object_mut).expect("set above")
}

/// What `expr` would evaluate to as the expression of `name` (a new parameter when None), without changing anything.
pub fn check_expr(doc: &Map<String, Value>, name: Option<&str>, expr: &str) -> Result<f64, String> {
    validate_expr(&typed(&table(doc))?, name, expr, None)
}

fn typed(defs: &Map<String, Value>) -> Result<IndexMap<String, ParamDef>, String> {
    serde_json::from_value(Value::Object(defs.clone())).map_err(|e| format!("the parameter table does not read: {e}"))
}

fn expr_of(def: &Value) -> &str {
    def.get("expr").and_then(Value::as_str).unwrap_or_default()
}

fn expr_refs(expr: &str) -> Vec<String> {
    parse_expr(expr).map(|n| refs_of(&n)).unwrap_or_default()
}

fn rename_in(expr: &str, from: &str, to: &str) -> String {
    rename_refs(expr, from, to).unwrap_or_else(|_| expr.to_owned())
}

/// The next free model parameter name, d1, d2 and on past the highest.
pub fn next_d_name(defs: &Map<String, Value>) -> String {
    let n = defs.keys().filter_map(|k| k.strip_prefix('d')?.parse::<u64>().ok()).map(|n| n + 1).max().unwrap_or(1);
    format!("d{n}")
}

fn is_d_name(name: &str) -> bool {
    name.strip_prefix('d').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Why `name` cannot be a new user parameter's name.
pub fn validate_name(defs: &Map<String, Value>, name: &str) -> Result<(), String> {
    if !is_ident_name(name) {
        return Err("names are letters, digits and _ (not starting with a digit)".to_owned());
    }
    if is_reserved_name(name) || OBJECT_PROTO_NAMES.contains(&name) {
        return Err(format!("\"{name}\" is a reserved name"));
    }
    if defs.contains_key(name) {
        return Err(format!("\"{name}\" already exists"));
    }
    if is_d_name(name) {
        return Err("dN names are reserved for model parameters".to_owned());
    }
    Ok(())
}

fn pointer_key(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

/// Every legacy string field equal to `name`, from files older than the table: its label and its JSON pointer under
/// `features`. All string fields but the denylist count, since such a file could hold a bare name on any number.
fn bare_name_refs(features: &[Value], name: &str) -> Vec<(String, String)> {
    let named = |k: &str, v: &Value| v.as_str() == Some(name) && !NON_NUM_STRING_FIELDS.contains(&k);
    let mut out = Vec::new();
    for (i, f) in features.iter().enumerate() {
        let Some(f) = f.as_object() else { continue };
        let ty = f.get("type").and_then(Value::as_str).unwrap_or_default();
        let id = f.get("id").and_then(Value::as_str).unwrap_or_default();
        let sketch = ty == "sketch";
        for (k, v) in f {
            if named(k, v) {
                out.push((format!("{ty} {id} \u{b7} {k}"), format!("/{i}/{}", pointer_key(k))));
            }
            let Some(list) = v.as_array().filter(|_| !(sketch && k == "entities")) else { continue };
            for (j, e) in list.iter().enumerate() {
                let Some((e, eid)) = e.as_object().and_then(|e| Some((e, e.get("id")?.as_str()?))) else { continue };
                for (ek, ev) in e {
                    if named(ek, ev) {
                        out.push((
                            format!("{ty} {id} \u{b7} {k}.{eid}.{ek}"),
                            format!("/{i}/{}/{j}/{}", pointer_key(k), pointer_key(ek)),
                        ));
                    }
                }
            }
        }
        if !sketch {
            continue;
        }
        for (j, e) in f.get("entities").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let Some(e) = e.as_object() else { continue };
            let ety = e.get("type").and_then(Value::as_str).unwrap_or_default();
            for (k, v) in e {
                if named(k, v) {
                    out.push((format!("{ety} in {id} \u{b7} {k}"), format!("/{i}/entities/{j}/{}", pointer_key(k))));
                }
            }
        }
    }
    out
}

fn features_of(doc: &Map<String, Value>) -> &[Value] {
    doc.get("features").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn extras_list<'a>(doc: &'a Map<String, Value>, key: &str) -> impl Iterator<Item = &'a Map<String, Value>> {
    doc.get("paramExtras").and_then(|x| x.get(key)).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object)
}

/// Everything that reads `name`: expressions, checks, configuration values and legacy bare-name fields. A
/// configuration that only sets `name` does not read it, deleting drops that entry.
pub fn references_to(doc: &Map<String, Value>, name: &str) -> Vec<String> {
    let mut out: Vec<String> = defs_of(doc)
        .into_iter()
        .flatten()
        .filter(|(n, d)| *n != name && expr_refs(expr_of(d)).iter().any(|r| r == name))
        .map(|(n, _)| n.clone())
        .collect();
    for c in extras_list(doc, "checks") {
        if expr_refs(c.get("expr").and_then(Value::as_str).unwrap_or_default()).iter().any(|r| r == name) {
            out.push(format!("check \"{}\"", c.get("message").and_then(Value::as_str).unwrap_or_default()));
        }
    }
    for cfg in extras_list(doc, "configurations") {
        let cfg_name = cfg.get("name").and_then(Value::as_str).unwrap_or_default();
        for (param, expr) in cfg.get("values").and_then(Value::as_object).into_iter().flatten() {
            if param != name && expr_refs(expr.as_str().unwrap_or_default()).iter().any(|r| r == name) {
                out.push(format!("configuration {cfg_name} \u{b7} {param}"));
            }
        }
    }
    out.extend(bare_name_refs(features_of(doc), name).into_iter().map(|(label, _)| label));
    out
}

/// Why `name` cannot be deleted now, None when it is free.
pub fn delete_blockers(doc: &Map<String, Value>, name: &str) -> Option<String> {
    if !defs_of(doc).is_some_and(|d| d.contains_key(name)) {
        return Some(format!("no parameter \"{name}\""));
    }
    let refs = references_to(doc, name);
    (!refs.is_empty()).then(|| format!("\"{name}\" is referenced by: {}", refs.join(", ")))
}

fn has_param(doc: &Map<String, Value>, name: &str) -> Result<(), String> {
    let known = match defs_of(doc) {
        Some(defs) => defs.contains_key(name),
        None => doc.get("parameters").and_then(Value::as_object).is_some_and(|p| p.contains_key(name)),
    };
    if known {
        Ok(())
    } else {
        Err(format!("no parameter named \"{name}\""))
    }
}

/// A new user parameter at the end of the table.
pub fn add_param(doc: &mut Map<String, Value>, name: &str, expr: &str, unit: &str) -> Result<Recomputed, String> {
    if !UNITS.contains(&unit) {
        return Err(format!("\"{unit}\" is not a parameter unit"));
    }
    let mut trial = doc.clone();
    let defs = defs_mut(&mut trial);
    validate_name(defs, name)?;
    validate_expr(&typed(defs)?, Some(name), expr, None)?;
    let mut def = Map::new();
    def.insert("expr".into(), Value::String(expr.to_owned()));
    def.insert("value".into(), Value::from(0));
    def.insert("unit".into(), Value::from(unit));
    defs.insert(name.to_owned(), Value::Object(def));
    *doc = trial;
    Ok(recompute(doc))
}

/// A parameter's expression, refused when it does not parse, names an unknown parameter, closes a cycle or does not
/// evaluate to a finite number.
pub fn set_param_expr(doc: &mut Map<String, Value>, name: &str, expr: &str) -> Result<Recomputed, String> {
    has_param(doc, name)?;
    let mut trial = doc.clone();
    let defs = defs_mut(&mut trial);
    validate_expr(&typed(defs)?, Some(name), expr, None)?;
    if let Some(d) = defs.get_mut(name).and_then(Value::as_object_mut) {
        d.insert("expr".into(), Value::String(expr.to_owned()));
    }
    *doc = trial;
    Ok(recompute(doc))
}

/// An empty comment removes it.
pub fn set_param_comment(doc: &mut Map<String, Value>, name: &str, comment: &str) -> Result<(), String> {
    has_param(doc, name)?;
    let Some(def) = defs_mut(doc).get_mut(name).and_then(Value::as_object_mut) else {
        return Err(format!("no parameter named \"{name}\""));
    };
    if comment.is_empty() {
        def.shift_remove("comment");
    } else {
        def.insert("comment".into(), Value::String(comment.to_owned()));
    }
    Ok(())
}

/// Renames a parameter and every reference to it: expressions token by token, checks, configurations and legacy
/// bare-name fields. The parameter keeps its place in the table.
pub fn rename_param(doc: &mut Map<String, Value>, from: &str, to: &str) -> Result<Recomputed, String> {
    has_param(doc, from)?;
    if from == to {
        return Ok(recompute(doc));
    }
    let mut trial = doc.clone();
    let defs = defs_mut(&mut trial);
    validate_name(defs, to)?;
    let renamed: Map<String, Value> = std::mem::take(defs)
        .into_iter()
        .map(|(n, mut d)| {
            if let Some(d) = d.as_object_mut() {
                let expr = rename_in(d.get("expr").and_then(Value::as_str).unwrap_or_default(), from, to);
                d.insert("expr".into(), Value::String(expr));
            }
            (if n == from { to.to_owned() } else { n }, d)
        })
        .collect();
    *defs = renamed;
    if let Some(extras) = trial.get_mut("paramExtras").and_then(Value::as_object_mut) {
        for c in extras.get_mut("checks").and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(Value::String(expr)) = c.get_mut("expr") {
                *expr = rename_in(expr, from, to);
            }
        }
        for cfg in extras.get_mut("configurations").and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(values) = cfg.get_mut("values").and_then(Value::as_object_mut) {
                *values = std::mem::take(values)
                    .into_iter()
                    .map(|(n, e)| {
                        let e = e.as_str().map_or(e.clone(), |s| Value::String(rename_in(s, from, to)));
                        (if n == from { to.to_owned() } else { n }, e)
                    })
                    .collect();
            }
        }
    }
    let spots = bare_name_refs(features_of(&trial), from);
    if let Some(features) = trial.get_mut("features") {
        for (_, at) in spots {
            if let Some(v) = features.pointer_mut(&at) {
                *v = Value::String(to.to_owned());
            }
        }
    }
    *doc = trial;
    Ok(recompute(doc))
}

/// Deletes a parameter nothing reads, and drops what configurations set it to.
pub fn delete_param(doc: &mut Map<String, Value>, name: &str) -> Result<Recomputed, String> {
    if let Some(why) = delete_blockers(doc, name) {
        return Err(why);
    }
    defs_mut(doc).shift_remove(name);
    if let Some(cfgs) =
        doc.get_mut("paramExtras").and_then(|x| x.get_mut("configurations")).and_then(Value::as_array_mut)
    {
        for cfg in cfgs {
            if let Some(values) = cfg.get_mut("values").and_then(Value::as_object_mut) {
                values.shift_remove(name);
            }
        }
    }
    Ok(recompute(doc))
}

/// Evaluates the table in dependency order and writes each value into its row, the `parameters` cache and the field
/// its target names. A model parameter whose target is gone is dropped when nothing reads it, else it keeps its
/// value with an issue. A table that does not read is left alone.
pub fn recompute(doc: &mut Map<String, Value>) -> Recomputed {
    let mut out = Recomputed::default();
    let Some(mut defs) = defs_of(doc).cloned() else { return out };
    let referenced: HashSet<String> = defs.values().flat_map(|d| expr_refs(expr_of(d))).collect();
    let features = features_of(doc);
    let gone: Vec<String> = defs
        .iter()
        .filter(|(_, d)| d.get("target").is_some_and(|t| !target_resolves(features, t)))
        .map(|(n, _)| n.clone())
        .collect();
    for name in gone {
        if referenced.contains(&name) {
            out.issues.insert(name, TARGET_GONE.to_owned());
        } else {
            defs.shift_remove(&name);
        }
    }
    let table = match typed(&defs) {
        Ok(t) => t,
        Err(why) => {
            out.issues.insert(String::new(), why);
            return out;
        }
    };
    let r = resolve(&table);
    for (name, why) in r.issues {
        out.issues.entry(name).or_insert(why);
    }
    let mut writes = Vec::new();
    for (name, def) in defs.iter_mut() {
        let (Some(v), Some(def)) = (r.values.get(name), def.as_object_mut()) else { continue };
        if def.get("value").and_then(Value::as_f64) != Some(*v) {
            def.insert("value".into(), number(*v));
        }
        if let Some(t) = def.get("target") {
            writes.push((t.clone(), *v));
        }
    }
    let cache: Map<String, Value> =
        defs.iter().map(|(n, d)| (n.clone(), d.get("value").cloned().unwrap_or(Value::from(0)))).collect();
    doc.insert("paramDefs".into(), Value::Object(defs));
    doc.insert("parameters".into(), Value::Object(cache));
    if let Some(features) = doc.get_mut("features").and_then(Value::as_array_mut) {
        for (target, v) in writes {
            if let Wrote::Sketch(id) = write_target(features, &target, v) {
                if !out.sketches.contains(&id) {
                    out.sketches.push(id);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
