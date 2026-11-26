use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::manifest::{self, Manifest};
use super::{discover, screws, settle_disabled, write_disabled, Found, Root, DISABLED_FILE, NATIVES, RECORD_FILE};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("funda-plugins-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn put(root: &Path, folder: &str, manifest: serde_json::Value) -> PathBuf {
    let dir = root.join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    dir
}

fn plugin(id: &str) -> serde_json::Value {
    json!({"id": id, "name": id, "version": "1.0.0", "kind": "compute", "grants": ["geometry.build"],
           "featureTypes": ["knurl"], "geometryWasm": "geometry.wasm"})
}

#[test]
fn the_bundled_manifests_read() {
    for n in NATIVES {
        let m = Manifest::parse(n.manifest).unwrap();
        assert_eq!(m.kind, "builtin");
        assert!(m.enabled_by_default);
    }
    let screws = Manifest::parse(screws::NATIVE.manifest).unwrap();
    assert_eq!(screws.shape_generators, ["fastener"]);
    assert_eq!(screws.name_in("de"), "Verbindungselemente");
    assert_eq!(screws.name_in("xx"), "Fasteners");
}

#[test]
fn a_manifest_is_refused_for_what_fundacad_1_refused() {
    assert!(Manifest::parse(r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":[]}"#).is_ok());
    let printing = r#"{"id":"A.B","name":"x","version":"1","kind":"process",
        "grants":["network.local","process.spawn","network"],"hosts":["example.com"],
        "translations":{"de":{"name":"y"},"fr":{"name":3},"bad code":{"name":"z"}}}"#;
    let m = Manifest::parse(printing).unwrap();
    assert_eq!(m.translations.keys().collect::<Vec<_>>(), ["de"], "a bad translation is dropped, not fatal");
    for bad in [
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel"}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":["network"]}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":[],"hosts":["example.com"]}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":["network"],"hosts":["http://x.com"]}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":["files.read","files.read"]}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":[],"featureTypes":[""]}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":[],"formerIds":["A.B"]}"#,
        r#"{"id":"..","name":"x","version":"1","kind":"panel"}"#,
        r#"{"id":"A.B.C","name":"x","version":"1","kind":"panel"}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"daemon"}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":["root"]}"#,
        r#"{"id":"A.B","name":"x","version":"1","kind":"panel","grants":[],"enabledByDefault":"yes"}"#,
        r#"{"id":"A.B","version":"1","kind":"panel","grants":[]}"#,
        "[]",
    ] {
        assert!(Manifest::parse(bad).is_err(), "{bad}");
    }
    assert!(manifest::same_id("Some.Tool", "some.tool"));
}

#[test]
fn discovery_needs_consent_in_a_recorded_root_and_the_first_id_wins() {
    let user = temp("user");
    let repo = temp("repo");
    let agreed = put(&user, "Acme.Knurl", plugin("Acme.Knurl"));
    std::fs::write(agreed.join(RECORD_FILE), json!({"consented": {"grants": ["geometry.build"]}}).to_string()).unwrap();
    put(&user, "Acme.Unasked", plugin("Acme.Unasked"));
    put(&user, ".staging-x", plugin("Acme.Staged"));
    put(&repo, "Acme.Knurl", plugin("acme.knurl"));
    put(&repo, "FundaCAD.Screws", plugin("FundaCAD.Screws"));
    std::fs::create_dir_all(repo.join("Broken")).unwrap();
    std::fs::write(repo.join("Broken/manifest.json"), "{").unwrap();
    let roots = [Root { dir: user.clone(), records: true }, Root { dir: repo.clone(), records: false }];
    let found = discover(&roots, &[screws::NATIVE.manifest]);
    let ids: Vec<&str> = found.iter().map(|f| f.manifest.id.as_str()).collect();
    assert_eq!(ids, ["FundaCAD.Screws", "Acme.Knurl", "Broken"]);
    assert!(found[0].native && found[0].dir.as_deref() == Some(repo.join("FundaCAD.Screws").as_path()));
    assert_eq!(found[0].manifest.feature_types, ["knurl"], "a native takes its folder's engine part");
    assert_eq!(found[1].dir.as_deref(), Some(agreed.as_path()));
    assert!(found[1].problem.is_none() && found[2].problem.is_some());
    assert_eq!(found[1].engine_part().as_deref(), Some("features knurl"));
    let _ = std::fs::remove_dir_all(user);
    let _ = std::fs::remove_dir_all(repo);
}

#[test]
fn off_by_default_switches_off_once_and_the_choice_then_holds() {
    let mut quiet = Manifest::parse(r#"{"id":"A.Pad","name":"Pad","version":"1","kind":"panel","grants":[]}"#).unwrap();
    quiet.enabled_by_default = false;
    let found = vec![Found { manifest: quiet, dir: None, native: false, problem: None }];
    let (off, seen) = settle_disabled(&found, &[], &[]);
    assert_eq!(off, BTreeSet::from(["A.Pad".to_owned()]));
    assert_eq!(seen, ["A.Pad"]);
    let (off, _) = settle_disabled(&found, &[], &seen);
    assert!(off.is_empty(), "switched on by the person, it stays on");
}

#[test]
fn the_engine_reads_the_switches_as_a_list() {
    let dir = temp("switches");
    write_disabled(&dir, &BTreeSet::from(["B.Two".to_owned(), "A.One".to_owned()])).unwrap();
    let text = std::fs::read_to_string(dir.join(DISABLED_FILE)).unwrap();
    assert_eq!(text, r#"["A.One","B.Two"]"#);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_fastener_is_stored_as_an_import_with_its_spec() {
    let spec = screws_spec();
    let reply = json!({"geom": "abc", "solid": true, "volume": 1.0}).as_object().unwrap().clone();
    let f = screws::feature("f3", &spec, &reply).unwrap();
    assert_eq!(f["type"], "import");
    assert_eq!(f["format"], "brep");
    assert_eq!(f["name"], "ISO 4762 M3x5");
    assert_eq!(f["generatedBy"], json!({"plugin": "FundaCAD.Screws", "spec": spec}));
    let keys: Vec<&String> = f.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["id", "type", "format", "name", "geom", "solid", "generatedBy"]);
    let doc = json!({"features": [f]}).as_object().unwrap().clone();
    assert_eq!(screws::spec_of(&doc, &["f3".into()]), Some(spec));
    assert_eq!(screws::spec_of(&doc, &["f9".into()]), None);
    assert!(screws::feature("f3", &screws_spec(), &serde_json::Map::new()).is_err());
}

fn screws_spec() -> serde_json::Value {
    json!({"kind": "screw", "name": "ISO 4762 M3x5"})
}
