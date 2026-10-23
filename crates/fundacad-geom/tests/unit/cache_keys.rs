use fundacad_geom::cache::keys::*;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

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
    let k5 = chain_keys(&doc(5), "env", &HashMap::new(), &BTreeSet::new(), &mut memo);
    let k6 = chain_keys(&doc(6), "env", &HashMap::new(), &BTreeSet::new(), &mut memo);
    assert_eq!(k5[..2], k6[..2]);
    assert_ne!(k5[2], k6[2]);
    assert_ne!(chain_keys(&doc(5), "other", &HashMap::new(), &BTreeSet::new(), &mut memo)[0], k5[0]);
}

#[test]
fn a_plugin_bundle_moves_keys_from_its_first_feature() {
    let doc = json!({"features": [
        {"id": "a", "type": "box", "length": 1, "width": 1, "height": 1},
        {"id": "t", "type": "texture", "kind": "knurl"},
        {"id": "b", "type": "box", "length": 2, "width": 1, "height": 1},
    ]});
    let mut memo = HashMap::new();
    let none = chain_keys(&doc, "env", &HashMap::new(), &BTreeSet::new(), &mut memo);
    let v1 = chain_keys(&doc, "env", &HashMap::from([("texture".into(), "v1".into())]), &BTreeSet::new(), &mut memo);
    let v2 = chain_keys(&doc, "env", &HashMap::from([("texture".into(), "v2".into())]), &BTreeSet::new(), &mut memo);
    assert_eq!(none[0], v1[0]);
    assert!(none[1] != v1[1] && v1[1] != v2[1] && v1[2] != v2[2]);
}

#[test]
fn absent_stored_geometry_moves_keys_from_its_import() {
    let doc = json!({"features": [
        {"id": "a", "type": "box", "length": 1, "width": 1, "height": 1},
        {"id": "i", "type": "import", "geom": "ab12"},
        {"id": "b", "type": "box", "length": 2, "width": 1, "height": 1, "geom": "cd34"},
    ]});
    let mut memo = HashMap::new();
    let mut keys = |absent: &[&str]| {
        let absent = absent.iter().map(|g| g.to_string()).collect();
        chain_keys(&doc, "env", &HashMap::new(), &absent, &mut memo)
    };
    let (held, gone) = (keys(&[]), keys(&["ab12"]));
    assert_eq!(held[0], gone[0]);
    assert!(held[1] != gone[1] && held[2] != gone[2]);
    assert_eq!(keys(&["cd34", "ef56"]), held, "a blob no import reads moved a key");
}

#[test]
fn part_names_stay_out_of_the_parameter_scope() {
    let f = json!({"id": "f1", "type": "import", "name": "Imported", "brep": "",
        "nodes": [{"name": "Bracket t Left", "parent": null}], "parts": [{"node": 0, "faces": 6}],
        "notes": ["Bracket t Left: 5 faces did not close into a solid and stay a surface, 4 open edges"]});
    let p5 = json!({"t": 5.0});
    let p6 = json!({"t": 6.0});
    let closure = param_closure(p5.as_object().unwrap());
    assert_eq!(
        feature_scope(&f, p5.as_object().unwrap(), &closure, "[]"),
        feature_scope(&f, p6.as_object().unwrap(), &closure, "[]")
    );
}

#[test]
fn an_extrude_reads_visibility_only_without_its_own_set() {
    let p = serde_json::Map::new();
    let c = HashMap::new();
    let legacy = json!({"id": "e", "type": "extrude"});
    let captured = json!({"id": "e", "type": "extrude", "hiddenBodies": []});
    assert_ne!(feature_scope(&legacy, &p, &c, "[\"body1\"]"), feature_scope(&legacy, &p, &c, "[]"));
    assert_eq!(feature_scope(&captured, &p, &c, "[\"body1\"]"), feature_scope(&captured, &p, &c, "[]"));
}

fn reads(f: Value) -> bool {
    let p = serde_json::Map::new();
    let c = HashMap::new();
    feature_scope(&f, &p, &c, "[\"body1\"]") != feature_scope(&f, &p, &c, "[]")
}

#[test]
fn a_feature_that_names_its_targets_does_not_read_visibility() {
    let named = json!(["body1"]);
    assert!(!reads(json!({"id": "l", "type": "loft", "operation": "cut", "targets": named})));
    assert!(!reads(json!({"id": "r", "type": "revolve", "operation": "cut", "targets": named})));
    assert!(!reads(json!({"id": "b", "type": "box", "operation": "join", "targets": named})));
    assert!(!reads(json!({"id": "s", "type": "sweep", "operation": "intersect", "targets": named})));
    assert!(!reads(json!({"id": "p", "type": "press-pull", "mode": "cut", "targets": named})));
    assert!(!reads(json!({"id": "e", "type": "extrude", "operation": "cut", "targets": named})));
    assert!(!reads(
        json!({"id": "e", "type": "extrude", "operation": "cut", "targets": named, "hiddenBodies": ["body1"]})
    ));
    for none in [json!([]), Value::Null] {
        assert!(reads(json!({"id": "l", "type": "loft", "operation": "cut", "targets": none})), "{none}");
        assert!(reads(json!({"id": "p", "type": "press-pull", "mode": "cut", "targets": none})), "{none}");
        assert!(reads(json!({"id": "e", "type": "extrude", "operation": "cut", "targets": none})), "{none}");
    }
    let doc = |vis: Value| {
        json!({"bodyVisibility": vis, "features": [
            {"id": "a", "type": "box"},
            {"id": "c", "type": "loft", "operation": "cut", "targets": named},
            {"id": "z", "type": "box"},
        ]})
    };
    let mut memo = HashMap::new();
    let mut keys = |vis: Value, plugins: &HashMap<String, String>| {
        chain_keys(&doc(vis), "env", plugins, &BTreeSet::new(), &mut memo)
    };
    let none = HashMap::new();
    assert_eq!(keys(json!({"body1": false}), &none), keys(json!({}), &none));
    assert_eq!(keys(json!({"body1": false}), &none), keys(json!({"body1": true}), &none));
    // A plugin hands combine targets of its own choosing, so its key keeps the eye states.
    let plugins = HashMap::from([("loft".into(), "v1".into())]);
    let (hidden, shown) = (keys(json!({"body1": false}), &plugins), keys(json!({}), &plugins));
    assert_eq!(hidden[0], shown[0]);
    assert_ne!(hidden[1], shown[1]);
}

