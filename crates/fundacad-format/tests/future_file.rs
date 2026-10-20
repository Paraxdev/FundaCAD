//! tests/fixtures/future/v99.funda through the readers and writers, as JSON and
//! as a .fundab holding a section of a kind this version does not read.

use std::collections::BTreeMap;
use std::path::PathBuf;

use fundacad_format::container::{open_document_full, write_document};
use fundacad_format::fnda;
use fundacad_format::json_doc::read_json_document;
use serde_json::Value;

const HASH: &str = "3d5f6f61f61669768c1d1bcc6e0bb057";

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad_future_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/future/v99.funda")
}

fn input() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture()).unwrap()).unwrap()
}

fn without_geometry(mut v: Value) -> Value {
    v.as_object_mut().unwrap().remove("geometry");
    v
}

#[test]
fn the_json_file_keeps_its_geometry_through_a_save() {
    let dir = scratch("json");
    let blobs = dir.join("blobs");
    let doc = read_json_document(&fixture(), &blobs).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&doc).unwrap(), without_geometry(input()));
    let blob = blobs.join(format!("{HASH}.bbrep"));
    assert!(blob.exists(), "the blob only w1 names is published");

    let saved = dir.join("saved.funda");
    write_document(&saved, &doc, &BTreeMap::from([(HASH.to_string(), blob)]), &BTreeMap::new(), &[], "t").unwrap();
    assert_eq!(serde_json::from_str::<Value>(&std::fs::read_to_string(&saved).unwrap()).unwrap(), input());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_binary_sibling_keeps_its_geometry_and_its_unknown_section() {
    let dir = scratch("binary");
    let blobs = dir.join("blobs");
    let doc = read_json_document(&fixture(), &blobs).unwrap();
    let blob = blobs.join(format!("{HASH}.bbrep"));
    let index: Vec<u8> = (0..2048u32).map(|i| (i % 241) as u8).collect();
    let info = fnda::json_to_cbor("{}").unwrap();
    let cbor = fnda::json_to_cbor(&doc).unwrap();
    let geometry = BTreeMap::from([(HASH.to_string(), blob.clone())]);
    let meshes = BTreeMap::new();
    let mut sections = fnda::document_sections(&info, &cbor, &geometry, &meshes, &[]);
    sections.push(fnda::SectionSpec { kind: 9, name: "futureIndex".into(), source: fnda::Source::Bytes(&index), layout: fnda::SMALL_LAYOUT });
    let sibling = dir.join("v99.fundab");
    fnda::write(&mut std::fs::File::create(&sibling).unwrap(), &sections).unwrap();

    let (blobs_b, carry) = (dir.join("blobs_b"), dir.join("sections"));
    let opened = open_document_full(&sibling, &blobs_b, None, Some(&carry)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&opened.document).unwrap(), without_geometry(input()));
    let carried: Vec<_> = opened.carried.iter().map(|c| (c.clone(), carry.join(format!("{}.bin", c.hash)))).collect();
    let saved = dir.join("saved.fundab");
    write_document(&saved, &opened.document, &geometry, &BTreeMap::new(), &carried, "t").unwrap();

    let (blobs_c, carry_c) = (dir.join("blobs_c"), dir.join("sections_c"));
    let again = open_document_full(&saved, &blobs_c, None, Some(&carry_c)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&again.document).unwrap(), without_geometry(input()));
    assert_eq!(again.carried, opened.carried);
    assert_eq!(std::fs::read(blobs_c.join(format!("{HASH}.bbrep"))).unwrap(), std::fs::read(&blob).unwrap());
    assert_eq!(std::fs::read(carry_c.join(format!("{}.bin", again.carried[0].hash))).unwrap(), index);
    let _ = std::fs::remove_dir_all(&dir);
}
