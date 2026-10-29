use std::path::{Path, PathBuf};

use fundacad_geom::plugins::{discovered_ids, plugin_root, PluginRoot};
use serde_json::json;

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-discovery-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn put_plugin(root: &Path, dir: &str, id: &str, grants: &[&str]) -> PathBuf {
    let dir = root.join(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = json!({"id": id, "version": "1.0.0", "kind": "compute", "grants": grants,
                          "featureTypes": [format!("{id}.thing")]});
    std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    dir
}

fn put_record(dir: &Path, id: &str, grants: &[&str]) {
    let record = json!({"id": id, "version": "1.0.0", "consented":
                        {"kind": "compute", "version": "1.0.0", "grants": grants, "hosts": []}});
    std::fs::write(dir.join("installed.json"), record.to_string()).unwrap();
}

fn installed(root: &Path, dir: &str, id: &str, grants: &[&str]) {
    let at = put_plugin(root, dir, id, grants);
    put_record(&at, id, grants);
}

#[test]
fn the_engine_loads_only_installed_plugins_the_person_agreed_to() {
    let root = temp_root("installed");
    installed(&root, "Some.Plugin", "Some.Plugin", &["files.read"]);
    let reordered = put_plugin(&root, "Two.Grants", "Two.Grants", &["files.read", "document.read"]);
    put_record(&reordered, "Two.Grants", &["document.read", "files.read", "document.read"]);
    installed(&root, ".inspect-0123456789abcdef", "Some.Plugin", &["files.read"]);
    installed(&root, ".staging-Other.Plugin", "Other.Plugin", &[]);
    put_plugin(&root, "No.Record", "No.Record", &[]);
    let wider = put_plugin(&root, "Wider.Grants", "Wider.Grants", &["files.read"]);
    put_record(&wider, "Wider.Grants", &[]);
    let fewer = put_plugin(&root, "Fewer.Grants", "Fewer.Grants", &[]);
    put_record(&fewer, "Fewer.Grants", &["files.read"]);
    let broken = put_plugin(&root, "Broken.Record", "Broken.Record", &[]);
    std::fs::write(broken.join("installed.json"), "{not json").unwrap();
    let bare = put_plugin(&root, "Bare.Record", "Bare.Record", &[]);
    std::fs::write(bare.join("installed.json"), r#"{"id": "Bare.Record"}"#).unwrap();

    let ids = discovered_ids(&[PluginRoot { dir: root.clone(), records: true }]);
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(ids, ["Some.Plugin", "Two.Grants"]);
}

#[test]
fn a_checkout_root_needs_no_records_and_still_skips_scratch() {
    let root = temp_root("checkout");
    put_plugin(&root, "Some.Plugin", "Some.Plugin", &["files.read"]);
    installed(&root, ".staging-Other.Plugin", "Other.Plugin", &[]);
    let ids = discovered_ids(&[PluginRoot { dir: root.clone(), records: false }]);
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(ids, ["Some.Plugin"]);
}

#[test]
fn only_the_checkout_plugins_dir_is_read_without_records() {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    assert!(!plugin_root(checkout).records);
    let elsewhere = temp_root("elsewhere");
    let decided = plugin_root(elsewhere.clone());
    let _ = std::fs::remove_dir_all(&elsewhere);
    assert!(decided.records);
}
