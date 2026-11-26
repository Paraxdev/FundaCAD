//! What the Items browser writes into the document, and its row selection rules. Each function is one edit, so a
//! caller hands it to `Viewport::edit` whole and gets one undo step.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use super::{body_list, body_visible, features, plane_visible, sketch_visible, str_of, BodyRef, Category, Rename};

fn side(category: Category) -> &'static str {
    match category {
        Category::Bodies => "bodyVisibility",
        Category::Sketches => "sketchVisibility",
        Category::Planes | Category::Datums => "planeVisibility",
    }
}

/// Sets each key of `category` in `changes`. A key `g:<folder>` stands for the body ids `groups` holds for it.
pub fn set_visibility(
    doc: &mut Map<String, Value>,
    category: Category,
    changes: &[(String, bool)],
    groups: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut flat: Vec<(&str, bool)> = Vec::new();
    for (key, visible) in changes {
        match groups.get(key) {
            Some(ids) => flat.extend(ids.iter().map(|id| (id.as_str(), *visible))),
            None if key.starts_with("g:") => {}
            None => flat.push((key, *visible)),
        }
    }
    let now = |id: &str| match category {
        Category::Bodies => body_visible(doc, id),
        Category::Sketches => sketch_visible(doc, id),
        Category::Planes | Category::Datums => plane_visible(doc, id),
    };
    // As FC1, a row already in the asked state is left alone, so a no-op is no undo step.
    flat.retain(|&(id, visible)| now(id) != visible);
    if flat.is_empty() {
        return Ok(());
    }
    let map = doc.entry(side(category)).or_insert_with(|| Value::Object(Map::new()));
    let map = map.as_object_mut().ok_or("the visibility table is not a map")?;
    for (id, visible) in flat {
        map.insert(id.to_string(), Value::Bool(visible));
    }
    Ok(())
}

/// Every key of a category with its state, drawn or not: a body inside a collapsed folder is still one of the bodies
/// "show only this" hides.
pub fn vis_rows(doc: &Map<String, Value>, built: &[BodyRef], category: Category) -> BTreeMap<String, bool> {
    let ids = |types: &[&str]| -> Vec<String> {
        features(doc)
            .filter(|f| str_of(f, "type").is_some_and(|t| types.contains(&t)))
            .filter_map(|f| str_of(f, "id").map(str::to_string))
            .collect()
    };
    match category {
        Category::Bodies => body_list(doc, built).into_iter().map(|b| (b.id.clone(), body_visible(doc, &b.id))).collect(),
        Category::Sketches => ids(&["sketch"]).into_iter().map(|id| (id.clone(), sketch_visible(doc, &id))).collect(),
        Category::Planes => ids(&["datumPlane"]).into_iter().map(|id| (id.clone(), plane_visible(doc, &id))).collect(),
        Category::Datums => {
            ids(&["datumPoint", "datumAxis"]).into_iter().map(|id| (id.clone(), plane_visible(doc, &id))).collect()
        }
    }
}

/// Hides every row of the category but `keys`.
pub fn show_only(rows: &BTreeMap<String, bool>, keys: &[String]) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = rows.keys().filter(|k| !keys.contains(k)).map(|k| (k.clone(), false)).collect();
    out.extend(keys.iter().map(|k| (k.clone(), true)));
    out
}

pub fn all(keys: impl IntoIterator<Item = String>, visible: bool) -> Vec<(String, bool)> {
    keys.into_iter().map(|k| (k, visible)).collect()
}

pub fn invert(rows: &BTreeMap<String, bool>) -> Vec<(String, bool)> {
    rows.iter().map(|(k, v)| (k.clone(), !v)).collect()
}

/// Alt-click solo: shows only one row, and a second Alt-click on the same row puts every row back as it was. Any other
/// change in the category forgets it.
#[derive(Clone, Debug, Default)]
pub struct Solo(Option<(Category, String, BTreeMap<String, bool>)>);

impl Solo {
    /// The changes an Alt-click on `key` makes, `rows` being every row of the category as it is now.
    pub fn toggle(&mut self, category: Category, key: &str, rows: &BTreeMap<String, bool>) -> Vec<(String, bool)> {
        if let Some((c, k, before)) = self.0.take() {
            if c == category && k == key {
                return before.into_iter().collect();
            }
        }
        self.0 = Some((category, key.to_string(), rows.clone()));
        show_only(rows, &[key.to_string()])
    }

