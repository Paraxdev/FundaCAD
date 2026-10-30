//! An XBF document can list other documents in its header (a START_REF block), which an
//! OCCT path open would load beside it. FundaCAD refuses such a document.

use std::path::PathBuf;

use fundacad_geom::import::{self, blobstore::BlobStore};

fn dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-import-xbf-refs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
    dir
}

fn record(text: &str) -> Vec<u8> {
    let mut v = (text.len() as i32).to_le_bytes().to_vec();
    v.extend_from_slice(text.as_bytes());
    v
}

/// two_parts.xbf with its two counter lines swapped for a reference block of the same byte length,
/// so every offset in the header still points where it did.
fn with_reference_block() -> Vec<u8> {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
    let mut bytes = std::fs::read(fixtures.join("two_parts.xbf")).unwrap();
    let old = [record("REFERENCE_COUNTER: 0"), record("MODIFICATION_COUNTER: 1")].concat();
    let new = [record("START_REF"), record("0 1 other_documents.xbf"), record("END_REF")].concat();
    assert_eq!(old.len(), new.len());
    let at = bytes.windows(old.len()).position(|w| w == old).unwrap();
    let count = at - record("FILE_FORMAT: BinXCAF").len() - 4;
    assert_eq!(bytes[count..count + 4], 19i32.to_le_bytes());
    bytes[count..count + 4].copy_from_slice(&20i32.to_le_bytes());
    bytes.splice(at..at + old.len(), new);
    bytes
}

#[test]
fn an_xbf_that_lists_other_documents_is_refused() {
    let dir = dir();
    let file = dir.join("with_refs.xbf");
    std::fs::write(&file, with_reference_block()).unwrap();
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/two_parts.xbf"),
        dir.join("other_documents.xbf"),
    )
    .unwrap();
    let store = BlobStore::open(&dir).unwrap();
    let e = import::import_geometry(file.to_str().unwrap(), "xbf", &store).unwrap_err();
    assert!(e.contains("other documents"), "{e}");
}

#[test]
fn an_xbf_with_a_truncated_header_is_refused_as_unreadable() {
    let dir = dir();
    let file = dir.join("truncated.xbf");
    let mut bytes = with_reference_block();
    bytes.truncate(120);
    std::fs::write(&file, bytes).unwrap();
    let store = BlobStore::open(&dir).unwrap();
    let e = import::import_geometry(file.to_str().unwrap(), "xbf", &store).unwrap_err();
    assert!(e.contains("could not read the XBF file"), "{e}");
}
