//! Canonical recognition against the Python engine's `_canonicalize` on the same
//! NURBS shapes (tests/canonical/gen.py on the legacy branch).

use fundacad_geom::import::canonical;
use fundacad_geom::kernel::{self, Kind};
use opencascade::canonical::surface_types;
use opencascade::mesh_access;
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

fn summary(sh: &Shape) -> Value {
    let mut kinds: std::collections::BTreeMap<&str, u64> = std::collections::BTreeMap::new();
    for k in surface_types(sh).unwrap() {
        *kinds.entry(k).or_insert(0) += 1;
    }
    json!({
        "faces": kernel::count(sh, Kind::Face),
        "solids": kernel::count(sh, Kind::Solid),
        "volume": kernel::volume(sh),
        "valid": sh.is_valid().unwrap(),
        "surfaces": kinds,
    })
}

#[test]
fn canonicalize_matches_python() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/canonical");
    let oracle: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("oracle.json")).unwrap()).unwrap();
    let mut failures = Vec::new();
    for (name, want) in oracle.as_object().unwrap() {
        let text = std::fs::read_to_string(dir.join(format!("{name}.nurbs.brep"))).unwrap();
        let shape = mesh_access::read_brep_str(&text).unwrap();
        let result = canonical::canonicalize(&shape);
        if json!(result.is_some()) != want["changed"] {
            failures.push(format!("{name}: changed {}", result.is_some()));
        }
        let got = summary(result.as_ref().unwrap_or(&shape));
        let w = &want["output"];
        let strip = |v: &Value| {
            let mut m: Map<String, Value> = v.as_object().unwrap().clone();
            m.remove("volume");
            Value::Object(m)
        };
        if strip(&got) != strip(w) {
            failures.push(format!("{name}: {got}\n  want {w}"));
        }
        let (gv, wv) = (got["volume"].as_f64().unwrap(), w["volume"].as_f64().unwrap());
        if (gv - wv).abs() > 1e-3 * wv.abs() {
            failures.push(format!("{name}: volume {gv} want {wv}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
