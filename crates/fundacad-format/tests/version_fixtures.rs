//! The binary twin of the newest document version fixture opens as the same
//! document, so a reader change that alters how an existing `.fundab` opens fails
//! here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fundacad_format::container::{open_document_checked, write_document};
use serde_json::Value;

fn versions() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/versions")
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad_versions_{tag}_{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Run by scripts/regen-version-fixtures.sh, never by a plain test run.
#[test]
#[ignore]
fn write_the_v10_binary_fixture() {
    let text = std::fs::read_to_string(versions().join("v10.funda")).unwrap();
    write_document(
        &versions().join("v10.fundab"),
        &text,
        &BTreeMap::new(),
        &BTreeMap::new(),
        "FundaCAD fixture",
    )
    .unwrap();
}

#[test]
fn the_v10_binary_fixture_opens_as_its_json_twin() {
    let blobs = scratch("blobs");
    let (doc, report) = open_document_checked(&versions().join("v10.fundab"), &blobs, None).unwrap();
    assert!(report.repaired_shards == 0 && !report.used_backup_index);
    let json: Value = serde_json::from_str(&std::fs::read_to_string(versions().join("v10.funda")).unwrap()).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&doc).unwrap(), json);
    let _ = std::fs::remove_dir_all(blobs);
}
