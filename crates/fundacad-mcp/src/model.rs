//! The document an agent is editing: features, parameters, and the edits to
//! both. A port of the Python MCP server's `model.py`.
//!
//! A FundaCAD document is a declarative feature list plus a parameter table,
//! and nothing here knows how to build it, that is the engine's job. What lives
//! here is everything that has to be true BEFORE a rebuild is worth asking for:
//! ids are unique, a feature that references a sketch references one that
//! exists, a parameter table has no cycle in it.
//!
//! The document stays untyped JSON on purpose. A feature type this build has
//! never heard of still has to round trip through `doc_get`, `doc_set` and a
//! save, and a typed schema would quietly drop the fields it did not know.
//!
//! `paramDefs` is the source of truth (name -> {expr, value, unit}) and
//! `parameters` is the derived name to number cache the ENGINE reads: it has no
//! expression evaluator and never will, so the cache is not an optimisation, it
//! is the interface.

use std::collections::{BTreeMap, BTreeSet};

use fundacad_core::body_ids::{forget_feature, join_went_stale};
use fundacad_core::params::{eval_node, is_reserved_name, parse_expr, refs_of, Expr};
use fundacad_core::schema::Feature;
use serde_json::{json, Map, Value};

pub type Doc = Map<String, Value>;

pub const FORMAT_VERSION: i64 = 9;

/// An edit that would leave the document unbuildable. Returned BEFORE anything
/// is written, so a refused edit changes nothing.
#[derive(Debug, Clone)]
pub struct DocumentError(pub String);

impl std::fmt::Display for DocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DocumentError {}

fn err<T>(message: impl Into<String>) -> Result<T, DocumentError> {
    Err(DocumentError(message.into()))
}

pub fn new_document() -> Doc {
    let mut d = Map::new();
    d.insert("version".into(), json!(FORMAT_VERSION));
    d.insert("parameters".into(), json!({}));
    d.insert("paramDefs".into(), json!({}));
    d.insert("features".into(), json!([]));
    d.insert("bodyIds".into(), json!({}));
    d
}

/// `parameters` and `paramDefs`, added when a document arrived without them.
pub fn fill_defaults(doc: &mut Doc) {
    doc.entry("parameters").or_insert_with(|| json!({}));
    doc.entry("paramDefs").or_insert_with(|| json!({}));
}

