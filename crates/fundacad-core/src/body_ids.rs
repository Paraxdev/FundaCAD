//! Stable body ids, a port of the Python engine's `body_ids.py`.
//!
//! A body's id is remembered against where it came from (the feature that made
//! it, and which of that feature's bodies it was) in the document's `bodyIds`
//! map, so switching off, failing or reordering a feature leaves every other
//! body's id alone. A document without the map is numbered by position.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde_json::Value;

/// `n` for `bodyN`, 0 for anything else.
pub fn number(bid: &str) -> u64 {
    bid.strip_prefix("body")
        .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|d| d.parse().ok())
        .unwrap_or(0)
}

/// One assignment: the key, the id a join asked to inherit, the id given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub key: String,
    pub inherit: Option<String>,
    pub id: String,
}

#[derive(Debug, Clone)]
pub struct BodyIds {
    recorded: Option<IndexMap<String, String>>,
    floor: u64,
    events: Vec<Event>,
    taken: HashSet<String>,
    top: u64,
    feature: String,
    made: usize,
    keys: HashSet<String>,
}

impl BodyIds {
    /// `recorded` is the document's `bodyIds`, `None` for a document without one.
    pub fn new(recorded: Option<IndexMap<String, String>>) -> Self {
        let floor = recorded
            .iter()
            .flat_map(|m| m.values())
            .map(|v| number(v))
            .max()
            .unwrap_or(0);
        BodyIds {
            recorded,
            floor,
            events: Vec::new(),
            taken: HashSet::new(),
            top: 0,
            feature: String::new(),
            made: 0,
            keys: HashSet::new(),
        }
    }

    pub fn start_feature(&mut self, feature_id: &str) {
        feature_id.clone_into(&mut self.feature);
        self.made = 0;
    }

    /// The key of the feature's next body: its assembly node ref when it has
    /// one, else `<featureId>:<n>`, suffixed with `#` when already used.
    pub fn key(&mut self, node_ref: Option<&str>) -> String {
        let mut key = match node_ref {
            Some(r) if !r.is_empty() => r.to_owned(),
            _ => format!("{}:{}", self.feature, self.made),
        };
        if self.keys.contains(&key) {
            key = format!("{}:{}#", self.feature, self.made);
        }
        self.made += 1;
        self.keys.insert(key.clone());
        key
    }

    /// The id for `key`. A join passes the id of the body it merges into as
    /// `inherit` and keeps it, unless the map recorded a different id for it.
    pub fn assign(&mut self, key: &str, inherit: Option<&str>) -> String {
        let inherit = inherit.filter(|i| !i.is_empty());
        let chosen = self
            .recorded
            .as_ref()
            .and_then(|rec| match (inherit, rec.get(key)) {
                (Some(i), None) => Some(i.to_owned()),
                (Some(i), Some(r)) if r == i => Some(i.to_owned()),
                (_, Some(r)) if !r.is_empty() && !self.taken.contains(r) => Some(r.clone()),
                _ => None,
            });
        let id = chosen.unwrap_or_else(|| format!("body{}", self.top.max(self.floor) + 1));
        self.top = self.top.max(number(&id));
        self.taken.insert(id.clone());
        self.keys.insert(key.to_owned());
        self.events.push(Event {
            key: key.to_owned(),
            inherit: inherit.map(str::to_owned),
            id: id.clone(),
        });
        id
    }

    pub fn mark(&self) -> usize {
        self.events.len()
    }

    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// Replays a cached prefix under this document's map. False when the map
    /// would now number that prefix differently, so the cache cannot be used.
    pub fn restore(&mut self, events: &[Event]) -> bool {
        events
            .iter()
            .all(|e| self.assign(&e.key, e.inherit.as_deref()) == e.id)
    }

    pub fn resulting_map(&self) -> IndexMap<String, String> {
        let mut out = self.recorded.clone().unwrap_or_default();
        for e in &self.events {
            out.insert(e.key.clone(), e.id.clone());
        }
        out
    }
}

fn join_targets(f: &Value) -> Option<&Value> {
    (f.get("operation").and_then(Value::as_str) == Some("join"))
        .then(|| f.get("targets").unwrap_or(&Value::Null))
}

/// Whether `key` is one `BodyIds::key` gave a body of `feature_id`.
pub fn is_feature_key(key: &str, feature_id: &str) -> bool {
    key.strip_prefix(feature_id)
        .and_then(|rest| rest.strip_prefix(':'))
        .map(|n| n.trim_end_matches('#'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether an edit from `before` (None for a feature that was not there) to
/// `after` leaves the map's record of `after` stale: it joins now, and did not
/// join the same targets before.
///
/// `assign` prefers a join's own record over the id it inherits, so a file
/// numbered before the map existed keeps the fresh id its join was given. The
/// same rule would keep the id a feature had as a new body after it became a
/// join, and the merged body would not take its target's id, so the record has
/// to go when the edit is made.
pub fn join_went_stale(before: Option<&Value>, after: &Value) -> bool {
    match join_targets(after) {
        Some(now) => before.and_then(join_targets) != Some(now),
        None => false,
    }
}

/// Gives a document handed over whole, rather than opened from a file, an
/// empty `bodyIds` map when it has none, true when it did. Without one it would
/// be numbered like a file saved before the map existed, where a join took a
/// fresh id instead of its target's.
pub fn ensure_map(doc: &mut serde_json::Map<String, Value>) -> bool {
    if doc.get("bodyIds").is_some_and(Value::is_object) {
        return false;
    }
    doc.insert("bodyIds".into(), Value::Object(serde_json::Map::new()));
    true
}

/// Drops every record of `feature_id` from a `bodyIds` map, true when any went.
pub fn forget_feature(map: &mut serde_json::Map<String, Value>, feature_id: &str) -> bool {
    let n = map.len();
    map.retain(|k, _| !is_feature_key(k, feature_id));
    map.len() != n
}
