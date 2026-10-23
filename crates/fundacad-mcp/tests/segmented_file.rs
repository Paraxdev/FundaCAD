//! A .fundab with segmented geometry and a segment index reads as it is: the stream is one deflate stream
//! and the index is a kind this reader skips.

use std::path::Path;

#[test]
fn a_segmented_fixture_reads_and_publishes_its_geometry() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/versions/segmented.fundab");
    let (doc, blobs) = fundacad_mcp::docfile::read_document(&path).unwrap();
    assert_eq!(doc.get("version").and_then(|v| v.as_u64()), Some(10));
    assert_eq!(blobs.len(), 1);
    let (digest, bytes) = &blobs[0];
    assert_eq!(bytes.len(), 300_000);
    assert_eq!(&fundacad_mcp::docfile::hash(bytes), digest);
    let dir = tempfile::tempdir().unwrap();
    assert!(fundacad_mcp::docfile::publish_all(dir.path(), &blobs));
    assert_eq!(std::fs::read(dir.path().join(format!("{digest}.bbrep"))).unwrap(), *bytes);
}
