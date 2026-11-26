//! The history as a list of steps to act on: which step uses which, the edits a History row makes, the words an
//! undo step goes by, and the row selection. Plain document logic, the shell draws it.

pub mod chips;
pub mod deps;
pub mod labels;
pub mod ops;
pub mod rows;

use serde_json::{Map, Value};

pub type Feature = Map<String, Value>;

/// The document's features in order, the ones that are objects, as History lists them.
pub fn features(doc: &Map<String, Value>) -> Vec<&Feature> {
    doc.get("features").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).collect()
}

pub fn id_of(f: &Feature) -> &str {
    f.get("id").and_then(Value::as_str).unwrap_or("")
}

/// The id of each History row, in order.
pub fn ids(doc: &Map<String, Value>) -> Vec<String> {
    features(doc).into_iter().map(|f| id_of(f).to_owned()).collect()
}

/// The ids in `doc` named in `wanted`, in document order, each once.
pub fn in_order(doc: &Map<String, Value>, wanted: &[String]) -> Vec<String> {
    ids(doc).into_iter().filter(|id| wanted.contains(id)).collect()
}

#[cfg(test)]
pub(crate) mod fixture;