    pub fn forget(&mut self, category: Category) {
        if self.0.as_ref().is_some_and(|(c, _, _)| *c == category) {
            self.0 = None;
        }
    }
}

/// Bodies write `bodyNames` (blank clears it), features their `name` (blank clears it), elements their name (blank
/// is ignored, a folder with no name is a row nobody can aim at again).
pub fn rename(doc: &mut Map<String, Value>, target: &Rename, name: &str) -> Result<(), String> {
    let name = name.trim();
    match target {
        Rename::Body(id) => {
            let names = doc.entry("bodyNames").or_insert_with(|| Value::Object(Map::new()));
            let names = names.as_object_mut().ok_or("bodyNames is not a map")?;
            if name.is_empty() {
                names.remove(id);
            } else {
                names.insert(id.clone(), Value::String(name.into()));
            }
            if names.is_empty() {
                doc.remove("bodyNames");
            }
        }
        Rename::Feature(id) => {
            let list = doc.get_mut("features").and_then(Value::as_array_mut).ok_or("the document has no features")?;
            let f = list.iter_mut().find(|f| str_of(f, "id") == Some(id)).ok_or("the feature is gone")?;
            let f = f.as_object_mut().ok_or("the feature is not a map")?;
            if name.is_empty() {
                f.remove("name");
            } else {
                f.insert("name".into(), Value::String(name.into()));
            }
        }
        Rename::Element(id) => {
            if name.is_empty() {
                return Ok(());
            }
            let list = doc.get_mut("elements").and_then(Value::as_array_mut).ok_or("the document has no elements")?;
            let e = list.iter_mut().find(|e| str_of(e, "id") == Some(id)).ok_or("the element is gone")?;
            e.as_object_mut().ok_or("the element is not a map")?.insert("name".into(), Value::String(name.into()));
        }
    }
    Ok(())
}

/// Ctrl (or Cmd) toggles one row, Shift takes the run from the anchor.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mods {
    pub toggle: bool,
    pub range: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Selection {
    pub keys: Vec<String>,
    pub anchor: Option<String>,
}

impl Selection {
    pub fn has(&self, key: &str) -> bool {
        self.keys.iter().any(|k| k == key)
    }
}

/// File manager rules over `order`, the rows as drawn now, so a run never reaches into a collapsed folder. A Shift
/// click never moves the anchor, so a run can grow or shrink.
pub fn select_row(sel: &Selection, order: &[String], key: &str, mods: Mods) -> Selection {
    let one = || Selection { keys: vec![key.to_string()], anchor: Some(key.to_string()) };
    if mods.range {
        let from = sel.anchor.as_ref().and_then(|a| order.iter().position(|k| k == a));
        let to = order.iter().position(|k| k == key);
        let (Some(from), Some(to)) = (from, to) else { return one() };
        let run = &order[from.min(to)..=from.max(to)];
        if !mods.toggle {
            return Selection { keys: run.to_vec(), anchor: sel.anchor.clone() };
        }
        let mut keys = sel.keys.clone();
        keys.extend(run.iter().filter(|k| !sel.keys.contains(k)).cloned());
        return Selection { keys, anchor: sel.anchor.clone() };
    }
    if mods.toggle {
        let keys = if sel.has(key) {
            sel.keys.iter().filter(|k| *k != key).cloned().collect()
        } else {
            sel.keys.iter().cloned().chain([key.to_string()]).collect()
        };
        return Selection { keys, anchor: Some(key.to_string()) };
    }
    one()
}

/// A plain click on a folder takes exactly its members, Ctrl or Shift adds them, or takes them out when all were in.
pub fn select_group(selected: &[String], members: &[String], mods: Mods) -> Vec<String> {
    if !mods.toggle && !mods.range {
        return members.to_vec();
    }
    if !members.is_empty() && members.iter().all(|m| selected.contains(m)) {
        return selected.iter().filter(|k| !members.contains(k)).cloned().collect();
    }
    let mut out = selected.to_vec();
    out.extend(members.iter().filter(|m| !selected.contains(m)).cloned());
    out
}

/// The whole selection when the grabbed row is in it, else just that row.
pub fn act_on(selected: &[String], key: &str) -> Vec<String> {
    if selected.iter().any(|k| k == key) {
        selected.to_vec()
    } else {
        vec![key.to_string()]
    }
}

#[cfg(test)]
mod tests;
