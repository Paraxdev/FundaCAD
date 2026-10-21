//! tests/fixtures/future/v99.funda through `doc_open` and `doc_save`: the note
//! names what this version leaves out, and the saved file holds everything the
//! newer version wrote, its geometry too.

mod common;

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Value};

#[tokio::test]
async fn a_newer_file_opens_with_a_note_and_saves_back_whole() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("FUNDACAD_BLOB_DIR", dir.path().join("blobs"));
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/future/v99.funda");
    let input: Value = serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
    let path = dir.path().join("v99.funda");
    std::fs::write(&path, input.to_string()).unwrap();

    let engine = FakeEngine::start(|_, _| json!({"ok": true, "result": {}}));
    let srv = FundaCad::with_link(engine.link());
    let args = |p: &std::path::Path| json!({"path": p.to_string_lossy()}).as_object().cloned().unwrap();
    let r = srv.t_doc_open(args(&path)).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    let reply = text_of(&r);
    assert!(
        reply.lines().any(|l| l.starts_with("note: ") && l.contains("1 feature was not included") && l.contains("futureWidget")),
        "{reply}"
    );

    let out = dir.path().join("saved.funda");
    let r = srv.t_doc_save(args(&out)).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(saved, input, "MCP edits the document as it came, so it keeps the newer stamp too");
}
