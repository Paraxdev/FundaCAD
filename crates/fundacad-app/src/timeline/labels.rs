use serde_json::{Map, Value};

use super::{features, id_of, Feature};
use crate::i18n::{t, tr};

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
            tr!("feature.numbered", name = kind, n = place)
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
            return tr!("step.label.move", step = numbered(f, was));
        }
    }
    tr!("step.label.moveMany", n = was.iter().zip(now).filter(|(a, b)| id_of(a) != id_of(b)).count())
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
        return tr!("step.label.delete", n = 1, step = numbered(one, &was));
    }
    if !removed.is_empty() {
        return tr!("step.label.delete", n = removed.len(), step = "");
    }
    let added: Vec<&&Feature> = now.iter().filter(|f| !was.iter().any(|g| id_of(g) == id_of(f))).collect();
    if let [one] = added[..] {
        return numbered(one, &now);
    }
    if !added.is_empty() {
        return tr!("step.label.added", n = added.len());
    }
    if was.iter().zip(&now).any(|(a, b)| id_of(a) != id_of(b)) {
        return moved(&was, &now);
    }
    let edited: Vec<usize> = (0..now.len()).filter(|&i| was[i] != now[i]).collect();
    if edited.len() > 1 {
        return tr!("step.label.editMany", n = edited.len());
    }
    if let [at] = edited[..] {
        if without_name(was[at]) == without_name(now[at]) {
            return tr!("step.label.rename", step = numbered(was[at], &was));
        }
        // Lower case: it only follows Undo, Redo, Undid or Redid.
        return tr!("step.label.editOf", step = numbered(now[at], &now));
    }
    if let Some(label) = suppress_label(before, after) {
        return label;
    }
    if before.get("rollback") != after.get("rollback") {
        let at = after.get("rollback").and_then(Value::as_u64).map(|r| r as usize);
        return match at.and_then(|k| now.get(k)) {
            Some(f) => tr!("step.label.rollBefore", step = numbered(f, &now)),
            None => t("step.label.rollEnd"),
        };
    }
    if before.get(super::ops::NOTES) != after.get(super::ops::NOTES) {
        let notes = |d: &Map<String, Value>| d.get(super::ops::NOTES).and_then(Value::as_object).cloned();
        let (a, b) = (notes(before).unwrap_or_default(), notes(after).unwrap_or_default());
        let changed: Vec<&String> = a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).collect();
        return match changed.first() {
            Some(id) if changed.iter().all(|k| k == id) => tr!("step.label.noteOn", step = name_of(after, id)),
            _ => t("step.label.notes"),
        };
    }
    param_label(before, after).unwrap_or_else(|| t("step.label.edit"))
}

fn suppress_label(before: &Map<String, Value>, after: &Map<String, Value>) -> Option<String> {
    let (was, now) = (listed(before, "suppressed"), listed(after, "suppressed"));
    let on: Vec<&String> = now.iter().filter(|id| !was.contains(id)).collect();
    let off: Vec<&String> = was.iter().filter(|id| !now.contains(id)).collect();
    let (state, ids) = match (on.is_empty(), off.is_empty()) {
        (true, true) => return None,
        (false, _) => ("on", on),
        (true, false) => ("off", off),
    };
    let step = match ids[..] {
        [one] => name_of(after, one),
        _ => String::new(),
    };
    Some(tr!("step.label.suppress", state = state, n = ids.len(), step = step))
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
        [one] => Some(tr!("step.label.parameter", name = one.as_str())),
        _ => Some(t("step.label.parameters")),
    }
}

/// "Undo Fillet 2" for a tooltip, the bare verb when there is no step, a long name clipped as in canStep.ts.
pub fn menu_text(undo: bool, step: Option<&str>) -> String {
    const MAX: usize = 32;
    let named = |s: String| tr!(if undo { "step.undoNamed" } else { "step.redoNamed" }, step = s);
    match step {
        None => t(if undo { "step.undo" } else { "step.redo" }),
        Some(s) if s.chars().count() > MAX => named(format!("{}…", s.chars().take(MAX).collect::<String>().trim_end())),
        Some(s) => named(s.to_owned()),
    }
}

/// What the status says after a delete, read off the document before it: the steps gone, and those left that used
/// them, since they will fail or change.
pub fn deleted_line(before: &Map<String, Value>, gone: &[String], users: &[String]) -> String {
    let step = match gone {
        [one] => name_of(before, one),
        _ => String::new(),
    };
    let head = tr!("feature.deleted", n = gone.len(), step = step);
    let names: Vec<String> = users.iter().map(|u| name_of(before, u)).collect();
    let users = match &names[..] {
        [] => return head,
        [one] => one.clone(),
        [rest @ .., last] => tr!("pick.list.last", before = rest.join(", "), last = last.as_str()),
    };
    tr!("feature.deletedUsers", head = head, users = users, n = gone.len())
}

/// The line the status shows after an undo or a redo.
pub fn stepped(undo: bool, label: &str) -> String {
    tr!("history.stepped", way = if undo { "undo" } else { "redo" }, label = label)
}

#[cfg(test)]
mod tests;
