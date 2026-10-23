//! tests/fixtures/versions/v8.funda keeps its older stamp through `doc_open` and `doc_save`, since MCP runs
//! no migrations. Its own file, as the blob directory is process wide and a second test would race on it.

mod common;

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Value};

#[tokio::test]
async fn an_older_stamp_stays_since_mcp_does_not_migrate() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("FUNDACAD_BLOB_DIR", dir.path().join("blobs"));
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/versions/v8.funda");
    let input: Value = serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
    assert_eq!(input["version"], json!(8));
    let path = dir.path().join("v8.funda");
    std::fs::write(&path, input.to_string()).unwrap();
    let engine = FakeEngine::start(|_, _| json!({"ok": true, "result": {}}));
    let srv = FundaCad::with_link(engine.link());
    let args = |p: &std::path::Path| json!({"path": p.to_string_lossy()}).as_object().cloned().unwrap();
    srv.t_doc_open(args(&path)).await.unwrap();
    let out = dir.path().join("saved.funda");
    let r = srv.t_doc_save(args(&out)).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(saved["version"], json!(8), "a v10 stamp on v8 shapes would skip the app's migrations");
}
