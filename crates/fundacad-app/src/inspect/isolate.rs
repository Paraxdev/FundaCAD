//! Isolate as FundaCAD 1's isolateBodies: one eye step that hides every other body. It stays on while the eyes still
//! show exactly what it kept, so an undo or a hand toggled eye turns it off.

use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

/// Each id once, in the order it was first picked.
pub fn unique(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// How many bodies Isolate shows, while the eyes in `rows` show `keep` and hide the rest. None once they differ, or
/// when none of `keep` is a body any more.
pub fn active(rows: &BTreeMap<String, bool>, keep: &[String]) -> Option<usize> {
    let kept = keep.iter().filter(|k| rows.contains_key(*k)).count();
    (kept > 0 && rows.iter().all(|(id, shown)| *shown == keep.contains(id))).then_some(kept)
}