#[test]
fn a_null_hidden_set_on_an_extrude_still_reads_visibility() {
    assert!(reads(json!({"id": "e", "type": "extrude", "operation": "cut", "hiddenBodies": null})));
}

#[test]
fn a_boolean_without_its_own_hidden_set_reads_visibility() {
    assert!(reads(json!({"id": "b", "type": "box", "operation": "join"})));
    assert!(reads(json!({"id": "r", "type": "revolve", "operation": "cut"})));
    assert!(reads(json!({"id": "p", "type": "press-pull"})));
    assert!(!reads(json!({"id": "b", "type": "box", "operation": "new"})));
    assert!(!reads(json!({"id": "b", "type": "box"})));
    assert!(!reads(json!({"id": "e", "type": "extrude", "operation": "cut", "hiddenBodies": []})));
    let plugins = HashMap::from([("texture".into(), "v1".into())]);
    let doc = |vis: Value| json!({"bodyVisibility": vis, "features": [{"id": "t", "type": "texture"}]});
    let mut memo = HashMap::new();
    assert_ne!(
        chain_keys(&doc(json!({"body1": false})), "env", &plugins, &BTreeSet::new(), &mut memo),
        chain_keys(&doc(json!({})), "env", &plugins, &BTreeSet::new(), &mut memo)
    );
}

#[test]
fn the_signature_moves_only_with_what_shapes_geometry() {
    let base = env_sig_of(1, 1, "7.8.1", None);
    assert_eq!(base, env_sig_of(1, 1, "7.8.1", None));
    assert_ne!(base, env_sig_of(2, 1, "7.8.1", None), "a geometry version bump misses");
    assert_ne!(base, env_sig_of(1, 2, "7.8.1", None), "a cache format bump misses");
    assert_ne!(base, env_sig_of(1, 1, "7.9.0", None), "a kernel version change misses");
    assert_ne!(base, env_sig_of(1, 1, "7.8.1", Some("")), "a dev build never shares a release's");
    assert_ne!(env_sig_of(1, 1, "7.8.1", Some("a")), env_sig_of(1, 1, "7.8.1", Some("b")));
}

/// Each tests/golden digest (CRLF read as LF, the MCP transcript left out) with the `GEOMETRY_VERSION` it was
/// pinned at. A re-record adds a pair at a bumped version, or replaces one at a version that has not shipped.
const GOLDEN_DIGESTS: [(u32, &str); 3] = [
    (1, "74269bcbe84820d4693f680ddbf76ecc"),
    (2, "f6512ae1dbbc6e485eb4cd4252d480a1"),
    (3, "5f9cfa982ced8d4ceca0fcf902ad0bbf"),
];

#[test]
fn each_golden_digest_came_with_a_version_bump() {
    for pair in GOLDEN_DIGESTS.windows(2) {
        assert!(pair[1].0 > pair[0].0, "{} follows {} without a bump", pair[1].1, pair[0].1);
        assert_ne!(pair[1].1, pair[0].1, "version {} pins the same digest as {}", pair[1].0, pair[0].0);
    }
    let (version, _) = GOLDEN_DIGESTS[GOLDEN_DIGESTS.len() - 1];
    assert_eq!(GEOMETRY_VERSION, version, "the last golden digest was pinned at version {version}");
}

#[test]
fn geometry_version_tracks_the_golden_answers() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/golden");
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .expect("tests/golden")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".golden.json") && n != "mcp_parity.golden.json")
        .collect();
    names.sort();
    let mut parts: Vec<Vec<u8>> = Vec::new();
    for n in &names {
        let bytes = std::fs::read(dir.join(n)).unwrap();
        let mut lf = Vec::with_capacity(bytes.len());
        for (i, &b) in bytes.iter().enumerate() {
            if !(b == b'\r' && bytes.get(i + 1) == Some(&b'\n')) {
                lf.push(b);
            }
        }
        parts.push(n.clone().into_bytes());
        parts.push(lf);
    }
    let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    let digest = hash_hex(&refs);
    let (_, pinned) = GOLDEN_DIGESTS[GOLDEN_DIGESTS.len() - 1];
    assert_eq!(
        digest, pinned,
        "tests/golden changed: bump GEOMETRY_VERSION (now {GEOMETRY_VERSION}) when any document builds to a new shape, then add {digest} with it to GOLDEN_DIGESTS"
    );
}

#[test]
fn cyclic_parameters_close_without_looping() {
    let p = json!({"a": "b", "b": "a", "c": 1});
    let closure = param_closure(p.as_object().unwrap());
    assert_eq!(closure["a"].len(), 2);
    assert_eq!(closure["c"].len(), 1);
}
