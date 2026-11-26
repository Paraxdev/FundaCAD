//! The document the client edits, and the delta that tells the worker what changed since the copy it holds.

use fundacad_core::params::{resolve, targets::write_targets};
use fundacad_core::schema::ParamDef;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

/// The keys a delta rebuild replaces whole, beside the feature list.
const SIDE_KEYS: [&str; 3] = ["parameters", "bodyVisibility", "bodyIds"];

/// What the worker holds after a rebuild request: the parts of the document a delta patches.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    pub revision: u64,
    features: Vec<Value>,
    side: [Option<Value>; 3],
}

impl Held {
    pub fn of(doc: &Map<String, Value>, revision: u64) -> Held {
        let features = doc.get("features").and_then(Value::as_array).cloned().unwrap_or_default();
        Held { revision, features, side: SIDE_KEYS.map(|k| doc.get(k).cloned()) }
    }

    /// The `ops` of a delta from this copy to `doc`, None when a key the delta cannot clear was removed.
    pub fn delta_to(&self, doc: &Map<String, Value>) -> Option<Value> {
        let features = doc.get("features").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let set: Vec<Value> = features
            .iter()
            .enumerate()
            .filter(|(i, f)| self.features.get(*i) != Some(*f))
            .map(|(i, f)| json!([i, f]))
            .collect();
        let mut ops = Map::new();
        ops.insert("length".into(), features.len().into());
        if !set.is_empty() {
            ops.insert("set".into(), Value::Array(set));
        }
        for (k, held) in SIDE_KEYS.iter().zip(&self.side) {
            match (doc.get(*k), held) {
                (Some(now), Some(was)) if now == was => {}
                (Some(now), _) => {
                    ops.insert((*k).into(), now.clone());
                }
                (None, Some(_)) => return None,
                (None, None) => {}
            }
        }
        Some(Value::Object(ops))
    }
}

/// A number as the parameter table writes it, an integral value without a fraction.
fn number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// Sets `name` to `value`, then evaluates the table and writes every derived value and bound feature field, as the
/// app's `recompute` does. A document from before the table had only `parameters`, which is set directly.
pub fn set_param(doc: &mut Map<String, Value>, name: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() {
        return Err(format!("{name}: {value} is not a finite number"));
    }
    let has_def = doc.get("paramDefs").and_then(Value::as_object).is_some_and(|d| d.contains_key(name));
    if !has_def {
        let params = doc.get_mut("parameters").and_then(Value::as_object_mut);
        let Some(slot) = params.and_then(|p| p.get_mut(name)) else {
            return Err(format!("the document has no parameter named {name}"));
        };
        *slot = number(value);
        return Ok(());
    }
    let defs_value = doc.get_mut("paramDefs").and_then(Value::as_object_mut).expect("checked above");
    if let Some(d) = defs_value.get_mut(name).and_then(Value::as_object_mut) {
        d.insert("expr".into(), Value::String(format!("{value}")));
        d.insert("value".into(), number(value));
    }
    let defs: IndexMap<String, ParamDef> = serde_json::from_value(Value::Object(defs_value.clone()))
        .map_err(|e| format!("the parameter table does not read: {e}"))?;
    let r = resolve(&defs);
    for (n, d) in defs_value.iter_mut() {
        if let (Some(v), Some(d)) = (r.values.get(n), d.as_object_mut()) {
            if d.get("value").and_then(Value::as_f64) != Some(*v) {
                d.insert("value".into(), number(*v));
            }
        }
    }
    let table: Map<String, Value> =
        defs_value.iter().map(|(n, d)| (n.clone(), d.get("value").cloned().unwrap_or(Value::from(0)))).collect();
    doc.insert("parameters".into(), Value::Object(table));
    write_targets(doc);
    match r.issues.get(name) {
        Some(why) => Err(format!("{name}: {why}")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Map<String, Value> {
        let v = json!({
            "version": 9,
            "paramDefs": {
                "w": {"expr": "10", "value": 10, "unit": "mm"},
                "h": {"expr": "w * 2", "value": 20, "unit": "mm"},
            },
            "parameters": {"w": 10, "h": 20},
            "features": [{"id": "a", "type": "box", "x": "w"}, {"id": "b", "type": "move"}],
        });
        v.as_object().unwrap().clone()
    }

    #[test]
    fn set_param_recomputes_dependents() {
        let mut d = doc();
        set_param(&mut d, "w", 12.5).unwrap();
        assert_eq!(d["parameters"], json!({"w": 12.5, "h": 25}));
        assert_eq!(d["paramDefs"]["w"]["expr"], json!("12.5"));
        assert_eq!(d["paramDefs"]["h"]["value"], json!(25));
    }

    #[test]
    fn set_param_refuses_an_unknown_name() {
        assert!(set_param(&mut doc(), "nope", 1.0).is_err());
    }

    #[test]
    fn delta_carries_only_what_changed() {
        let d = doc();
        let held = Held::of(&d, 1);
        let mut e = d.clone();
        set_param(&mut e, "w", 11.0).unwrap();
        let ops = held.delta_to(&e).unwrap();
        assert_eq!(ops, json!({"length": 2, "parameters": {"w": 11, "h": 22}}));

        e["features"].as_array_mut().unwrap()[1] = json!({"id": "b", "type": "move", "dx": 1});
        let ops = held.delta_to(&e).unwrap();
        assert_eq!(ops["set"], json!([[1, {"id": "b", "type": "move", "dx": 1}]]));
    }

    #[test]
    fn removed_side_key_needs_a_full_send() {
        let d = doc();
        let held = Held::of(&d, 1);
        let mut e = d.clone();
        e.remove("parameters");
        assert!(held.delta_to(&e).is_none());
    }
}
