//! `edit`: several timeline and parameter edits as one call.
//!
//! Each entry is one of the single-edit tools with its own arguments, so there
//! is nothing new to learn, and the whole list is applied to a copy of the
//! document first: one refusal leaves the real document as it was, rather than
//! half an edit an agent then has to find and undo.

use serde_json::{Map, Value};

use crate::model::{self, Doc};

/// The arguments each op takes, beside `op` itself. Anything else is refused
/// by name, the way `unknown_arguments` refuses it on the single tools.
fn takes(op: &str) -> Option<&'static [&'static str]> {
    Some(match op {
        "add" => &["feature", "at"],
        "update" => &["id", "patch", "replace"],
        "remove" => &["id"],
        "move" => &["id", "to"],
        "param" => &["name", "expr", "unit", "comment"],
        "param_remove" => &["name"],
        _ => return None,
    })
}

/// The tool names are accepted too, since they are what an agent has seen.
fn canonical(op: &str) -> &str {
    match op {
        "feature_add" => "add",
        "feature_update" => "update",
        "feature_remove" => "remove",
        "feature_move" => "move",
        "param_set" => "param",
        other => other,
    }
}

fn need<'a>(entry: &'a Map<String, Value>, key: &str) -> Result<&'a Value, String> {
    entry
        .get(key)
        .filter(|v| !v.is_null())
        .ok_or_else(|| format!("needs `{key}`"))
}

fn need_str(entry: &Map<String, Value>, key: &str) -> Result<String, String> {
    Ok(match need(entry, key)? {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    })
}

fn kind_of(f: &Value) -> &str {
    f.get("type").and_then(Value::as_str).unwrap_or("None")
}

/// What one applied edit did, short enough to list fifty of.
pub enum Done {
    Added(String, String),
    Updated(String, Vec<String>),
    Replaced(String),
    Removed(String, String),
    Moved(String, i64),
    Param(String, String),
    ParamRemoved(String),
}

/// Apply one entry of `ops` to `doc`, or say why not. A sketch shortcut it
/// expanded adds a note to `notes`.
pub fn apply(doc: &mut Doc, entry: &Value, notes: &mut Vec<String>) -> Result<Done, String> {
    let Some(entry) = entry.as_object() else {
        return Err("each edit is an object with an `op`".into());
    };
    let Some(op) = entry.get("op").and_then(Value::as_str) else {
        return Err("each edit needs an `op`: add, update, remove, move, param or param_remove".into());
    };
    let op = canonical(op);
    let Some(allowed) = takes(op) else {
        return Err(format!(
            "no op '{op}', have add, update, remove, move, param and param_remove"
        ));
    };
    let mut unknown: Vec<&String> = entry
        .keys()
        .filter(|k| k.as_str() != "op" && !allowed.contains(&k.as_str()))
        .collect();
    if !unknown.is_empty() {
        unknown.sort();
        return Err(format!(
            "{op} takes no {}, it takes {}",
            unknown.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", "),
            allowed.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ")
        ));
    }
    let doc_err = |e: model::DocumentError| e.to_string();
    match op {
        "add" => {
            let feature = need(entry, "feature")?;
            let at = entry.get("at").and_then(Value::as_i64);
            let (fid, said) = model::add_feature_noted(doc, feature, at).map_err(doc_err)?;
            notes.extend(said.into_iter().map(|n| format!("in {fid}, {n}")));
            Ok(Done::Added(fid, kind_of(feature).to_string()))
        }
        "update" => {
            let id = need_str(entry, "id")?;
            let patch = need(entry, "patch")?;
            let replace = entry.get("replace").and_then(Value::as_bool).unwrap_or(false);
            let (_, said) = model::update_feature_noted(doc, &id, patch, replace).map_err(doc_err)?;
            notes.extend(said.into_iter().map(|n| format!("in {id}, {n}")));
            if replace {
                return Ok(Done::Replaced(id));
            }
            let keys = patch.as_object().map(|p| p.keys().cloned().collect()).unwrap_or_default();
            Ok(Done::Updated(id, keys))
        }
        "remove" => {
            let id = need_str(entry, "id")?;
            let f = model::remove_feature(doc, &id).map_err(doc_err)?;
            Ok(Done::Removed(id, kind_of(&f).to_string()))
        }
        "move" => {
            let id = need_str(entry, "id")?;
            let to = need(entry, "to")?.as_i64().ok_or("`to` is a timeline position")?;
            model::move_feature(doc, &id, to).map_err(doc_err)?;
            Ok(Done::Moved(id, to))
        }
        "param" => {
            let name = need_str(entry, "name")?;
            let expr = need(entry, "expr")?;
            // A redefinition keeps the unit it had unless it says otherwise:
            // re-stating an angle's value must not quietly make it mm.
            let unit = entry
                .get("unit")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    model::param_defs(doc)
                        .get(&name)
                        .and_then(|d| d.get("unit"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "mm".into());
            let comment = entry.get("comment").and_then(Value::as_str);
            let d = model::set_parameter(doc, &name, expr, &unit, comment).map_err(doc_err)?;
            let value = crate::describe::g_format(d.get("value").and_then(Value::as_f64).unwrap_or(0.0));
            Ok(Done::Param(name, format!("{value} {unit}")))
        }
        "param_remove" => {
            let name = need_str(entry, "name")?;
            model::remove_parameter(doc, &name).map_err(doc_err)?;
            Ok(Done::ParamRemoved(name))
        }
        _ => unreachable!("takes() knows every op"),
    }
}

