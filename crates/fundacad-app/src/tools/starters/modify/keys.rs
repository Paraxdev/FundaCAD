//! The keys a running Modify tool answers before the key table, as FundaCAD 1's pattern and draft tools: [ ] - +
//! and the up and down arrows drop or add a copy (a count bound to a parameter is left alone), X turns a draft's pull axis to the next world axis, C moves a circular pattern's axis between
//! the origin and the middle of what it repeats.

#[cfg(test)]
mod tests;

use std::sync::Arc;

use serde_json::{json, Value};

use super::fit::sources_extent;
use crate::tools::Doc;
use crate::viewport::scene::Body;

/// FundaCAD 1's MAX_DRAG_COUNT, a count held key reaches. A higher one is typed in the field.
const MAX_COUNT: i64 = 100;

const AXES: [(&str, [f64; 3]); 3] = [("X", [1.0, 0.0, 0.0]), ("Y", [0.0, 1.0, 0.0]), ("Z", [0.0, 0.0, 1.0])];

/// The feature after `key`, None when the key means nothing to it.
pub fn press(f: &Value, key: &str, shown: &[Arc<Body>]) -> Option<Value> {
    let kind = f.get("type").and_then(Value::as_str)?;
    let mut out = f.clone();
    match (kind, key) {
        ("patternLinear" | "patternCircular" | "patternRect", "[" | "]" | "-" | "+" | "=" | "down" | "up") => {
            let field = if kind == "patternRect" { "countX" } else { "count" };
            let n = match f.get(field) {
                None | Some(Value::Null) => 1,
                Some(v) => v.as_f64()?.round() as i64,
            };
            let more = matches!(key, "]" | "+" | "=" | "up");
            let next = (n + if more { 1 } else { -1 }).clamp(1, MAX_COUNT);
            if next == n {
                return None;
            }
            out[field] = json!(next);
        }
        ("draft", "x") => {
            let at = AXES.iter().position(|(n, _)| f.get("axis").and_then(Value::as_str) == Some(n)).unwrap_or(2);
            out["axis"] = json!(AXES[(at + 1) % 3].0);
        }
        ("patternCircular", "c") => {
            if f.get("axisRef").is_some() {
                return None;
            }
            match f.get("axis") {
                Some(Value::String(name)) => {
                    let (_, dir) = AXES.iter().find(|(n, _)| n == name)?;
                    let (lo, hi) = sources_extent(f, shown)?;
                    let mid: Vec<f64> = (0..3).map(|k| ((lo[k] + hi[k]) as f64 * 50.0).round() / 100.0).collect();
                    out["axis"] = json!({"origin": mid, "dir": dir});
                }
                Some(Value::Object(o)) => {
                    let dir: Vec<f64> = o.get("dir")?.as_array()?.iter().filter_map(Value::as_f64).collect();
                    let (name, _) = AXES.iter().find(|(_, d)| d.as_slice() == dir.as_slice())?;
                    out["axis"] = json!(name);
                }
                _ => return None,
            }
        }
        _ => return None,
    }
    Some(out)
}

/// Puts `f` in place of the feature `id`.
pub fn replace(doc: &mut Doc, id: &str, f: Value) -> Result<(), String> {
    let list = doc.get_mut("features").and_then(Value::as_array_mut).ok_or("the document has no features")?;
    let at = list.iter().position(|x| x.get("id").and_then(Value::as_str) == Some(id));
    *at.and_then(|i| list.get_mut(i)).ok_or_else(|| format!("the document has no feature {id}"))? = f;
    Ok(())
}
