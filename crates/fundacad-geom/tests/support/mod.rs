//! JSON compared with a numeric tolerance, for the Python oracles: the sidecar
//! runs OCCT 7.9.3 and this engine 7.8.1.

use serde_json::Value;

/// Every place `got` and `want` differ, as `path: got vs want`. Numbers match
/// within `abs + rel * |want|`; object key order is ignored.
pub fn diff(path: &str, got: &Value, want: &Value, abs: f64, rel: f64, out: &mut Vec<String>) {
    match (got, want) {
        (Value::Number(g), Value::Number(w)) => {
            let (g, w) = (g.as_f64().unwrap_or(f64::NAN), w.as_f64().unwrap_or(f64::NAN));
            if !((g - w).abs() <= abs + rel * w.abs()) {
                out.push(format!("{path}: {g} vs {w}"));
            }
        }
        (Value::Array(g), Value::Array(w)) => {
            if g.len() != w.len() {
                out.push(format!("{path}: length {} vs {}", g.len(), w.len()));
                return;
            }
            for (i, (a, b)) in g.iter().zip(w).enumerate() {
                diff(&format!("{path}[{i}]"), a, b, abs, rel, out);
            }
        }
        (Value::Object(g), Value::Object(w)) => {
            let mut gk: Vec<&String> = g.keys().collect();
            let mut wk: Vec<&String> = w.keys().collect();
            gk.sort();
            wk.sort();
            if gk != wk {
                out.push(format!("{path}: keys {gk:?} vs {wk:?}"));
                return;
            }
            for (k, b) in w {
                diff(&format!("{path}.{k}"), &g[k], b, abs, rel, out);
            }
        }
        _ => {
            if got != want {
                out.push(format!("{path}: {got} vs {want}"));
            }
        }
    }
}
