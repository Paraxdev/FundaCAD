//! The binary twin of the newest document version fixture opens as the same document, so a reader change that alters
//! how an existing `.fundab` opens fails here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fundacad_format::container::{hash_bytes, open_document_checked, write_document};
use fundacad_format::fnda;
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
    write_document(&versions().join("v10.fundab"), &text, &BTreeMap::new(), &BTreeMap::new(), &[], "FundaCAD fixture")
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

/// The geometry of segmented.fundab, cut by the fixture writer into 64 KiB segments.
fn segmented_geometry() -> Vec<u8> {
    (0..300_000u32).map(|i| b"0123456789 ,.-e"[((i.wrapping_mul(2654435761) >> 15) % 15) as usize]).collect()
}

const SEGMENTED_DOCUMENT: &str = r#"{"version":10,"parameters":{},"features":[]}"#;

/// Run by scripts/regen-version-fixtures.sh, never by a plain test run.
#[test]
#[ignore]
fn write_the_segmented_fixture() {
    let geometry = segmented_geometry();
    let blobs = BTreeMap::from([(hash_bytes(&geometry), geometry)]);
    let info = fnda::json_to_cbor(r#"{"app":"FundaCAD fixture","hashAlg":"blake2b-128"}"#).unwrap();
    let doc = fnda::json_to_cbor(SEGMENTED_DOCUMENT).unwrap();
    let mut sections = vec![
        fnda::SectionSpec {
            kind: fnda::KIND_INFO,
            name: "info".into(),
            source: fnda::Source::Bytes(&info),
            layout: fnda::SMALL_LAYOUT,
        },
        fnda::SectionSpec {
            kind: fnda::KIND_DOCUMENT,
            name: "document".into(),
            source: fnda::Source::Bytes(&doc),
            layout: fnda::SMALL_LAYOUT,
        },
    ];
    for (hash, bytes) in &blobs {
        sections.push(fnda::SectionSpec {
            kind: fnda::KIND_GEOMETRY,
            name: hash.clone(),
            source: fnda::Source::Bytes(bytes),
            layout: fnda::LARGE_LAYOUT,
        });
    }
    let o = fnda::WriteOptions { segment_raw: 64 << 10, threads: 1 };
    fnda::write_with(&mut std::fs::File::create(versions().join("segmented.fundab")).unwrap(), &sections, &o).unwrap();
}

#[test]
fn the_segmented_fixture_opens_with_its_geometry() {
    let path = versions().join("segmented.fundab");
    assert!(fnda::read_section_of_kind(&path, fnda::KIND_SEGMENTS).unwrap().is_some());
    let blobs = scratch("segmented");
    let (doc, report) = open_document_checked(&path, &blobs, None).unwrap();
    assert!(report.repaired_shards == 0 && !report.used_backup_index);
    assert_eq!(
        serde_json::from_str::<Value>(&doc).unwrap(),
        serde_json::from_str::<Value>(SEGMENTED_DOCUMENT).unwrap()
    );
    let geometry = segmented_geometry();
    assert_eq!(std::fs::read(blobs.join(format!("{}.bbrep", hash_bytes(&geometry)))).unwrap(), geometry);
    let _ = std::fs::remove_dir_all(blobs);
}
