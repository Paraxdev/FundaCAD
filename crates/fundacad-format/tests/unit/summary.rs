use fundacad_format::fnda::{document_sections, hex, json_to_cbor, write};
use fundacad_format::summary::*;
use std::collections::BTreeMap;

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).unwrap();
    let d = std::env::temp_dir().join(format!("fundacad_summary_{tag}_{}", hex(&b)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

const DOC: &str = r#"{
  "version": 10,
  "features": [{ "id": "f1", "type": "box" }],
  "versions": {
    "objects": { "h1": "{\"id\":\"f1\"}", "r1": "{}" },
    "versions": [
      { "id": "v1", "parent": null, "branch": "main", "message": "First", "time": 100, "tree": { "features": ["h1"], "rest": "r1" } },
      { "id": "v2", "parent": "v1", "branch": "main", "message": "Second", "time": 200, "tree": { "features": [], "rest": "r1" } },
      { "id": "v3", "parent": "v1", "branch": "wide", "message": "Wider", "time": 300, "tree": { "features": ["h1"], "rest": "r1" } },
      { "id": 7, "branch": "main" },
      { "id": "v9", "branch": "main" }
    ],
    "branches": { "main": "v2", "wide": "v3", "gone": "v8", "bad": 5 },
    "current": "wide"
  }
}"#;

fn want(format: &'static str) -> Summary {
    let row = |id: &str, parent: Option<&str>, branch: &str, message: &str, time: f64| VersionRow {
        id: id.into(),
        parent: parent.map(Into::into),
        branch: branch.into(),
        message: message.into(),
        time,
    };
    Summary {
        format,
        versions: vec![
            row("v1", None, "main", "First", 100.0),
            row("v2", Some("v1"), "main", "Second", 200.0),
            row("v3", Some("v1"), "wide", "Wider", 300.0),
        ],
        branches: BTreeMap::from([("main".into(), "v2".into()), ("wide".into(), "v3".into())]),
        current: "wide".into(),
    }
}

/// The document with a large geometry map after it, as the app writes an import.
fn with_geometry(doc: &str) -> String {
    let blob = "QUJD".repeat(250_000);
    format!("{},\n  \"geometry\": {{ \"{}\": \"{blob}\" }}\n}}", doc.trim_end().trim_end_matches('}'), "0".repeat(32))
}

#[test]
fn a_json_document_and_a_binary_one_give_the_same_rows() {
    let dir = tmpdir("both");
    let json = dir.join("part.funda");
    std::fs::write(&json, with_geometry(DOC)).unwrap();
    assert_eq!(read_summary(&json).unwrap(), Some(want("funda")));

    let blob = dir.join("blob.bin");
    let geometry: Vec<u8> = (0..400_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    std::fs::write(&blob, &geometry).unwrap();
    let hash = {
        use blake2::{digest::consts::U16, Blake2b, Digest};
        hex(&Blake2b::<U16>::digest(&geometry))
    };
    let blobs = BTreeMap::from([(hash, blob)]);
    let info = json_to_cbor(r#"{"app":"test"}"#).unwrap();
    let cbor = json_to_cbor(DOC).unwrap();
    let bin = dir.join("part.fundab");
    let mut file = std::fs::File::create(&bin).unwrap();
    write(&mut file, &document_sections(&info, &cbor, &blobs, &BTreeMap::new(), &[])).unwrap();
    drop(file);
    assert_eq!(read_summary(&bin).unwrap(), Some(want("fundab")));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_document_without_history_has_no_rows() {
    let dir = tmpdir("none");
    let path = dir.join("plain.funda");
    std::fs::write(&path, r#"{ "version": 10, "features": [] }"#).unwrap();
    let s = read_summary(&path).unwrap().unwrap();
    assert!(s.versions.is_empty() && s.branches.is_empty());
    assert_eq!(s.current, "main");
    let _ = std::fs::remove_dir_all(&dir);
}

fn summary_of(tag: &str, doc: &str) -> Summary {
    let dir = tmpdir(tag);
    let path = dir.join("part.funda");
    std::fs::write(&path, doc).unwrap();
    let s = read_summary(&path).unwrap().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    s
}

#[test]
fn rows_of_the_wrong_shape_are_read_as_the_app_reads_them() {
    let row = r#"{ "id": "v1", "parent": 4, "branch": "main", "tree": { "features": [], "rest": "r" } }"#;
    let s = summary_of(
        "parent",
        &format!(r#"{{ "versions": {{ "versions": [{row}], "branches": {{ "main": "v1" }} }} }}"#),
    );
    assert_eq!(s.versions.len(), 1);
    assert_eq!(s.versions[0].parent, None);
    for repo in [r#""versions": 3"#, r#""versions": { "versions": {}, "branches": [] }"#] {
        let s = summary_of("shape", &format!("{{ {repo} }}"));
        assert!(s.versions.is_empty() && s.branches.is_empty());
        assert_eq!(s.current, "main");
    }
}

#[test]
fn with_no_current_branch_the_first_in_the_file_is_taken() {
    let row = |id: &str| format!(r#"{{ "id": "{id}", "branch": "b", "tree": {{ "features": [], "rest": "r" }} }}"#);
    let doc = |branches: &str| {
        format!(
            r#"{{ "versions": {{ "versions": [{}, {}, {}], "branches": {{ {branches} }} }} }}"#,
            row("v1"),
            row("v2"),
            row("v3")
        )
    };
    assert_eq!(summary_of("order", &doc(r#""zeta": "v1", "alpha": "v2""#)).current, "zeta");
    assert_eq!(summary_of("index", &doc(r#""zeta": "v1", "10": "v2", "2": "v3""#)).current, "2");
}

#[test]
fn the_old_zip_container_is_not_summarised() {
    let dir = tmpdir("zip");
    let path = dir.join("old.funda");
    std::fs::write(&path, b"PK\x03\x04rest of a zip").unwrap();
    assert_eq!(read_summary(&path).unwrap(), None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn garbage_and_a_missing_file_are_errors() {
    let dir = tmpdir("bad");
    let path = dir.join("bad.funda");
    std::fs::write(&path, b"not json at all").unwrap();
    assert!(read_summary(&path).is_err());
    assert!(read_summary(&dir.join("gone.funda")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn it_serialises_as_the_webview_reads_it() {
    let s = serde_json::to_value(want("funda")).unwrap();
    assert_eq!(s["versions"][1]["parent"], "v1");
    assert_eq!(s["branches"]["wide"], "v3");
    assert_eq!(s["current"], "wide");
    assert_eq!(s["format"], "funda");
}
