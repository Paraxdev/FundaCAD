use std::path::{Path, PathBuf};

use fundacad_geom::plugins::{discovered_ids, plugin_root, PluginRoot};
use fundacad_lib::plugins::{write_disabled, DISABLED};
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

#[test]
fn a_plugin_switched_off_in_the_window_is_not_loaded_by_the_engine() {
    let root = temp_root("disabled");
    let checkout = temp_root("disabled-checkout");
    installed(&root, "Some.Plugin", "Some.Plugin", &[]);
    installed(&root, "Other.Plugin", "Other.Plugin", &[]);
    put_plugin(&checkout, "Some.Plugin", "Some.Plugin", &[]);
    let roots = [PluginRoot { dir: root.clone(), records: true }, PluginRoot { dir: checkout.clone(), records: false }];

    write_disabled(&root, &["Some.Plugin".into()]).unwrap();
    let off = discovered_ids(&roots);
    write_disabled(&root, &[]).unwrap();
    let on = discovered_ids(&roots);
    std::fs::write(root.join(DISABLED), "{not json").unwrap();
    let unparseable = discovered_ids(&roots);
    std::fs::write(root.join(DISABLED), r#"["Some.Plugin", 7]"#).unwrap();
    let mistyped = discovered_ids(&roots);
    std::fs::remove_file(root.join(DISABLED)).unwrap();
    std::fs::create_dir(root.join(DISABLED)).unwrap();
    let unreadable = discovered_ids(&roots);
    std::fs::remove_dir(root.join(DISABLED)).unwrap();
    let never_written = discovered_ids(&roots);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&checkout);

    assert_eq!(off, ["Other.Plugin"]);
    assert_eq!(on, ["Other.Plugin", "Some.Plugin"]);
    let none: [&str; 0] = [];
    assert_eq!([unparseable, mistyped, unreadable], [none; 3]);
    assert_eq!(never_written, ["Other.Plugin", "Some.Plugin"]);
}

#[test]
fn a_switched_off_plugin_stays_off_whatever_its_manifest_calls_it() {
    let root = temp_root("disabled-renamed");
    installed(&root, "Some.Plugin", "Another.Name", &[]);
    installed(&root, "Other.Plugin", "Other.Plugin", &[]);
    write_disabled(&root, &["Some.Plugin".into()]).unwrap();
    let ids = discovered_ids(&[PluginRoot { dir: root.clone(), records: true }]);
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(ids, ["Other.Plugin"]);
}

#[test]
fn the_switched_off_list_is_sorted_and_holds_only_plugin_ids() {
    let root = temp_root("disabled-list");
    let ids = ["Zed.Plugin", "../escape", "Alpha", "", "Zed.Plugin", ".staging-x"].map(String::from);
    write_disabled(&root, &ids).unwrap();
    let text = std::fs::read_to_string(root.join(DISABLED)).unwrap();
    let left: Vec<String> =
        std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(text, r#"["Alpha","Zed.Plugin"]"#);
    assert_eq!(left, [DISABLED]);
}
