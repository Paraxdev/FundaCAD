//! Input addressed cache keys of rebuild_cache.py, `key_i = H(key_{i-1} ‖ sig_i ‖ scope_i)` seeded with `H(env)`.
//! Geometry is never hashed, so kernel float noise cannot move a key.

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
            let memo = format!("{}|{}|{head}|{tail}", f.get("id").map(Value::to_string).unwrap_or_default(), b.len());
            let h = brep_sigs.entry(memo).or_insert_with(|| hash_hex(&[b.as_bytes()])).clone();
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
                Value::String(s) => identifiers(s).into_iter().filter(|r| params.contains_key(*r)).collect(),
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
/// and the hidden bodies for a feature that reads live visibility.
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
                    if k != "nodes" && k != "parts" && k != "notes" {
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
    let scoped: serde_json::Map<String, Value> =
        used.into_iter().filter_map(|n| params.get(&n).map(|v| (n, v.clone()))).collect();
    let mut scope = canonical(&Value::Object(scoped));
    if reads_visibility(f) {
        scope.push('|');
        scope.push_str(hidden_json);
    }
    scope
}

/// A join, cut or intersect without `targets` skips hidden bodies, so its key follows the eye states. With
/// targets it ignores them, and an extrude with its own `hiddenBodies` (null read as absent) reads that set.
fn reads_visibility(f: &Value) -> bool {
    if f.get("targets").and_then(Value::as_array).is_some_and(|t| !t.is_empty()) {
        return false;
    }
    let ty = f.get("type").and_then(Value::as_str);
    if ty == Some("extrude") {
        return f.get("hiddenBodies").map_or(true, Value::is_null);
    }
    ty == Some("press-pull") || f.get("operation").and_then(Value::as_str).is_some_and(|op| op != "new")
}

/// Bump when a feature, kernel patch or default can change the shape a document builds to, so older
/// checkpoints miss. Re-recording tests/golden is the usual sign, and `GOLDEN_DIGESTS` fails until both move.
/// A false bump costs one cold reopen, a missed one stale geometry, so bump when unsure.
pub const GEOMETRY_VERSION: u32 = 2;

/// Bump when what a checkpoint holds, or how `checkpoint.rs` reads one back,
/// changes: a field it lacks comes back empty without an error.
pub const CACHE_FORMAT: u32 = 1;

/// `_env_sig`: everything outside the document that shapes geometry, so an app update finds the last one's
/// checkpoints. Plugins are keyed per feature in `chain_keys`. `FUNDACAD_ENV_SIG` overrides it.
pub fn env_sig() -> String {
    if let Some(forced) = std::env::var("FUNDACAD_ENV_SIG").ok().filter(|s| !s.is_empty()) {
        return forced;
    }
    env_sig_of(GEOMETRY_VERSION, CACHE_FORMAT, crate::OCCT_VERSION, unvouched_build().as_deref())
}

/// `unvouched` is set for a build the two versions cannot speak for.
pub fn env_sig_of(geometry: u32, format: u32, occt: &str, unvouched: Option<&str>) -> String {
    let (tag, own): (&[u8], &str) = match unvouched {
        Some(own) => (b"dev", own),
        None => (b"release", ""),
    };
    hash_hex(&[
        b"engine-cache\0",
        &geometry.to_le_bytes(),
        &format.to_le_bytes(),
        occt.as_bytes(),
        b"\0",
        tag,
        b"\0",
        own.as_bytes(),
    ])
}

/// A build of committed source is vouched for by `GEOMETRY_VERSION`. One with uncommitted edits keys on them,
/// one without a git identity or `set_build` on its binary's size and mtime.
fn unvouched_build() -> Option<String> {
    unvouched(fundacad_engine::build()).map(|own| own.unwrap_or_else(exe_stamp))
}

/// `None` vouched, `Some(None)` nothing to key on but the binary.
fn unvouched(build: Option<&Value>) -> Option<Option<String>> {
    let commit = build.and_then(|b| b.get("commit")).and_then(Value::as_str).filter(|c| !c.is_empty());
    let Some(commit) = commit else {
        return Some(None);
    };
    build.and_then(|b| b.get("changes")).and_then(Value::as_str).map(|changes| Some(format!("{commit}:{changes}")))
}

fn exe_stamp() -> String {
    std::env::current_exe()
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
        .unwrap_or_default()
}

/// The blob an import reads its geometry from, by content hash.
pub fn stored_geometry(f: &Value) -> Option<&str> {
    if f.get("type").and_then(Value::as_str) != Some("import") {
        return None;
    }
    f.get("geom").and_then(Value::as_str).filter(|g| !g.is_empty())
}

/// `_chain_keys_scoped`. `plugins` maps a feature type to its plugin bundle identity, so a checkpoint past
/// a plugin feature misses once that bundle changes, arrives or goes. `absent` holds the `stored_geometry`
/// hashes the blob store lacks, so an import that failed for want of one is retried once it arrives.
pub fn chain_keys(
    raw: &Value,
    env: &str,
    plugins: &HashMap<String, String>,
    absent: &BTreeSet<String>,
    brep_sigs: &mut HashMap<String, String>,
) -> Vec<String> {
    let empty = serde_json::Map::new();
    let params = raw.get("parameters").and_then(Value::as_object).unwrap_or(&empty);
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
        let plugin = f.get("type").and_then(Value::as_str).and_then(|t| plugins.get(t)).map_or("", String::as_str);
        let mut parts: Vec<&[u8]> = vec![k.as_bytes(), sig.as_bytes(), scope.as_bytes()];
        if !plugin.is_empty() {
            parts.extend([&b"|plugin:"[..], plugin.as_bytes(), b"|", hidden_json.as_bytes()]);
        }
        if stored_geometry(f).is_some_and(|g| absent.contains(g)) {
            parts.push(b"|geom:absent");
        }
        k = hash_hex(&parts);
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
    fn only_a_build_of_committed_source_is_vouched_for() {
        assert_eq!(unvouched(Some(&json!({"commit": "abc", "commitDate": "2026-10-21"}))), None);
        assert_eq!(unvouched(Some(&json!({"commit": "abc", "changes": "0f"}))), Some(Some("abc:0f".into())));
        assert_eq!(unvouched(Some(&json!({}))), Some(None));
        assert_eq!(unvouched(None), Some(None));
    }
}
