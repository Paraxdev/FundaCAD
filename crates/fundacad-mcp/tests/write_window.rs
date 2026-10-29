//! What is at the path is judged again right before the write, since a save waits on the engine in between,
//! and the engine's part names are held to the format's extension too.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use blake2::digest::{Update, VariableOutput};
use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

const NOTES: &str = "plain notes, not a model\n";

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn digest(data: &[u8]) -> String {
    let mut h = blake2::Blake2bVar::new(16).unwrap();
    h.update(data);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).unwrap();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn empty_local_store() {
    static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let dir = DIR.get_or_init(|| tempfile::tempdir().unwrap());
    std::env::set_var("FUNDACAD_BLOB_DIR", dir.path());
}

/// An engine that hands out one blob and, on the first read of it, puts `NOTES` at `at`.
fn engine_writing_notes_while_asked(at: PathBuf, data: Vec<u8>) -> FakeEngine {
    let hash = digest(&data);
    let blobs = Mutex::new(HashMap::from([(hash, data)]));
    FakeEngine::start(move |op, req| match op {
        "blobRead" => {
            if !at.exists() {
                std::fs::write(&at, NOTES).unwrap();
            }
            let blobs = blobs.lock().unwrap();
            let data = &blobs[req["hash"].as_str().unwrap()];
            let off = req["offset"].as_u64().unwrap() as usize;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data[off..]);
            json!({"ok": true, "result": {"size": data.len(), "offset": off, "data": b64}})
        }
        _ => json!({"ok": true, "result": {}}),
    })
}

#[tokio::test]
async fn a_save_keeps_a_file_of_another_kind_that_appeared_while_it_waited_on_the_engine() {
    empty_local_store();
    let data: Vec<u8> = (0..300u32).map(|i| (i * 7 % 251) as u8).collect();
    let out = tempfile::tempdir().unwrap();
    let path = out.path().join("part.funda");
    let engine = engine_writing_notes_while_asked(path.clone(), data.clone());
    let srv = FundaCad::with_link(engine.link());
    let doc = json!({"version": 5, "parameters": {}, "features": [
        {"id": "f1", "type": "import", "name": "motor", "geom": digest(&data)}
    ]});
    srv.t_doc_set(args(json!({"document": doc}))).await.unwrap();

    let r = srv.t_doc_save(args(json!({"path": path.to_string_lossy()}))).await.unwrap();
    assert!(is_error(&r), "{}", text_of(&r));
    assert_eq!(
        text_of(&r),
        format!(
            "{} already holds a file that does not read as a .funda file, so doc_save leaves it alone. Pass \
             overwrite: true to replace it, or give another path.",
            path.display()
        )
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), NOTES);
}

fn exporting(answer: impl Fn(&Path) -> Value + Send + Sync + 'static) -> FakeEngine {
    FakeEngine::start(move |op, req| match op {
        "export" => answer(Path::new(req["path"].as_str().unwrap())),
        _ => json!({"ok": true, "result": {}}),
    })
}

#[tokio::test]
async fn an_export_keeps_a_file_of_another_kind_that_appeared_while_the_engine_wrote() {
    let out = tempfile::tempdir().unwrap();
    let path = out.path().join("part.stl");
    let dest = path.clone();
    let engine = exporting(move |tmp| {
        std::fs::write(tmp, "solid part\nendsolid part\n").unwrap();
        std::fs::write(&dest, NOTES).unwrap();
        json!({"ok": true, "result": {"path": tmp.to_string_lossy()}})
    });
    let srv = FundaCad::with_link(engine.link());

    let r = srv.t_export(args(json!({"path": path.to_string_lossy(), "format": "stl"}))).await.unwrap();
    assert!(is_error(&r), "{}", text_of(&r));
    assert_eq!(
        text_of(&r),
        format!(
            "{} already holds a file that does not read as a .stl file, so export to STL leaves it alone. Pass \
             overwrite: true to replace it, or give another path.",
            path.display()
        )
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), NOTES);
    let left: Vec<String> =
        std::fs::read_dir(out.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left, vec!["part.stl".to_string()], "the engine's temporary folder is gone too");
}

#[tokio::test]
async fn a_separate_export_moves_in_only_parts_with_the_formats_extension() {
    let out = tempfile::tempdir().unwrap();
    let path = out.path().join("parts.stl");
    let engine = exporting(|tmp| {
        let base = tmp.with_extension("");
        std::fs::create_dir(&base).unwrap();
        let (good, odd) = (base.join("Box.stl"), base.join("Box.txt"));
        std::fs::write(&good, "solid Box\nendsolid Box\n").unwrap();
        std::fs::write(&odd, NOTES).unwrap();
        json!({"ok": true, "result": {"path": base.to_string_lossy(),
                                      "paths": [good.to_string_lossy(), odd.to_string_lossy()]}})
    });
    let srv = FundaCad::with_link(engine.link());

    let r =
        srv.t_export(args(json!({"path": path.to_string_lossy(), "format": "stl", "separate": true}))).await.unwrap();
    assert!(is_error(&r), "{}", text_of(&r));
    let folder = out.path().join("parts");
    assert_eq!(
        text_of(&r),
        format!(
            "{} is refused: export to STL writes only .stl files. Give a path ending in .stl. No part was written.",
            folder.join("Box.txt").display()
        )
    );
    assert!(!folder.join("Box.txt").exists() && !folder.join("Box.stl").exists());
}
