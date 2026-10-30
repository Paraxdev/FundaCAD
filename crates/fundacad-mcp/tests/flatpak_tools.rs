//! The file tools in a Flatpak: a path in the assistant's folder works as before, any other path asks the user in
//! the app window, whose answer comes from a fake engine here, and outside the Flatpak nothing asks.

mod common;

use std::path::{Path, PathBuf};

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::flatpak_folder::Sandbox;
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

/// An app window that answers every file request with `pick`, a path or null for a cancel.
fn window_answering(pick: Value) -> FakeEngine {
    FakeEngine::start(move |op, req| match op {
        "session_ask" if req.contains_key("ask") => json!({"ok": true, "result": {"ok": true, "askId": "a1"}}),
        "session_ask" => json!({"ok": true, "result": {"ok": true, "answered": true, "path": pick}}),
        _ => json!({"ok": true, "result": {}}),
    })
}

fn no_window() -> FakeEngine {
    FakeEngine::always(json!({"ok": true, "result": {"ok": false, "reason": "no-host"}}))
}

fn sandboxed(engine: &FakeEngine, folder: &Path) -> FundaCad {
    let sandbox = Sandbox { folder: folder.to_path_buf(), mounts: Vec::new() };
    FundaCad::with_link(engine.link()).with_sandbox(Some(sandbox))
}

fn args(pairs: Value) -> Map<String, Value> {
    pairs.as_object().cloned().unwrap_or_default()
}

fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::Builder::new().prefix("flatpak-tools-").tempdir().unwrap();
    let folder = root.path().join("FundaCAD");
    let elsewhere = root.path().join("elsewhere");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    (root, folder, elsewhere)
}

fn asks(engine: &FakeEngine) -> Vec<Value> {
    engine.calls().into_iter().filter_map(|c| c.payload.get("ask").cloned()).collect()
}

async fn save(srv: &FundaCad, path: &Path) -> rmcp::model::CallToolResult {
    srv.t_doc_save(args(json!({"path": path.to_string_lossy()}))).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_in_the_folder_is_written_without_asking() {
    let (_root, folder, _) = dirs();
    let engine = window_answering(Value::Null);
    let srv = sandboxed(&engine, &folder);
    let out = save(&srv, &folder.join("part.funda")).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert!(folder.join("part.funda").is_file());
    assert!(asks(&engine).is_empty(), "asked for a path in the folder");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_elsewhere_is_written_where_the_user_picked() {
    let (_root, folder, elsewhere) = dirs();
    let picked = elsewhere.join("picked.funda");
    let engine = window_answering(json!(picked.to_string_lossy()));
    let srv = sandboxed(&engine, &folder);
    let asked = elsewhere.join("asked.funda");
    let out = save(&srv, &asked).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert!(picked.is_file(), "the user's pick was not written");
    assert!(!asked.exists(), "the asked path was written without the user");
    let ask = &asks(&engine)[0];
    assert_eq!(ask["kind"], json!("save"), "{ask}");
    assert_eq!(ask["tool"], json!("doc_save"), "{ask}");
    assert_eq!(ask["path"], json!(asked.to_string_lossy()), "{ask}");
    assert_eq!(ask["exts"], json!(["funda"]), "{ask}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_in_the_window_tells_the_assistant_the_user_declined() {
    let (_root, folder, elsewhere) = dirs();
    let engine = window_answering(Value::Null);
    let srv = sandboxed(&engine, &folder);
    let asked = elsewhere.join("asked.funda");
    let out = save(&srv, &asked).await;
    assert!(is_error(&out) && text_of(&out).contains("declined"), "{}", text_of(&out));
    assert!(!asked.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_window_only_the_folder_is_reached_and_the_refusal_names_it() {
    let (_root, folder, elsewhere) = dirs();
    let engine = no_window();
    let srv = sandboxed(&engine, &folder);
    let asked = elsewhere.join("asked.funda");
    let out = save(&srv, &asked).await;
    assert!(is_error(&out), "{}", text_of(&out));
    assert!(text_of(&out).contains(&folder.display().to_string()), "{}", text_of(&out));
    assert!(!asked.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn outside_the_flatpak_nothing_asks() {
    let (_root, _folder, elsewhere) = dirs();
    let engine = window_answering(Value::Null);
    let srv = FundaCad::with_link(engine.link()).with_sandbox(None);
    let out = save(&srv, &elsewhere.join("part.funda")).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert!(elsewhere.join("part.funda").is_file());
    assert!(asks(&engine).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn doc_open_reads_the_file_the_user_picked() {
    let (_root, folder, elsewhere) = dirs();
    let source = elsewhere.join("source.funda");
    let writer = FundaCad::with_link(no_window().link()).with_sandbox(None);
    assert!(!is_error(&save(&writer, &source).await));
    let engine = window_answering(json!(source.to_string_lossy()));
    let srv = sandboxed(&engine, &folder);
    let asked = elsewhere.join("asked.funda");
    let out = srv.t_doc_open(args(json!({"path": asked.to_string_lossy()}))).await.unwrap();
    assert!(!is_error(&out), "{}", text_of(&out));
    assert!(text_of(&out).contains("source.funda"), "{}", text_of(&out));
    let ask = &asks(&engine)[0];
    assert_eq!(ask["kind"], json!("open"), "{ask}");
    assert_eq!(ask["exts"], json!(["funda", "fundab"]), "{ask}");
}

#[tokio::test(flavor = "multi_thread")]
async fn doc_import_asks_to_open_with_the_files_own_extension() {
    let (_root, folder, elsewhere) = dirs();
    let engine = window_answering(Value::Null);
    let srv = sandboxed(&engine, &folder);
    let asked = elsewhere.join("bracket.step");
    let out = srv.t_doc_import(args(json!({"path": asked.to_string_lossy()}))).await.unwrap();
    assert!(is_error(&out) && text_of(&out).contains("declined"), "{}", text_of(&out));
    let ask = &asks(&engine)[0];
    assert_eq!(ask["kind"], json!("open"), "{ask}");
    assert_eq!(ask["tool"], json!("doc_import"), "{ask}");
    assert_eq!(ask["exts"], json!(["step"]), "{ask}");
}

#[tokio::test(flavor = "multi_thread")]
async fn export_asks_for_a_file_or_for_a_folder_when_separate() {
    let (_root, folder, elsewhere) = dirs();
    let engine = window_answering(Value::Null);
    let srv = sandboxed(&engine, &folder);
    let one = elsewhere.join("part.step");
    let out = srv.t_export(args(json!({"path": one.to_string_lossy(), "format": "step"}))).await.unwrap();
    assert!(is_error(&out) && text_of(&out).contains("declined"), "{}", text_of(&out));
    let out = srv
        .t_export(args(json!({"path": elsewhere.to_string_lossy(), "format": "stl", "separate": true})))
        .await
        .unwrap();
    assert!(is_error(&out) && text_of(&out).contains("declined"), "{}", text_of(&out));
    let asked = asks(&engine);
    assert_eq!(asked[0]["kind"], json!("save"), "{asked:?}");
    assert_eq!(asked[0]["exts"], json!(["step", "stp"]), "{asked:?}");
    assert_eq!(asked[1]["kind"], json!("folder"), "{asked:?}");
}
