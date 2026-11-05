//! Attached to the app, an export goes into the app's export folder, where its engine may write, and is copied to the
//! user's path from there. The engine's answer never makes this server move a file from anywhere else.

mod common;

use std::path::{Path, PathBuf};

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .map(|d| d.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// Writes what an export names, the way the engine does, and answers with what it wrote. `extra` joins the answer of
/// a separate export, as a file it claims to have written.
fn engine(extra: Option<PathBuf>) -> FakeEngine {
    FakeEngine::start(move |op, req| {
        if op != "export" {
            return json!({"ok": true, "result": {}});
        }
        let path = PathBuf::from(req["path"].as_str().unwrap());
        if req.get("separate") != Some(&json!(true)) {
            std::fs::write(&path, "solid").unwrap();
            return json!({"ok": true, "result": {"path": path}});
        }
        let folder = path.with_extension("");
        std::fs::create_dir(&folder).unwrap();
        let mut paths: Vec<PathBuf> = ["A.stl", "B.stl"].iter().map(|n| folder.join(n)).collect();
        for p in &paths {
            std::fs::write(p, "solid").unwrap();
        }
        paths.extend(extra.clone());
        json!({"ok": true, "result": {"path": folder, "paths": paths}})
    })
}

fn sent_path(engine: &FakeEngine) -> PathBuf {
    let call = engine.calls().into_iter().rfind(|c| c.op == "export").expect("an export call");
    PathBuf::from(call.payload["path"].as_str().unwrap())
}

#[tokio::test]
async fn an_attached_export_is_written_in_the_app_folder_and_copied_into_place() {
    let tmp = tempfile::tempdir().unwrap();
    let (root, user) = (tmp.path().join("app").join("exports"), tmp.path().join("user"));
    std::fs::create_dir(&user).unwrap();
    let engine = engine(None);
    let srv = FundaCad::with_link(engine.link().with_export_dir(Some(root.clone())));

    let part = user.join("part.stl");
    let r = srv.t_export(args(json!({"path": part, "format": "stl"}))).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    assert!(sent_path(&engine).starts_with(&root), "{}", sent_path(&engine).display());
    assert_eq!(std::fs::read_to_string(&part).unwrap(), "solid");

    let r = srv.t_export(args(json!({"path": user.join("kit.stl"), "format": "stl", "separate": true}))).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    assert!(sent_path(&engine).starts_with(&root), "{}", sent_path(&engine).display());
    assert_eq!(names_in(&user.join("kit")), ["A.stl", "B.stl"]);
    assert_eq!(names_in(&user), ["kit", "part.stl"], "nothing else is left beside the files");
    assert!(names_in(&root).is_empty(), "the stage outlived the export: {:?}", names_in(&root));
}

#[tokio::test]
async fn without_an_app_folder_the_export_is_written_beside_its_path() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = engine(None);
    let srv = FundaCad::with_link(engine.link());
    let part = tmp.path().join("part.stl");
    let r = srv.t_export(args(json!({"path": part, "format": "stl"}))).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    assert_eq!(sent_path(&engine).parent().and_then(Path::parent), Some(tmp.path()));
    assert_eq!(names_in(tmp.path()), ["part.stl"]);
}

#[tokio::test]
async fn a_file_the_engine_names_outside_its_stage_is_never_moved() {
    let tmp = tempfile::tempdir().unwrap();
    let secret = tmp.path().join("mine.stl");
    for staged in [false, true] {
        std::fs::write(&secret, "mine").unwrap();
        let engine = engine(Some(secret.clone()));
        let link = engine.link().with_export_dir(staged.then(|| tmp.path().join("exports")));
        let srv = FundaCad::with_link(link);
        let user = tmp.path().join(format!("user-{staged}"));
        std::fs::create_dir(&user).unwrap();
        let r = srv.t_export(args(json!({"path": user.join("kit.stl"), "format": "stl", "separate": true}))).await;
        let r = r.unwrap();
        assert!(is_error(&r), "staged {staged}: {}", text_of(&r));
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "mine", "staged {staged}");
        assert!(!user.join("kit").join("mine.stl").exists(), "staged {staged}");
    }
}

#[test]
fn the_session_file_names_the_app_export_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("session.json");
    let dir = tmp.path().join("engine-tmp").join("exports");
    let text = json!({"port": 9000, "token": "t", "pid": 1, "exportDir": dir}).to_string();
    std::fs::write(&path, text).unwrap();
    let read = fundacad_mcp::app_session::read_session_file(Some(&path)).unwrap();
    assert_eq!(read.export_dir, Some(dir));
    std::fs::write(&path, r#"{"port": 9000, "token": "t", "pid": 1}"#).unwrap();
    assert_eq!(fundacad_mcp::app_session::read_session_file(Some(&path)).unwrap().export_dir, None);
}