pub fn features(doc: &Doc) -> &[Value] {
    doc.get("features")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

fn features_mut(doc: &mut Doc) -> &mut Vec<Value> {
    doc.entry("features")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .expect("features is a list")
}

pub fn feature_ids(doc: &Doc) -> Vec<String> {
    features(doc)
        .iter()
        .map(|f| str_field(f, "id").unwrap_or_default().to_string())
        .collect()
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub fn find_feature<'a>(doc: &'a Doc, fid: &str) -> Option<(usize, &'a Value)> {
    features(doc)
        .iter()
        .enumerate()
        .find(|(_, f)| str_field(f, "id") == Some(fid))
}

/// `prefix` plus the lowest free number. Ids are the ONLY way a later feature
/// names an earlier one, so they are unique across the document and stable
/// across edits, never positional.
pub fn next_id(doc: &Doc, prefix: &str) -> String {
    let used: BTreeSet<String> = feature_ids(doc).into_iter().collect();
    let mut n = 1;
    loop {
        let candidate = format!("{prefix}{n}");
        if !used.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

const PREFIXES: &[(&str, &str)] = &[
    ("sketch", "sk"),
    ("extrude", "ex"),
    ("revolve", "rev"),
    ("fillet", "fil"),
    ("chamfer", "cha"),
    ("press-pull", "pp"),
    ("box", "bx"),
    ("cylinder", "cy"),
    ("cone", "cn"),
    ("torus", "to"),
    ("sphere", "sp"),
    ("shell", "sh"),
    ("boolean", "bo"),
    ("mirror", "mir"),
    ("loft", "lo"),
    ("sweep", "sw"),
    ("datumPlane", "pl"),
    ("move", "mv"),
    ("duplicate", "dup"),
    ("patternCircular", "pc"),
    ("patternLinear", "pln"),
    ("split", "spl"),
    ("hole", "ho"),
];

fn prefix_for(kind: &str) -> &'static str {
    PREFIXES
        .iter()
        .find(|(k, _)| *k == kind)
        .map_or("f", |(_, p)| *p)
}

fn is_id(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && s.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Append (or insert at `at`) one feature, returning its id. Order is the
/// timeline: a feature can only reference what is ABOVE it, so an insert in the
/// middle is a real operation and not a convenience.
pub fn add_feature(
    doc: &mut Doc,
    feature: &Value,
    at: Option<i64>,
) -> Result<String, DocumentError> {
    let Some(obj) = feature.as_object() else {
        return err("a feature needs a `type`");
    };
    let kind = str_field(feature, "type").unwrap_or_default();
    if kind.is_empty() {
        return err("a feature needs a `type`");
    }
    if !crate::schema::features().contains_key(kind) {
        return err(format!("unknown feature type: {kind}"));
    }
    let mut f = obj.clone();
    let fid = match f.get("id") {
        None | Some(Value::Null) => {
            let fid = next_id(doc, prefix_for(kind));
            f.insert("id".into(), json!(fid));
            fid
        }
        Some(v) => {
            let text = v.as_str().map_or_else(|| v.to_string(), str::to_string);
            if !is_id(&text) {
                return err(format!(
                    "bad feature id {}: letters, digits and _ only",
                    py_repr(v)
                ));
            }
            if feature_ids(doc).iter().any(|k| k == &text) {
                return err(format!("feature id '{text}' is already used"));
            }
            text
        }
    };
    if let Some(msg) = missing_fields_message(kind, &f) {
        return err(msg);
    }
    let f = Value::Object(f);
    forget_stale_join(doc, None, &f);
    let feats = features_mut(doc);
    match at {
        Some(at) if (at as usize) < feats.len() => {
            feats.insert(at.max(0) as usize, f);
        }
        _ => feats.push(f),
    }
    Ok(fid)
}

/// A feature that became a join, or joins other targets now, loses its
/// `bodyIds` records so the merged body takes its target's id.
fn forget_stale_join(doc: &mut Doc, before: Option<&Value>, after: &Value) {
    if !join_went_stale(before, after) {
        return;
    }
    if let (Some(fid), Some(Value::Object(map))) = (str_field(after, "id"), doc.get_mut("bodyIds")) {
        forget_feature(map, fid);
    }
}

/// Merge `patch` into a feature (or replace its body wholesale).
///
/// A merge cannot remove a field, which matters: `upTo` on a press/pull and
/// `axisEdge` on a revolve are both fields whose PRESENCE changes what the
/// feature means. `replace` is how they come off, and a null in a merge patch
/// deletes that key for the same reason.
pub fn update_feature(
    doc: &mut Doc,
    fid: &str,
    patch: &Value,
    replace: bool,
) -> Result<Value, DocumentError> {
    let Some((i, existing)) = find_feature(doc, fid) else {
        return err(missing_feature(doc, fid));
    };
    let existing = existing.clone();
    let patch = patch.as_object().cloned().unwrap_or_default();
    let mut out = if replace {
        let mut out = patch;
        out.insert("id".into(), json!(fid));
        if !out.contains_key("type") {
            if let Some(t) = existing.get("type") {
                out.insert("type".into(), t.clone());
            }
        }
        out
    } else {
        let mut out = existing.as_object().cloned().unwrap_or_default();
        for (k, v) in patch {
            if k == "id" {
                continue;
            }
            if k == "type" && !v.as_str().is_some_and(|t| !t.is_empty()) {
                return err("a feature needs a `type`");
            }
            if v.is_null() {
                out.remove(&k);
            } else {
                out.insert(k, v);
            }
        }
        out.insert("id".into(), json!(fid));
        out
    };
    out.entry("id").or_insert_with(|| json!(fid));
    let was = str_field(&existing, "type").unwrap_or_default();
    let now = out.get("type").and_then(Value::as_str).unwrap_or_default();
    if now != was {
        check_new_type(fid, was, now, &out)?;
    }
    let value = Value::Object(out);
    forget_stale_join(doc, Some(&existing), &value);
    features_mut(doc)[i] = value.clone();
    Ok(value)
}

/// A feature whose type changes is checked as the new type straight away, since
/// a field the new type needs and does not have only fails at the next build.
fn check_new_type(fid: &str, was: &str, now: &str, f: &Map<String, Value>) -> Result<(), DocumentError> {
    let (missing, other) = if Feature::is_core_type(now) {
        core_missing_fields(f)
    } else {
        (documented_missing_fields(now, f), None)
    };
    if !missing.is_empty() {
        let list: Vec<String> = missing.iter().map(|k| format!("`{k}`")).collect();
        return err(format!(
            "{fid}: as a {now} it would be missing {}. Send the fields a {now} needs in the \
             same patch as the new `type` (a null removes a field the {was} had), or \
             feature_remove it and feature_add a {now} instead.",
            list.join(", ")
        ));
    }
    if let Some(why) = other {
        return err(format!("{fid}: as a {now} this feature is malformed: {why}"));
    }
    Ok(())
}

/// What `build` would refuse this feature for, if anything: a required field it
/// does not have, or (for a documented plugin type) a malformed shape. Checked
/// at `feature_add` time so the refusal comes back on the call that caused it,
/// the same way a dangling `sketch` reference already does, rather than one
/// unrelated `build` later.
fn missing_fields_message(kind: &str, f: &Map<String, Value>) -> Option<String> {
    let (missing, other) = if Feature::is_core_type(kind) {
        core_missing_fields(f)
    } else {
        (documented_missing_fields(kind, f), None)
    };
    let label = f.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(kind);
    match missing.as_slice() {
        [] => other.map(|why| format!("{label} is malformed: {why}")),
        [one] => Some(format!("{label} is missing the field \"{one}\"")),
        many => Some(format!(
            "{label} is missing the fields {}",
            many.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Every field serde says a core feature is missing, found by filling each in
/// with a stand-in until the next complaint is about something else.
fn core_missing_fields(f: &Map<String, Value>) -> (Vec<String>, Option<String>) {
    let stand_ins = || {
        [json!(0), json!(""), json!([]), json!({}), json!([0, 0, 0]), json!("XY"), json!(false)]
    };
    let complaint = |probe: &Map<String, Value>| {
        match serde_json::from_value::<Feature>(Value::Object(probe.clone())) {
            Ok(Feature::Invalid(inv)) => Some(inv.error),
            Ok(_) => None,
            Err(e) => Some(e.to_string()),
        }
    };
    let mut probe = f.clone();
    let mut missing: Vec<String> = Vec::new();
    let mut why = complaint(&probe);
    while let Some(key) = why.as_deref().and_then(missing_field) {
        if missing.contains(&key) {
            break;
        }
        missing.push(key.clone());
        why = None;
        for v in stand_ins() {
            probe.insert(key.clone(), v);
            let next = complaint(&probe);
            if next.as_deref().and_then(missing_field).is_some() || next.is_none() {
                why = next;
                break;
            }
        }
    }
    let other = if missing.is_empty() { why } else { None };
    (missing, other)
}

fn missing_field(error: &str) -> Option<String> {
    let rest = error.split("missing field `").nth(1)?;
    Some(rest[..rest.find('`')?].to_owned())
}

/// A plugin feature's fields the schema documents without `optional`.
fn documented_missing_fields(kind: &str, f: &Map<String, Value>) -> Vec<String> {
    let Some(fields) = crate::schema::features()
        .get(kind)
        .and_then(|t| t.get("fields"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    fields
        .iter()
        .filter(|(k, doc)| {
            *k != "see"
                && !doc.as_str().unwrap_or_default().starts_with("optional")
                && f.get(k.as_str()).map_or(true, Value::is_null)
        })
        .map(|(k, _)| k.clone())
        .collect()
}

pub fn remove_feature(doc: &mut Doc, fid: &str) -> Result<Value, DocumentError> {
    let Some((i, _)) = find_feature(doc, fid) else {
        return err(missing_feature(doc, fid));
    };
    Ok(features_mut(doc).remove(i))
}

pub fn move_feature(doc: &mut Doc, fid: &str, to: i64) -> Result<Value, DocumentError> {
    let Some((i, _)) = find_feature(doc, fid) else {
        return err(missing_feature(doc, fid));
    };
    let feats = features_mut(doc);
    let f = feats.remove(i);
    let at = to.clamp(0, feats.len() as i64) as usize;
    feats.insert(at, f.clone());
    Ok(f)
}

fn missing_feature(doc: &Doc, fid: &str) -> String {
    let have: Vec<String> = feature_ids(doc).iter().map(|i| format!("'{i}'")).collect();
    format!("no feature '{fid}', have [{}]", have.join(", "))
}

/// What Python's `{x!r}` prints for a JSON value, so a refusal reads the same
/// on both servers.
fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => format!("'{s}'"),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Null => "None".into(),
        other => other.to_string(),
    }
}

// --- parameters --------------------------------------------------------------

const PANEL_KEYS: &[&str] = &["control", "group", "hidden"];

fn param_defs_mut(doc: &mut Doc) -> &mut Map<String, Value> {
    doc.entry("paramDefs")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("paramDefs is an object")
}

pub fn param_defs(doc: &Doc) -> Map<String, Value> {
    doc.get("paramDefs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Define or redefine one parameter and recompute the whole table.
///
/// `expr` may be a number or a string; both are stored as the string that was
/// written, because that string is the parametric part. Storing 12.5 where
/// `hub_d/2` was meant severs the link the moment hub_d changes.
pub fn set_parameter(
    doc: &mut Doc,
    name: &str,
    expr: &Value,
    unit: &str,
    comment: Option<&str>,
) -> Result<Value, DocumentError> {
    if !is_id(name) {
        return err(format!("bad parameter name '{name}'"));
    }
    if is_reserved_name(name) {
        return err(format!(
            "'{name}' is a reserved name (a function, unit or constant)"
        ));
    }
    let text = expr_text(expr);
    let before = param_defs(doc).get(name).cloned();
    let mut def = Map::new();
    def.insert("expr".into(), json!(text));
    def.insert("value".into(), json!(0.0));
    def.insert("unit".into(), json!(unit));
    if let Some(c) = comment.filter(|c| !c.is_empty()) {
        def.insert("comment".into(), json!(c));
    }
    // How the app's parameters panel edits and files this parameter. Not the
    // agent's to lose by redefining the value.
    for key in PANEL_KEYS {
        if let Some(v) = before.as_ref().and_then(|b| b.get(*key)) {
            def.insert((*key).into(), v.clone());
        }
    }
    param_defs_mut(doc).insert(name.into(), Value::Object(def));
    let issues = recompute_parameters(doc);
    if let Some(why) = issues.get(name) {
        let why = why.clone();
        // Put the table back exactly as it was: a refused edit that left a
        // broken definition behind would break every LATER edit too.
        match &before {
            None => {
                param_defs_mut(doc).remove(name);
            }
            Some(b) => {
                param_defs_mut(doc).insert(name.into(), b.clone());
            }
        }
        recompute_parameters(doc);
        return err(format!("{name} = {}: {why}", py_repr(&json!(text))));
    }
    Ok(param_defs(doc).get(name).cloned().unwrap_or(Value::Null))
}

/// The string a parameter definition stores. `str(expr)` in Python, which for a
/// whole number arriving as JSON prints `12` and not `12.0`.
fn expr_text(expr: &Value) -> String {
    match expr {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e16 => format!("{}", f as i64),
            Some(f) => format!("{f}"),
            None => n.to_string(),
        },
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        other => other.to_string(),
    }
}

pub fn remove_parameter(doc: &mut Doc, name: &str) -> Result<(), DocumentError> {
    let defs = param_defs(doc);
    if !defs.contains_key(name) {
        let mut have: Vec<String> = defs.keys().map(|k| format!("'{k}'")).collect();
        have.sort();
        return err(format!("no parameter '{name}', have [{}]", have.join(", ")));
    }
    let mut users: Vec<String> = defs
        .iter()
        .filter(|(n, d)| {
            n.as_str() != name && safe_refs(d.get("expr")).contains(&name.to_string())
        })
        .map(|(n, _)| n.clone())
        .collect();
    for u in feature_users_of_param(doc, name) {
        users.push(u);
    }
    let extras = doc.get("paramExtras").cloned().unwrap_or(Value::Null);
    for c in extras.get("checks").and_then(Value::as_array).into_iter().flatten() {
        if safe_refs(c.get("expr")).contains(&name.to_string()) {
            users.push(format!(
                "check \"{}\"",
                c.get("message").and_then(Value::as_str).unwrap_or("None")
            ));
        }
    }
    for cfg in extras
        .get("configurations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let cfg_name = cfg.get("name").and_then(Value::as_str).unwrap_or("None");
        for (p, e) in cfg
            .get("values")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            if p != name && safe_refs(Some(e)).contains(&name.to_string()) {
                users.push(format!("configuration {cfg_name} . {p}"));
            }
        }
    }
    if !users.is_empty() {
        users.sort();
        return err(format!("{name} is used by {}", users.join(", ")));
    }
    param_defs_mut(doc).remove(name);
    if let Some(cfgs) = doc
        .get_mut("paramExtras")
        .and_then(|e| e.get_mut("configurations"))
        .and_then(Value::as_array_mut)
    {
        for cfg in cfgs {
            if let Some(vals) = cfg.get_mut("values").and_then(Value::as_object_mut) {
                vals.remove(name);
            }
        }
    }
    recompute_parameters(doc);
    Ok(())
}

/// Feature fields that name parameter `name`, bare or inside an expression.
/// Mirrors the numeric-field detection `validate` uses, so a field that is
/// never a number (an id, a body name that happens to match) is never
/// mistaken for a usage.
fn feature_users_of_param(doc: &Doc, name: &str) -> Vec<String> {
    let mut users = Vec::new();
    for f in features(doc) {
        let Some(obj) = f.as_object() else { continue };
        let fid = str_field(f, "id").unwrap_or_default();
        let kind = str_field(f, "type").unwrap_or_default();
        for (k, v) in obj {
            if v.as_str().is_none() {
                continue;
            }
            if NOT_NUMERIC.contains(&k.as_str()) || documented_not_numeric(kind, k) {
                continue;
            }
            if safe_refs(Some(v)).contains(name) {
                users.push(format!("{fid}.{k}"));
                break;
            }
        }
    }
    users
}

fn safe_refs(src: Option<&Value>) -> BTreeSet<String> {
    src.and_then(Value::as_str)
        .and_then(|s| parse_expr(s).ok())
        .map(|n| refs_of(&n).into_iter().collect())
        .unwrap_or_default()
}

struct Table(BTreeMap<String, f64>);

impl fundacad_core::params::Scope for Table {
    fn get(&self, name: &str) -> Option<f64> {
        self.0.get(name).copied()
    }
}

/// Evaluate every definition in dependency order, write the derived cache, and
/// return {name: why} for the ones that could not be evaluated.
///
/// Resolution is iterative rather than a topological sort on purpose: what is
/// left over when no further definition can be resolved IS the cycle, so cycle
/// detection costs nothing extra and names every member of it.
///
/// A broken definition keeps its last good value in the cache. That is the
/// frontend's rule and it matters for the same reason: a document being edited
/// passes through states where one parameter is momentarily unresolvable, and
/// dropping its value there would take the geometry down with it.
pub fn recompute_parameters(doc: &mut Doc) -> BTreeMap<String, String> {
    let defs = param_defs(doc);
    let mut issues: BTreeMap<String, String> = BTreeMap::new();
    let mut nodes: BTreeMap<String, Option<Expr>> = BTreeMap::new();
    for (name, d) in &defs {
        let src = d.get("expr").and_then(Value::as_str).unwrap_or("");
        match parse_expr(src) {
            Ok(node) => {
                nodes.insert(name.clone(), Some(node));
            }
            Err(e) => {
                nodes.insert(name.clone(), None);
                issues.insert(name.clone(), e.message);
            }
        }
    }

    let mut cache = Table(BTreeMap::new());
    let mut values: BTreeMap<String, f64> = BTreeMap::new();
    let mut pending: BTreeSet<String> = nodes
        .iter()
        .filter(|(_, n)| n.is_some())
        .map(|(k, _)| k.clone())
        .collect();

    while !pending.is_empty() {
        let mut progressed = false;
        for name in pending.iter().cloned().collect::<Vec<_>>() {
            let node = nodes[&name].as_ref().expect("pending nodes parsed");
            if !refs_of(node)
                .iter()
                .all(|r| cache.0.contains_key(r) || fundacad_core::params::parse::constant(r).is_some())
            {
                continue;
            }
            match eval_node(node, &cache) {
                Err(e) => {
                    issues.insert(name.clone(), e.message);
                }
                Ok(v) if v.is_nan() || v.is_infinite() => {
                    issues.insert(name.clone(), "does not evaluate to a finite number".into());
                }
                Ok(v) => {
                    cache.0.insert(name.clone(), v);
                    values.insert(name.clone(), v);
                }
            }
            pending.remove(&name);
            progressed = true;
            break;
        }
        if !progressed {
            for name in &pending {
                let node = nodes[name].as_ref().expect("pending nodes parsed");
                let unknown: BTreeSet<String> = refs_of(node)
                    .into_iter()
                    .filter(|r| {
                        !defs.contains_key(r)
                            && fundacad_core::params::parse::constant(r).is_none()
                    })
                    .collect();
                issues.insert(
                    name.clone(),
                    if unknown.is_empty() {
                        "is part of a reference cycle".into()
                    } else {
                        format!(
                            "unknown parameter {}",
                            unknown.into_iter().collect::<Vec<_>>().join(", ")
                        )
                    },
                );
            }
            break;
        }
    }

    // Broken definitions keep their last value, so the cache the engine reads
    // is always complete.
    let mut cached: BTreeMap<String, f64> = cache.0;
    for (name, d) in &defs {
        cached
            .entry(name.clone())
            .or_insert_with(|| d.get("value").and_then(Value::as_f64).unwrap_or(0.0));
    }

    {
        let defs_mut = param_defs_mut(doc);
        for (name, v) in &values {
            if let Some(d) = defs_mut.get_mut(name).and_then(Value::as_object_mut) {
                d.insert("value".into(), json!(v));
            }
        }
    }
    let mut table = Map::new();
    for (k, v) in &cached {
        table.insert(k.clone(), json!(v));
    }
    doc.insert("parameters".into(), Value::Object(table));
    issues
}

// --- validation --------------------------------------------------------------

/// A feature field naming another feature, and what it must name, "" for any type.
const REFERENCE_FIELDS: &[(&str, &[(&str, &str)])] = &[
    ("extrude", &[("sketch", "sketch")]),
    ("revolve", &[("sketch", "sketch")]),
    ("sweep", &[("profile", "sketch"), ("path", "sketch")]),
    ("loft", &[("sketches", "sketch")]),
    ("patternLinear", &[("features", "")]),
    ("patternCircular", &[("features", "")]),
    ("patternRect", &[("features", "")]),
];

/// Fields that hold a string which is never a number: an id, a mode, a hash.
const NOT_NUMERIC: &[&str] = &[
    "id", "type", "name", "operation", "sketch", "profile", "path", "body", "target", "keep",
    "axis", "text", "planeId", "plane", "format", "geom", "source", "moving", "mode", "color",
    "continuity", "sizeType", "chamferType", "datum", "brep", "plugin", "stamp", "holeType",
    "standard", "size", "fit", "extent", "direction",
];

/// Whether the schema documents `field` of `kind` as something other than a
/// `Num`, as a plugin's text options (`roof: "pointed"`) are. A field the schema
/// does not describe is still checked.
fn documented_not_numeric(kind: &str, field: &str) -> bool {
    crate::schema::features()
        .get(kind)
        .and_then(|t| t.get("fields"))
        .and_then(|f| f.get(field))
        .and_then(Value::as_str)
        .is_some_and(|doc| !doc.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "Num"))
}

/// Everything wrong with the document that can be seen without building it.
///
/// Not a gate: the caller may build a document with problems and see what the
/// kernel says, but every entry here is a rebuild error that would otherwise
/// arrive later with less context.
pub fn validate(doc: &mut Doc) -> Vec<String> {
    let mut problems = Vec::new();
    let feats: Vec<Value> = features(doc).to_vec();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut by_id: BTreeMap<String, usize> = BTreeMap::new();
    for (i, f) in feats.iter().enumerate() {
        let fid = str_field(f, "id").unwrap_or_default();
        if fid.is_empty() {
            problems.push(format!(
                "feature #{i} ({}) has no id",
                json_or_none(f.get("type"))
            ));
            continue;
        }
        if seen.contains(fid) {
            problems.push(format!("duplicate feature id '{fid}'"));
        }
        seen.insert(fid.into());
        by_id.insert(fid.into(), i);
        if str_field(f, "type").unwrap_or_default().is_empty() {
            problems.push(format!("feature '{fid}' has no type"));
        }
    }

    for (i, f) in feats.iter().enumerate() {
        let kind = str_field(f, "type").unwrap_or_default();
        let Some((_, fields)) = REFERENCE_FIELDS.iter().find(|(k, _)| *k == kind) else {
            continue;
        };
        for (field, want) in *fields {
            let Some(val) = f.get(*field).filter(|v| !v.is_null()) else {
                continue;
            };
            let refs: Vec<&Value> = match val.as_array() {
                Some(list) => list.iter().collect(),
                None => vec![val],
            };
            for r in refs {
                let name = match r {
                    Value::Object(o) => o.get("sketch").and_then(Value::as_str),
                    Value::String(s) => Some(s.as_str()),
                    _ => None,
                };
                let Some(name) = name else { continue };
                let fid = str_field(f, "id").unwrap_or_default();
                match by_id.get(name) {
                    None => problems.push(format!(
                        "{fid}: {field} names '{name}', which is not in the document"
                    )),
                    Some(&j) if j > i => problems.push(format!(
                        "{fid}: {field} names '{name}', which comes AFTER it in the timeline \
                         (a feature can only use what is above it)"
                    )),
                    Some(&j) => {
                        let got = str_field(&feats[j], "type").unwrap_or_default();
                        if !want.is_empty() && got != *want {
                            problems.push(format!(
                                "{fid}: {field} names '{name}', which is a {got} and not a {want}"
                            ));
                        }
                    }
                }
            }
        }
    }

    // A circular pattern's axis is X, Y, Z, a line, or the id of a datum axis.
    for (i, f) in feats.iter().enumerate() {
        if str_field(f, "type") != Some("patternCircular") {
            continue;
        }
        let Some(name) = f.get("axis").and_then(Value::as_str).filter(|a| !["X", "Y", "Z"].contains(a)) else {
            continue;
        };
        let fid = str_field(f, "id").unwrap_or_default();
        match by_id.get(name) {
            None => problems.push(format!(
                "{fid}: axis '{name}' is not X, Y, Z, a line {{origin, dir}} or the id of a datumAxis in the document"
            )),
            Some(&j) if j > i => problems.push(format!(
                "{fid}: axis names '{name}', which comes AFTER it in the timeline (a feature can only use what is above it)"
            )),
            Some(&j) => {
                let got = str_field(&feats[j], "type").unwrap_or_default();
                if got != "datumAxis" {
                    problems.push(format!("{fid}: axis names '{name}', which is a {got} and not a datumAxis"));
                }
            }
        }
    }

    for (name, why) in recompute_parameters(doc) {
        problems.push(format!("parameter {name}: {why}"));
    }
    problems.extend(press_pull_label_problems(doc, &feats));

    // A string in a numeric field must name a parameter: the engine resolves
    // names against `parameters` and refuses anything else, which arrives as a
    // red feature with no clue which field caused it.
    let params: BTreeSet<String> = doc
        .get("parameters")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    for f in &feats {
        let fid = str_field(f, "id").unwrap_or_default();
        let Some(obj) = f.as_object() else { continue };
        let kind = str_field(f, "type").unwrap_or_default();
        for (k, v) in obj {
            let Some(text) = v.as_str() else { continue };
            // `geom` and `source` are an import's, and neither is ever a
            // number: one is a content hash into the blob store and the other
            // is the file it was read from. Without them here, every imported
            // body reports two problems that say a build WILL fail, on a
            // document that builds.
            if NOT_NUMERIC.contains(&k.as_str())
                || params.contains(text)
                || documented_not_numeric(kind, k)
            {
                continue;
            }
            // An EXPRESSION in a feature field is the mistake worth naming
            // separately, because it looks like it ought to work. The app
            // evaluates expressions in the parameter table and writes plain
            // numbers into fields, so the engine only ever resolves a bare NAME.
            let refs: BTreeSet<String> = parse_expr(text)
                .ok()
                .map(|n| refs_of(&n).into_iter().collect())
                .unwrap_or_default();
            if !refs.is_empty() && refs.iter().all(|r| params.contains(r)) {
                problems.push(format!(
                    "{fid}: {k} is the expression '{text}'. A field takes a number or a \
                     parameter NAME, never an expression, define a parameter for it \
                     (param_set) and put its name in {k}."
                ));
            } else {
                let known = if params.is_empty() {
                    "none".to_string()
                } else {
                    format!(
                        "[{}]",
                        params
                            .iter()
                            .map(|p| format!("'{p}'"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                problems.push(format!(
                    "{fid}: {k} is the string '{text}', which is not a parameter, known \
                     parameters are {known}"
                ));
            }
        }
    }
    problems
}

/// A press-pull's `operation` is only a label for the sign of `distance`, so one
/// that disagrees with the sign reads as a request the build never acts on.
fn press_pull_label_problems(doc: &Doc, feats: &[Value]) -> Vec<String> {
    let params = doc.get("parameters").and_then(Value::as_object);
    let mut problems = Vec::new();
    for f in feats {
        if str_field(f, "type") != Some("press-pull") {
            continue;
        }
        let Some(op) = str_field(f, "operation") else { continue };
        let dist = match f.get("distance") {
            Some(Value::String(name)) => params.and_then(|p| p.get(name)).and_then(Value::as_f64),
            Some(v) => v.as_f64(),
            None => None,
        };
        let Some(d) = dist.filter(|d| *d != 0.0) else { continue };
        let signed = if d > 0.0 { "join" } else { "cut" };
        if op != signed {
            let fid = str_field(f, "id").unwrap_or_default();
            problems.push(format!(
                "{fid}: operation is '{op}' but distance {d} makes this push a {signed}. On a \
                 press-pull `operation` is only a label for the sign of `distance`: flip the \
                 sign, or set `mode` to '{op}' to sweep the face into a prism and combine it that way"
            ));
        }
    }
    problems
}

fn json_or_none(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}
