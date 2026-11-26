use std::path::{Path, PathBuf};

use serde_json::json;

use super::recent::{forgotten, noted, Recent, MAX};
use super::{new_document, saves_in_place, shown_name, window_title, with_doc_ext, write};

#[test]
fn a_new_document_is_empty_at_the_current_version() {
    let doc = serde_json::Value::Object(new_document());
    let version = fundacad_core::schema::DOCUMENT_VERSION;
    assert_eq!(doc, json!({"version": version, "parameters": {}, "paramDefs": {}, "features": [], "bodyIds": {}}));
}

#[test]
fn names_and_titles() {
    assert_eq!(shown_name(None), "Untitled");
    assert_eq!(shown_name(Some(Path::new("D:/parts/Lid v2.funda"))), "Lid v2");
    assert_eq!(window_title("Lid v2", false), "Lid v2, FundaCAD 2");
    assert_eq!(window_title("Untitled", true), "Untitled*, FundaCAD 2");
}

#[test]
fn only_a_funda_saves_in_place() {
    assert!(saves_in_place(Some(Path::new("a/b.funda"))));
    assert!(saves_in_place(Some(Path::new("a/b.FUNDA"))));
    assert!(!saves_in_place(Some(Path::new("a/b.fundab"))));
    assert!(!saves_in_place(Some(Path::new("a/b.stl"))));
    assert!(!saves_in_place(None));
    assert_eq!(with_doc_ext(PathBuf::from("a/b.funda")), PathBuf::from("a/b.funda"));
    assert_eq!(with_doc_ext(PathBuf::from("a/b")), PathBuf::from("a/b.funda"));
    assert_eq!(with_doc_ext(PathBuf::from("a/b.v2")), PathBuf::from("a/b.v2.funda"));
}

#[test]
fn a_written_document_reads_back_with_its_values() {
    let dir = std::env::temp_dir().join(format!("fundacad-app-test-{}-write", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let blobs = dir.join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let current = fundacad_core::schema::DOCUMENT_VERSION;
    let mut doc = new_document();
    doc.insert("parameters".into(), json!({"width": 37.5, "depth": -12.25}));
    doc.insert("features".into(), json!([{"id": "f7", "type": "box", "params": {"x": 3.5, "y": -8.0}}]));
    doc.insert("version".into(), json!(current + 4));
    doc.insert("geometry".into(), json!({"stale": true}));
    let path = dir.join("part.funda");
    write(&path, &doc, None).unwrap();

    let read: serde_json::Value =
        serde_json::from_str(&fundacad_format::read_document(&path, &blobs).unwrap()).unwrap();
    let mut want = serde_json::Value::Object(doc);
    want["version"] = json!(current);
    want.as_object_mut().unwrap().remove("geometry");
    assert_eq!(read, want);
    std::fs::remove_dir_all(&dir).unwrap();
}

fn r(path: &str, at: u64) -> Recent {
    Recent { path: PathBuf::from(path), opened_at: at }
}

#[test]
fn recent_files_put_the_latest_first_once() {
    assert_eq!(noted(vec![], Path::new("D:/a.funda"), 7), vec![r("D:/a.funda", 7)]);
    let list = vec![r("D:/b.funda", 5), r("D:/a.funda", 3)];
    assert_eq!(noted(list.clone(), Path::new("D:/a.funda"), 9), vec![r("D:/a.funda", 9), r("D:/b.funda", 5)]);
    assert_eq!(
        noted(list.clone(), Path::new("D:/c.funda"), 9),
        vec![r("D:/c.funda", 9), r("D:/b.funda", 5), r("D:/a.funda", 3)]
    );
    assert_eq!(forgotten(list.clone(), Path::new("D:/b.funda")), vec![r("D:/a.funda", 3)]);
    assert_eq!(forgotten(list.clone(), Path::new("D:/z.funda")), list);
}

#[test]
fn recent_files_stop_at_fifty() {
    let full: Vec<Recent> = (0..MAX as u64).map(|i| r(&format!("D:/p{i}.funda"), i)).collect();
    let list = noted(full, Path::new("D:/new.funda"), 99);
    assert_eq!(list.len(), MAX);
    assert_eq!(list[0], r("D:/new.funda", 99));
    assert_eq!(list[MAX - 1], r("D:/p48.funda", 48));
}

#[test]
fn recent_files_store_as_fundacad_1_did() {
    let text = serde_json::to_value(vec![r("D:/a.funda", 3)]).unwrap();
    assert_eq!(text, json!([{"path": "D:/a.funda", "openedAt": 3}]));
}

#[test]
fn a_bad_recent_entry_is_skipped_and_the_rest_kept() {
    use super::recent::readable;
    assert_eq!(readable(vec![]), vec![]);
    assert_eq!(readable(vec![json!({"path": "D:/parts/lid.funda", "openedAt": 17})]), vec![r("D:/parts/lid.funda", 17)]);
    let mixed = vec![
        json!({"path": "D:/parts/lid.funda", "openedAt": 17}),
        json!({"path": 4}),
        json!("E:/loose.funda"),
        json!({"path": "E:/box.fundab", "openedAt": 3}),
    ];
    assert_eq!(readable(mixed), vec![r("D:/parts/lid.funda", 17), r("E:/box.fundab", 3)]);
}
