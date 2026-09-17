//! Input addressed cache keys, sidecar/rebuild_cache.py `_feature_sig`,
//! `_param_closure`, `_feature_scope`, `_chain_keys_scoped`, `_env_sig` and
//! `_blob_key`.
//!
//! `key_i = H(key_{i-1} ‖ sig_i ‖ scope_i)` seeded with `H(env)`. Geometry is
//! never hashed, so kernel float noise cannot move a key; a matching key
//! proves the document prefix and everything it could read are unchanged.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use serde_json::Value;

pub fn hash_hex(parts: &[&[u8]]) -> String {
    let mut h = Blake2bVar::new(16).expect("16 is a valid blake2b digest size");
    for p in parts {
        h.update(p);
    }
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).expect("the digest buffer is 16 bytes");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// JSON with object keys sorted, so a key does not depend on field order.
pub fn canonical(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(&mut out, v);
    out
}

fn write_canonical(out: &mut String, v: &Value) {
    match v {
        Value::Object(m) => {
            let sorted: BTreeMap<&String, &Value> = m.iter().collect();
            out.push('{');
            for (i, (k, x)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                write_canonical(out, x);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(out, x);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// `re.findall(r"[A-Za-z_][A-Za-z0-9_]*", s)`.
pub fn identifiers(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphabetic() || b[i] == b'_' {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            out.push(&s[start..i]);
        } else {
            i += 1;
        }
    }
    out
}

/// `_feature_sig`, with an import's inline base64 replaced by its hash,
/// memoized in `brep_sigs` so an edit elsewhere does not rehash megabytes.
pub fn feature_sig(f: &Value, brep_sigs: &mut HashMap<String, String>) -> String {
    let brep = f.get("brep").and_then(Value::as_str);
    match (f.get("type").and_then(Value::as_str), brep) {
        (Some("import"), Some(b)) => {
            let head: String = b.chars().take(64).collect();
            let tail: String = b.chars().rev().take(64).collect();
            let memo = format!(
                "{}|{}|{head}|{tail}",
                f.get("id").map(Value::to_string).unwrap_or_default(),
                b.len()
            );
            let h = brep_sigs
                .entry(memo)
                .or_insert_with(|| hash_hex(&[b.as_bytes()]))
                .clone();
            let mut g = f.clone();
            g["brep"] = Value::String(h);
            canonical(&g)
        }
        _ => canonical(f),
    }
}

/// `_param_closure`: each parameter and every parameter it reaches.
pub fn param_closure(params: &serde_json::Map<String, Value>) -> HashMap<String, BTreeSet<String>> {
    let deps: HashMap<&str, BTreeSet<&str>> = params
        .iter()
        .map(|(n, v)| {
            let refs = match v {
                Value::String(s) => identifiers(s)
                    .into_iter()
                    .filter(|r| params.contains_key(*r))
                    .collect(),
                _ => BTreeSet::new(),
            };
            (n.as_str(), refs)
        })
        .collect();
    let mut closed = HashMap::new();
    for n in params.keys() {
        let mut out = BTreeSet::new();
        let mut stack = vec![n.as_str()];
        while let Some(x) = stack.pop() {
            if out.insert(x.to_owned()) {
                stack.extend(deps.get(x).into_iter().flatten().copied());
            }
        }
        closed.insert(n.clone(), out);
    }
    closed
}

/// `_feature_scope`: the raw values of the parameters the feature reaches,
/// and the hidden bodies for a legacy extrude that reads live visibility.
pub fn feature_scope(
    f: &Value,
    params: &serde_json::Map<String, Value>,
    closure: &HashMap<String, BTreeSet<String>>,
    hidden_json: &str,
) -> String {
    fn walk<'a>(v: &'a Value, refs: &mut BTreeSet<&'a str>) {
        match v {
            Value::String(s) if s.chars().count() <= 256 => refs.extend(identifiers(s)),
            Value::Object(m) => {
                for (k, x) in m {
                    if k != "nodes" && k != "parts" {
                        walk(x, refs);
                    }
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, refs)),
            _ => {}
        }
    }
    let mut refs = BTreeSet::new();
    walk(f, &mut refs);
    let mut used = BTreeSet::new();
    for r in refs {
        if let Some(c) = closure.get(r) {
            used.extend(c.iter().cloned());
        }
    }
    let scoped: serde_json::Map<String, Value> = used
        .into_iter()
        .filter_map(|n| params.get(&n).map(|v| (n, v.clone())))
        .collect();
    let mut scope = canonical(&Value::Object(scoped));
    let legacy_extrude = f.get("type").and_then(Value::as_str) == Some("extrude")
        && f.get("hiddenBodies").is_none();
    if legacy_extrude {
        scope.push('|');
        scope.push_str(hidden_json);
    }
    scope
}

/// `_env_sig`: everything outside the document that shapes geometry. The
/// engine binary stands in for the sidecar's source files, so any rebuild of
/// it starts every document cold. `FUNDACAD_ENV_SIG` overrides it.
pub fn env_sig() -> String {
    if let Some(forced) = std::env::var("FUNDACAD_ENV_SIG").ok().filter(|s| !s.is_empty()) {
        return forced;
    }
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            format!("{}:{mtime}", m.len())
        })
        .unwrap_or_default();
    hash_hex(&[
        env!("CARGO_PKG_VERSION").as_bytes(),
        crate::OCCT_VERSION.as_bytes(),
        exe.as_bytes(),
    ])
}

