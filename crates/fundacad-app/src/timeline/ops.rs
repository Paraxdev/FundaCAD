//! The edits a History row makes. Each checks before it writes, since a refused edit must leave the document whole.

use serde_json::{Map, Value};

use super::{deps, id_of, ids};

/// Where the notes people write on steps live, beside the features so the worker never rebuilds for one.
pub const NOTES: &str = "featureNotes";

fn feature_mut<'a>(doc: &'a mut Map<String, Value>, id: &str) -> Result<&'a mut Map<String, Value>, String> {
    doc.get_mut("features")
        .and_then(Value::as_array_mut)
        .and_then(|fs| fs.iter_mut().filter_map(Value::as_object_mut).find(|f| id_of(f) == id))
        .ok_or_else(|| format!("the document has no step {id}"))
}

/// A blank name goes back to the type's.
pub fn rename(doc: &mut Map<String, Value>, id: &str, name: &str) -> Result<(), String> {
    let f = feature_mut(doc, id)?;
    match name.trim() {
        "" => {
            f.remove("name");
        }
        name => {
            f.insert("name".into(), name.into());
        }
    }
    Ok(())
}

fn listed(doc: &Map<String, Value>, key: &str) -> Vec<String> {
    doc.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

fn put_list(doc: &mut Map<String, Value>, key: &str, list: Vec<String>) {
    if list.is_empty() {
        doc.remove(key);
    } else {
        doc.insert(key.into(), list.into_iter().map(Value::from).collect());
    }
}

/// Deletes the steps as one change. The rollback marker stays on the step it was on, and their suppression and notes
/// go with them. Parameters stay, as in FundaCAD 1: other steps may type them into a field, and a target whose step
/// is gone is never written.
pub fn delete(doc: &mut Map<String, Value>, gone: &[String]) -> Result<(), String> {
    let order = ids(doc);
    if !gone.iter().any(|g| order.contains(g)) {
        return Err("none of those steps is in the document".into());
    }
    let before_marker = doc
        .get("rollback")
        .and_then(Value::as_u64)
        .map(|r| order.iter().take(r as usize).filter(|id| gone.contains(id)).count());
    if let Some(fs) = doc.get_mut("features").and_then(Value::as_array_mut) {
        fs.retain(|f| f.as_object().is_none_or(|f| !gone.iter().any(|g| g == id_of(f))));
    }
    if let (Some(r), Some(n)) = (doc.get("rollback").and_then(Value::as_u64), before_marker) {
        set_rollback(doc, r as usize - n);
    }
    let suppressed = listed(doc, "suppressed").into_iter().filter(|id| !gone.contains(id)).collect();
    put_list(doc, "suppressed", suppressed);
    if let Some(notes) = doc.get_mut(NOTES).and_then(Value::as_object_mut) {
        notes.retain(|id, _| !gone.contains(id));
        if notes.is_empty() {
            doc.remove(NOTES);
        }
    }
    Ok(())
}

/// Suppresses or unsuppresses the steps; ids the document does not hold are never written, a later step given that
/// id would be born suppressed.
pub fn set_suppressed(doc: &mut Map<String, Value>, which: &[String], on: bool) -> Result<(), String> {
    let order = ids(doc);
    let which: Vec<&String> = which.iter().filter(|id| order.contains(id)).collect();
    if which.is_empty() {
        return Err("none of those steps is in the document".into());
    }
    let mut list = listed(doc, "suppressed");
    if on {
        list.extend(which.into_iter().filter(|id| !list.contains(id)).cloned().collect::<Vec<_>>());
    } else {
        list.retain(|id| !which.contains(&id));
    }
    put_list(doc, "suppressed", list);
    Ok(())
}

/// Builds the first `at` steps, all of them when `at` reaches the end.
pub fn set_rollback(doc: &mut Map<String, Value>, at: usize) {
    if at >= ids(doc).len() {
        doc.remove("rollback");
    } else {
        doc.insert("rollback".into(), at.into());
    }
}

/// Moves a step to index `to`, refused where it would leave what it uses behind it.
pub fn move_to(doc: &mut Map<String, Value>, id: &str, to: usize) -> Result<(), String> {
    deps::can_move(doc, id, to)?;
    let fs = doc.get_mut("features").and_then(Value::as_array_mut).expect("can_move found the step");
    let from = fs.iter().position(|f| f.as_object().is_some_and(|f| id_of(f) == id)).expect("can_move found it");
    let f = fs.remove(from);
    let to = to.min(fs.len());
    fs.insert(to, f);
    Ok(())
}

/// A blank note removes it.
pub fn set_note(doc: &mut Map<String, Value>, id: &str, text: &str) -> Result<(), String> {
    feature_mut(doc, id)?;
    let text = text.trim();
    let notes = doc.entry(NOTES).or_insert_with(|| Value::Object(Map::new()));
    let Some(notes) = notes.as_object_mut() else { return Err(format!("{NOTES} is not a table")) };
    if text.is_empty() {
        notes.remove(id);
    } else {
        notes.insert(id.into(), text.into());
    }
    if notes.is_empty() {
        doc.remove(NOTES);
    }
    Ok(())
}

pub fn note(doc: &Map<String, Value>, id: &str) -> Option<String> {
    doc.get(NOTES).and_then(|n| n.get(id)).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests;
