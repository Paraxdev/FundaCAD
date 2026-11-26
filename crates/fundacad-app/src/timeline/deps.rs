use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::labels::name_of;
use super::{features, id_of, ids};

/// The features each feature uses, by index, each list in document order. Read generically, so a new feature type is
/// covered: any string in it that is another feature's id, or a body id whose maker is that feature. A string that
/// names a parameter is a value, not a reference.
pub fn uses(doc: &Map<String, Value>) -> Vec<Vec<String>> {
    let all = features(doc);
    let order: Vec<&str> = all.iter().map(|f| id_of(f)).collect();
    let known: HashSet<&str> = order.iter().copied().filter(|id| !id.is_empty()).collect();
    let makers = body_makers(doc, &order);
    let params: HashSet<&str> = ["parameters", "paramDefs"]
        .iter()
        .filter_map(|k| doc.get(*k).and_then(Value::as_object))
        .flat_map(|m| m.keys().map(String::as_str))
        .collect();
    all.iter()
        .map(|f| {
            let me = id_of(f);
            let mut used = HashSet::new();
            for v in f.iter().filter(|(k, _)| !matches!(k.as_str(), "id" | "name" | "type")).map(|(_, v)| v) {
                walk(v, &mut |s| {
                    if params.contains(s) {
                        return;
                    }
                    if known.contains(s) {
                        used.insert(s.to_owned());
                    } else if let Some(m) = makers.get(s) {
                        used.insert((*m).to_owned());
                    }
                });
            }
            used.remove(me);
            order.iter().filter(|id| used.contains(**id)).map(|id| (*id).to_owned()).collect()
        })
        .collect()
}

fn walk<'a>(v: &'a Value, f: &mut impl FnMut(&'a str)) {
    match v {
        Value::String(s) => f(s),
        Value::Array(a) => a.iter().for_each(|v| walk(v, f)),
        Value::Object(m) => m.values().for_each(|v| walk(v, f)),
        _ => {}
    }
}

/// Body id to the feature that made it: the first in document order of the features `bodyIds` names for it.
fn body_makers<'a>(doc: &'a Map<String, Value>, order: &[&'a str]) -> HashMap<&'a str, &'a str> {
    let mut makers: HashMap<&str, (usize, &str)> = HashMap::new();
    for (key, body) in doc.get("bodyIds").and_then(Value::as_object).into_iter().flatten() {
        let (Some(body), Some(feature)) = (body.as_str(), key.rsplit_once(':').map(|(f, _)| f)) else { continue };
        let Some(at) = order.iter().position(|id| *id == feature) else { continue };
        let slot = makers.entry(body).or_insert((at, order[at]));
        if at < slot.0 {
            *slot = (at, order[at]);
        }
    }
    makers.into_iter().map(|(b, (_, f))| (b, f)).collect()
}

/// The features that use each feature, by index, each list in document order.
pub fn users(doc: &Map<String, Value>) -> Vec<Vec<String>> {
    let order = ids(doc);
    let uses = uses(doc);
    order
        .iter()
        .map(|id| order.iter().zip(&uses).filter(|(_, u)| u.contains(id)).map(|(g, _)| g.clone()).collect())
        .collect()
}

/// The picked features, what they use and what uses them, in document order.
pub fn related(doc: &Map<String, Value>, seeds: &[String]) -> Vec<String> {
    let order = ids(doc);
    let (uses, users) = (uses(doc), users(doc));
    let mut out: HashSet<&str> = HashSet::new();
    for (i, id) in order.iter().enumerate().filter(|(_, id)| seeds.contains(id)) {
        out.insert(id);
        out.extend(uses[i].iter().map(String::as_str));
        out.extend(users[i].iter().map(String::as_str));
    }
    order.iter().filter(|id| out.contains(id.as_str())).cloned().collect()
}

/// Whether `id` may move to index `to`. A feature stays after what it uses and before what uses it; an order the
/// document already breaks does not hold a move back.
pub fn can_move(doc: &Map<String, Value>, id: &str, to: usize) -> Result<(), String> {
    let order = ids(doc);
    let from = order.iter().position(|f| f == id).ok_or_else(|| format!("the document has no step {id}"))?;
    let mut next = order.clone();
    let moved = next.remove(from);
    next.insert(to.min(next.len()), moved);
    let at = |list: &[String], f: &str| list.iter().position(|g| g == f).unwrap_or(usize::MAX);
    let (uses, users) = (uses(doc), users(doc));
    for other in &uses[from] {
        if at(&order, other) < from && at(&next, other) > at(&next, id) {
            return Err(format!("{} uses {}, so it stays after it", name_of(doc, id), name_of(doc, other)));
        }
    }
    for other in &users[from] {
        if at(&order, other) > from && at(&next, other) < at(&next, id) {
            return Err(format!("{} uses {}, so it stays before it", name_of(doc, other), name_of(doc, id)));
        }
    }
    Ok(())
}

/// The features left after deleting `gone` that use one of them, in document order.
pub fn dependents(doc: &Map<String, Value>, gone: &[String]) -> Vec<String> {
    let order = ids(doc);
    let uses = uses(doc);
    order
        .iter()
        .zip(&uses)
        .filter(|(id, u)| !gone.contains(id) && u.iter().any(|g| gone.contains(g)))
        .map(|(id, _)| id.clone())
        .collect()
}

#[cfg(test)]
mod tests;
