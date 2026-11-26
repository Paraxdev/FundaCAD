use serde_json::{Map, Value};

use super::{features, id_of, Feature};

/// A step's own name, else its type name and its place among the steps of that type, as "Fillet 2".
pub fn numbered(f: &Feature, all: &[&Feature]) -> String {
    if let Some(own) = own_name(f) {
        return own.to_owned();
    }
    let kind = type_label(f);
    let at = all.iter().position(|g| std::ptr::eq(*g, f) || (!id_of(f).is_empty() && id_of(g) == id_of(f)));
    match at {
        Some(at) => {
            let place = all[..=at].iter().filter(|g| type_label(g) == kind).count();
            format!("{kind} {place}")
        }
        None => kind,
    }
}

pub fn own_name(f: &Feature) -> Option<&str> {
    f.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty())
}

pub fn type_label(f: &Feature) -> String {
    crate::document::meta(f).1
}

/// The numbered name of the feature with `id` in `doc`, the id itself when the document lost it.
pub fn name_of(doc: &Map<String, Value>, id: &str) -> String {
    let all = features(doc);
    all.iter().find(|f| id_of(f) == id).map_or_else(|| id.to_owned(), |f| numbered(f, &all))
}

fn plural(n: usize, verb: &str) -> String {
    format!("{verb} {n} {}", if n == 1 { "step" } else { "steps" })
}

fn listed(doc: &Map<String, Value>, key: &str) -> Vec<String> {
    doc.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

fn moved(was: &[&Feature], now: &[&Feature]) -> String {
    let at = was.iter().zip(now).position(|(a, b)| id_of(a) != id_of(b)).unwrap_or(0);
    let without = |list: &[&Feature], id: &str| -> Vec<String> {
        list.iter().map(|f| id_of(f).to_owned()).filter(|f| f != id).collect()
    };
    for id in [id_of(was[at]), id_of(now[at])] {
        if without(was, id) == without(now, id) {
            let f = was.iter().find(|f| id_of(f) == id).expect("the id came from the list");
            return format!("Move {}", numbered(f, was));
        }
    }
    plural(was.iter().zip(now).filter(|(a, b)| id_of(a) != id_of(b)).count(), "Move")
}

fn without_name(f: &Feature) -> Feature {
    let mut f = f.clone();
    f.remove("name");
    f
}

/// What a step did, read off the document before and after it, as stepLabel in src/document/stepLabels.ts.
pub fn step_label(before: &Map<String, Value>, after: &Map<String, Value>) -> String {
    let was = features(before);
    let now = features(after);
    let removed: Vec<&&Feature> = was.iter().filter(|f| !now.iter().any(|g| id_of(g) == id_of(f))).collect();
    if let [one] = removed[..] {
        return format!("Delete {}", numbered(one, &was));
    }
    if !removed.is_empty() {
        return plural(removed.len(), "Delete");
    }
    let added: Vec<&&Feature> = now.iter().filter(|f| !was.iter().any(|g| id_of(g) == id_of(f))).collect();
    if let [one] = added[..] {
        return numbered(one, &now);
    }
    if !added.is_empty() {
        return plural(added.len(), "Add");
    }
    if was.iter().zip(&now).any(|(a, b)| id_of(a) != id_of(b)) {
        return moved(&was, &now);
    }
    let edited: Vec<usize> = (0..now.len()).filter(|&i| was[i] != now[i]).collect();
    if edited.len() > 1 {
        return plural(edited.len(), "Edit");
    }
    if let [at] = edited[..] {
        if without_name(was[at]) == without_name(now[at]) {
            return format!("Rename {}", numbered(was[at], &was));
        }
        // Lower case: it only follows Undo, Redo, Undid or Redid.
        return format!("edit of {}", numbered(now[at], &now));
    }
    if let Some(label) = suppress_label(before, after) {
        return label;
    }
    if before.get("rollback") != after.get("rollback") {
        let at = after.get("rollback").and_then(Value::as_u64).map(|r| r as usize);
        return match at.and_then(|k| now.get(k)) {
            Some(f) => format!("Roll back before {}", numbered(f, &now)),
            None => "Roll to the end".into(),
        };
    }
    if before.get(super::ops::NOTES) != after.get(super::ops::NOTES) {
        let notes = |d: &Map<String, Value>| d.get(super::ops::NOTES).and_then(Value::as_object).cloned();
        let (a, b) = (notes(before).unwrap_or_default(), notes(after).unwrap_or_default());
        let changed: Vec<&String> = a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).collect();
        return match changed.first() {
            Some(id) if changed.iter().all(|k| k == id) => format!("Note on {}", name_of(after, id)),
            _ => "Notes".into(),
        };
    }
    param_label(before, after).unwrap_or_else(|| "Edit".into())
}