/// One line for the lot: what was added, updated, removed and moved, grouped
/// so fifty adds read as one list of ids.
pub fn summary(done: &[Done]) -> String {
    let mut added = Vec::new();
    let mut updated = Vec::new();
    let mut removed = Vec::new();
    let mut moved = Vec::new();
    let mut params = Vec::new();
    for d in done {
        match d {
            Done::Added(id, kind) => added.push(format!("{id} ({kind})")),
            Done::Updated(id, keys) => updated.push(if keys.is_empty() {
                id.clone()
            } else {
                format!("{id} ({})", keys.join(", "))
            }),
            Done::Replaced(id) => updated.push(format!("{id} (replaced)")),
            Done::Removed(id, kind) => removed.push(format!("{id} ({kind})")),
            Done::Moved(id, to) => moved.push(format!("{id} to {to}")),
            Done::Param(name, value) => params.push(format!("{name} = {value}")),
            Done::ParamRemoved(name) => params.push(format!("{name} removed")),
        }
    }
    let mut parts = Vec::new();
    for (label, list) in [
        ("added", added),
        ("updated", updated),
        ("removed", removed),
        ("moved", moved),
        ("parameters", params),
    ] {
        if !list.is_empty() {
            parts.push(format!("{label} {}", list.join(", ")));
        }
    }
    format!(
        "Applied {} edit{}: {}.",
        done.len(),
        if done.len() == 1 { "" } else { "s" },
        parts.join("; ")
    )
}

/// The error for a refused entry, numbered from 1 the way a person counts.
pub fn refused(n: usize, of: usize, entry: &Value, why: &str) -> String {
    let what = entry
        .get("op")
        .and_then(Value::as_str)
        .map(|op| {
            let subject = entry
                .get("id")
                .or_else(|| entry.get("name"))
                .or_else(|| entry.get("feature").and_then(|f| f.get("type")))
                .and_then(Value::as_str);
            match subject {
                Some(s) => format!(" ({op} {s})"),
                None => format!(" ({op})"),
            }
        })
        .unwrap_or_default();
    format!(
        "Edit {n} of {of}{what} refused, so none of the {of} was applied: {why}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_ops_and_arguments_are_named() {
        let mut doc = model::new_document();
        let e = apply(&mut doc, &json!({"op": "nope"}), &mut Vec::new()).err().unwrap();
        assert!(e.contains("no op 'nope'"), "{e}");
        let e = apply(&mut doc, &json!({"op": "remove", "id": "x", "at": 1}), &mut Vec::new()).err().unwrap();
        assert!(e.contains("'at'"), "{e}");
    }
}
