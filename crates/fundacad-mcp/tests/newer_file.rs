//! `doc_open` of a file from a newer FundaCAD says what this build leaves out,
//! with the same facts the app's open notice gives.

mod common;

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::model::FORMAT_VERSION;
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Value};

async fn open(doc: Value) -> String {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("FUNDACAD_BLOB_DIR", dir.path());
    let path = dir.path().join("part.funda");
    std::fs::write(&path, doc.to_string()).unwrap();
    let engine = FakeEngine::start(|_, _| json!({"ok": true, "result": {}}));
    let srv = FundaCad::with_link(engine.link());
    let r = srv.t_doc_open(json!({"path": path.to_string_lossy()}).as_object().cloned().unwrap()).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    text_of(&r)
}

fn note_of(reply: &str) -> Option<&str> {
    reply.lines().find_map(|l| l.strip_prefix("note: "))
}

#[tokio::test]
async fn a_newer_file_names_the_feature_types_this_build_does_not_know() {
    let reply = open(json!({"version": 12, "parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 1, "width": 1, "height": 1},
        {"id": "w1", "type": "futureWidget"},
        {"id": "w2", "type": "futureWidget"},
        {"id": "x1", "type": "fooBar"}
    ]}))
    .await;
    assert_eq!(
        note_of(&reply),
        Some(
            format!(
                "this file is from a newer version of FundaCAD (document version 12, this build reads up to {FORMAT_VERSION}). \
                 3 features were not included because this version does not know them: futureWidget (2), fooBar. \
                 They are kept and saved with the file. Bodies after them may differ. Update FundaCAD to build them."
            )
            .as_str()
        ),
        "{reply}"
    );
}

#[tokio::test]
async fn a_current_file_of_known_types_gets_no_note() {
    let reply = open(json!({"version": FORMAT_VERSION, "parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 1, "width": 1, "height": 1},
        {"id": "t1", "type": "texture"}
    ]}))
    .await;
    assert_eq!(note_of(&reply), None, "a shipped plugin's type is known: {reply}");
}

#[tokio::test]
async fn a_newer_file_of_known_types_says_only_that_it_is_newer() {
    let reply = open(json!({"version": 12, "parameters": {}, "features": []})).await;
    assert!(
        note_of(&reply).is_some_and(|n| n.starts_with("this file is from a newer version")
            && n.ends_with("Anything this version does not know is kept and saved with the file.")),
        "{reply}"
    );
}

#[tokio::test]
async fn an_older_file_with_an_old_type_says_to_update_it_in_the_app() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/versions/v8.funda");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let reply = open(doc).await;
    let note = note_of(&reply).unwrap_or_default();
    assert!(note.starts_with("this file is from an older version of FundaCAD (document version 8)"), "{reply}");
    assert!(note.contains("1 feature is not built here: combine."), "{reply}");
    assert!(!note.contains("does not know"), "combine is an old name, not an unknown one: {reply}");
}

#[tokio::test]
async fn a_current_file_with_a_type_nothing_here_knows_points_at_a_plugin() {
    let reply =
        open(json!({"version": FORMAT_VERSION, "parameters": {}, "features": [{"id": "w1", "type": "futureWidget"}]}))
            .await;
    assert_eq!(
        note_of(&reply),
        Some("1 feature needs a plugin that is not running here: futureWidget. It is kept and saved with the file. Bodies after it may differ."),
        "{reply}"
    );
}