/// `_chain_keys_scoped` over a document's features.
pub fn chain_keys(raw: &Value, env: &str, brep_sigs: &mut HashMap<String, String>) -> Vec<String> {
    let empty = serde_json::Map::new();
    let params = raw
        .get("parameters")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let closure = param_closure(params);
    let hidden: BTreeSet<&str> = raw
        .get("bodyVisibility")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, v)| **v == Value::Bool(false))
        .map(|(k, _)| k.as_str())
        .collect();
    let hidden_json = serde_json::to_string(&hidden).unwrap_or_default();
    let mut k = hash_hex(&[env.as_bytes()]);
    let mut keys = Vec::new();
    for f in raw.get("features").and_then(Value::as_array).into_iter().flatten() {
        let sig = feature_sig(f, brep_sigs);
        let scope = feature_scope(f, params, &closure, &hidden_json);
        k = hash_hex(&[k.as_bytes(), sig.as_bytes(), scope.as_bytes()]);
        keys.push(k.clone());
    }
    keys
}

/// `_blob_key`: one feature can modify several bodies, so the body id is mixed in.
pub fn blob_key(chain_key: &str, body_id: &str) -> String {
    hash_hex(&[chain_key.as_bytes(), b":", body_id.as_bytes()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifiers_scan_like_findall() {
        assert_eq!(identifiers("w*2 + h_1 - 3e2"), ["w", "h_1", "e2"]);
    }

    #[test]
    fn canonical_json_ignores_field_order() {
        assert_eq!(canonical(&json!({"b": 1, "a": [2, {"d": 1, "c": 2}]})), r#"{"a":[2,{"c":2,"d":1}],"b":1}"#);
        assert_eq!(canonical(&json!({"b": 1, "a": 2})), canonical(&json!({"a": 2, "b": 1})));
    }

    #[test]
    fn a_parameter_edit_moves_keys_only_from_the_first_reader() {
        let doc = |t: i32| {
            json!({"parameters": {"t": t, "w": "t*2", "h": 4}, "features": [
                {"id": "a", "type": "box", "length": "h", "width": 1, "height": 1},
                {"id": "b", "type": "box", "length": 1, "width": 1, "height": 1},
                {"id": "c", "type": "box", "length": "w", "width": 1, "height": 1},
            ]})
        };
        let mut memo = HashMap::new();
        let k5 = chain_keys(&doc(5), "env", &mut memo);
        let k6 = chain_keys(&doc(6), "env", &mut memo);
        assert_eq!(k5[..2], k6[..2]);
        assert_ne!(k5[2], k6[2]);
        assert_ne!(chain_keys(&doc(5), "other", &mut memo)[0], k5[0]);
    }

    #[test]
    fn part_names_stay_out_of_the_parameter_scope() {
        let f = json!({"id": "f1", "type": "import", "name": "Imported", "brep": "",
            "nodes": [{"name": "Bracket t Left", "parent": null}], "parts": [{"node": 0, "faces": 6}]});
        let p5 = json!({"t": 5.0});
        let p6 = json!({"t": 6.0});
        let closure = param_closure(p5.as_object().unwrap());
        assert_eq!(
            feature_scope(&f, p5.as_object().unwrap(), &closure, "[]"),
            feature_scope(&f, p6.as_object().unwrap(), &closure, "[]")
        );
    }

    #[test]
    fn only_a_legacy_extrude_reads_visibility() {
        let p = serde_json::Map::new();
        let c = HashMap::new();
        let legacy = json!({"id": "e", "type": "extrude"});
        let captured = json!({"id": "e", "type": "extrude", "hiddenBodies": []});
        assert_ne!(feature_scope(&legacy, &p, &c, "[\"body1\"]"), feature_scope(&legacy, &p, &c, "[]"));
        assert_eq!(feature_scope(&captured, &p, &c, "[\"body1\"]"), feature_scope(&captured, &p, &c, "[]"));
    }

    #[test]
    fn cyclic_parameters_close_without_looping() {
        let p = json!({"a": "b", "b": "a", "c": 1});
        let closure = param_closure(p.as_object().unwrap());
        assert_eq!(closure["a"].len(), 2);
        assert_eq!(closure["c"].len(), 1);
    }
}
