//! A streaming reader walks the local file headers and this reader walks the central directory, so an archive where
//! the two disagree on a name shows each of them a different document. Such an archive is refused.

use fundacad_format::container::*;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const LOCAL: &[u8; 4] = b"PK\x03\x04";
const LOCAL_NAME_AT: usize = 30;
const CENTRAL: &[u8; 4] = b"PK\x01\x02";
const CENTRAL_NAME_AT: usize = 46;
const DAMAGED: &str = "This document is damaged and cannot be opened.";

fn scratch(tag: &str) -> PathBuf {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).unwrap();
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let d = std::env::temp_dir().join(format!("fundacad_zip_headers_{tag}_{hex}"));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn zip4_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/containers/zip4.funda")
}

fn blob_bytes() -> Vec<u8> {
    b"zip 4 wrote this blob ".repeat(64)
}

fn doc_json(hash: &str) -> String {
    format!(r#"{{"version":5,"features":[{{"type":"import","geom":"{hash}"}}]}}"#)
}

const DECOY_DOC: &[u8] = br#"{"version":5,"features":[]}"#;

/// One blob and one mesh whose entry `mesh/abcd.bin` is as long as `document.json`.
fn written(dir: &Path) -> PathBuf {
    let data = blob_bytes();
    let blob = dir.join("a.bin");
    std::fs::write(&blob, &data).unwrap();
    let mesh = dir.join("m.bin");
    std::fs::write(&mesh, DECOY_DOC).unwrap();
    let blobs = BTreeMap::from([(hash_bytes(&data), blob)]);
    let meshes = BTreeMap::from([("abcd".to_string(), mesh)]);
    let dest = dir.join("part.funda");
    write_zip_container(&dest, &doc_json(&hash_bytes(&data)), &blobs, &meshes, "test").unwrap();
    dest
}

fn rename(bytes: &mut [u8], signature: &[u8; 4], name_at: usize, from: &str, to: &str) {
    assert_eq!(from.len(), to.len(), "a rename in place keeps every offset");
    let at = (0..bytes.len() - name_at - from.len())
        .find(|&p| &bytes[p..p + 4] == signature && &bytes[p + name_at..p + name_at + from.len()] == from.as_bytes())
        .unwrap_or_else(|| panic!("no record names {from}"));
    bytes[at + name_at..at + name_at + to.len()].copy_from_slice(to.as_bytes());
}

#[test]
fn a_local_header_naming_another_file_than_the_central_directory_is_refused() {
    let dir = scratch("renamed");
    let path = written(&dir);
    let mut bytes = std::fs::read(&path).unwrap();
    rename(&mut bytes, LOCAL, LOCAL_NAME_AT, "document.json", "decoyent.json");
    std::fs::write(&path, &bytes).unwrap();

    let opened = read_container(&path, &dir.join("blobs"));
    assert_eq!(opened.map(|(doc, _)| doc), Err(DAMAGED.to_string()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Two central directory entries named `document.json`: a streaming reader takes the first, a lookup by name may take
/// the second.
#[test]
fn a_second_entry_under_the_document_name_is_refused() {
    let dir = scratch("twice");
    let path = written(&dir);
    let mut bytes = std::fs::read(&path).unwrap();
    rename(&mut bytes, LOCAL, LOCAL_NAME_AT, "mesh/abcd.bin", "document.json");
    rename(&mut bytes, CENTRAL, CENTRAL_NAME_AT, "mesh/abcd.bin", "document.json");
    std::fs::write(&path, &bytes).unwrap();

    let opened = read_container(&path, &dir.join("blobs"));
    assert_eq!(opened.map(|(doc, _)| doc), Err(DAMAGED.to_string()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Every container saved before the move to zip 9 was written by zip 4, and the header checks must still open it.
#[test]
fn a_container_zip_4_wrote_still_opens() {
    let dir = scratch("zip4");
    let (doc, manifest) = read_container(&zip4_fixture(), &dir.join("blobs")).unwrap();
    let h = hash_bytes(&blob_bytes());
    assert_eq!(doc, doc_json(&h));
    assert_eq!(manifest.blobs.len(), 1);
    assert_eq!(std::fs::read(dir.join("blobs").join(format!("{h}.bbrep"))).unwrap(), blob_bytes());
    assert!(!dir.join("meshes").exists(), "an open extracts no mesh");
    let _ = std::fs::remove_dir_all(&dir);
}