fn suppress_label(before: &Map<String, Value>, after: &Map<String, Value>) -> Option<String> {
    let (was, now) = (listed(before, "suppressed"), listed(after, "suppressed"));
    let on: Vec<&String> = now.iter().filter(|id| !was.contains(id)).collect();
    let off: Vec<&String> = was.iter().filter(|id| !now.contains(id)).collect();
    let (verb, ids, doc) = match (on.is_empty(), off.is_empty()) {
        (true, true) => return None,
        (false, _) => ("Suppress", on, after),
        (true, false) => ("Unsuppress", off, after),
    };
    Some(match ids[..] {
        [one] => format!("{verb} {}", name_of(doc, one)),
        _ => plural(ids.len(), verb),
    })
}

fn param_label(before: &Map<String, Value>, after: &Map<String, Value>) -> Option<String> {
    let table = |d: &Map<String, Value>| {
        d.get("paramDefs").or_else(|| d.get("parameters")).and_then(Value::as_object).cloned().unwrap_or_default()
    };
    let read = |d: &Map<String, Value>, k: &str| {
        d.get("paramDefs").and_then(|p| p.get(k)).or_else(|| d.get("parameters").and_then(|p| p.get(k))).cloned()
    };
    let (a, b) = (table(before), table(after));
    let mut names: Vec<&String> = a.keys().collect();
    names.extend(b.keys().filter(|k| !a.contains_key(*k)));
    let changed: Vec<&&String> = names.iter().filter(|k| read(before, k) != read(after, k)).collect();
    match changed[..] {
        [] => None,
        [one] => Some(format!("Parameter {one}")),
        _ => Some("Parameters".into()),
    }
}

/// "Undo Fillet 2" for a tooltip, the bare verb when there is no step, a long name clipped as in canStep.ts.
pub fn menu_text(undo: bool, step: Option<&str>) -> String {
    const MAX: usize = 32;
    let verb = if undo { "Undo" } else { "Redo" };
    match step {
        None => verb.into(),
        Some(s) if s.chars().count() > MAX => format!("{verb} {}…", s.chars().take(MAX).collect::<String>().trim_end()),
        Some(s) => format!("{verb} {s}"),
    }
}

/// What the status says after a delete, read off the document before it: the steps gone, and those left that used
/// them, since they will fail or change.
pub fn deleted_line(before: &Map<String, Value>, gone: &[String], users: &[String]) -> String {
    let head = match gone {
        [one] => format!("Deleted {}", name_of(before, one)),
        _ => format!("Deleted {} steps", gone.len()),
    };
    let names: Vec<String> = users.iter().map(|u| name_of(before, u)).collect();
    let it = if gone.len() == 1 { "it" } else { "them" };
    match &names[..] {
        [] => head,
        [one] => format!("{head}, {one} used {it}"),
        [rest @ .., last] => format!("{head}, {} and {last} used {it}", rest.join(", ")),
    }
}

/// The line the status shows after an undo or a redo.
pub fn stepped(undo: bool, label: &str) -> String {
    format!("{} {label}", if undo { "Undid" } else { "Redid" })
}

#[cfg(test)]
mod tests;
