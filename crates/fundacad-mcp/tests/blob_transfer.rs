//! Imported geometry reaching a saved file, and an opened file's geometry
//! reaching the engine, when this process and the engine do not share a blob
//! store. The engine is a stub that holds its blobs in memory, which is the
//! point: nothing it has is on any disk this process looks at.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use blake2::digest::{Update, VariableOutput};
use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

fn digest(data: &[u8]) -> String {
    let mut h = blake2::Blake2bVar::new(16).unwrap();
    h.update(data);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).unwrap();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn geometry(seed: u32) -> Vec<u8> {
    (0..1000u32).map(|i| (i * 13 % 251 + seed) as u8).collect()
}

/// This process's own store, never the user's, and one per test binary since
/// the variable is the process's. Only the open test writes to it, with a blob
/// no other test uses, so for the rest every blob has to come through the socket.
fn empty_local_store() {
    static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let dir = DIR.get_or_init(|| tempfile::tempdir().unwrap());
    std::env::set_var("FUNDACAD_BLOB_DIR", dir.path());
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

/// An engine whose blobs live in `held`, handed out ten bytes at a time so a
/// blob takes several reads, and which keeps whatever `blobWrite` gives it.
fn engine_holding(held: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> FakeEngine {
    FakeEngine::start(move |op, req| {
        let mut held = held.lock().unwrap();
        match op {
            "blobRead" => {
                let h = req["hash"].as_str().unwrap();
                let Some(data) = held.get(h) else {
                    return json!({"ok": true, "result": {"missing": true}});
                };
                let off = req["offset"].as_u64().unwrap() as usize;
                let end = (off + 10).min(data.len());
                json!({"ok": true, "result": {"size": data.len(), "offset": off,
                                              "data": b64(&data[off..end])}})
            }
            "blobHas" => {
                let (have, missing): (Vec<Value>, Vec<Value>) = req["hashes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned()
                    .partition(|h| held.contains_key(h.as_str().unwrap()));
                json!({"ok": true, "result": {"have": have, "missing": missing}})
            }
            "blobWrite" => {
                let h = req["hash"].as_str().unwrap().to_string();
                let piece = base64::engine::general_purpose::STANDARD
                    .decode(req["data"].as_str().unwrap())
                    .unwrap();
                let entry = held.entry(h).or_default();
                entry.extend_from_slice(&piece);
                let done = entry.len() as u64 == req["total"].as_u64().unwrap();
                json!({"ok": true, "result": {"stored": done}})
            }
            _ => json!({"ok": false, "error": {"message": format!("unexpected op {op}")}}),
        }
    })
}

fn import_doc(h: &str) -> Value {
    json!({"version": 5, "parameters": {}, "features": [
        {"id": "f1", "type": "import", "name": "motor", "geom": h}
    ]})
}

fn a_path(dir: &tempfile::TempDir, name: &str) -> PathBuf {
    dir.path().join(name)
}

#[tokio::test]
async fn a_save_takes_the_geometry_from_the_engine_that_holds_it() {
    empty_local_store();
    let data = geometry(0);
    let h = digest(&data);
    let held = Arc::new(Mutex::new(HashMap::from([(h.clone(), data.clone())])));
    let engine = engine_holding(held);
    let srv = FundaCad::with_link(engine.link());
    srv.t_doc_set(args(json!({"document": import_doc(&h)}))).await.unwrap();

    let out = tempfile::tempdir().unwrap();
    let path = a_path(&out, "part.funda");
    let r = srv
        .t_doc_save(args(json!({"path": path.to_string_lossy()})))
        .await
        .unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["geometry"][&h], json!(b64(&data)));
    assert!(engine.ops().iter().filter(|o| *o == "blobRead").count() > 1);
}

#[tokio::test]
async fn a_save_is_refused_only_when_nobody_has_the_geometry_and_says_what_to_do() {
    empty_local_store();
    let h = digest(&geometry(0));
    let engine = engine_holding(Arc::new(Mutex::new(HashMap::new())));
    let srv = FundaCad::with_link(engine.link());
    srv.t_doc_set(args(json!({"document": import_doc(&h)}))).await.unwrap();

    let out = tempfile::tempdir().unwrap();
    let path = a_path(&out, "part.funda");
    let r = srv
        .t_doc_save(args(json!({"path": path.to_string_lossy()})))
        .await
        .unwrap();
    assert!(is_error(&r));
    let text = text_of(&r);
    assert!(text.contains("f1 'motor'"), "{text}");
    assert!(text.contains("doc_import"), "{text}");
    assert!(!path.exists());
}

#[tokio::test]
async fn bytes_from_the_engine_that_do_not_match_their_hash_are_not_saved() {
    empty_local_store();
    let h = digest(&geometry(0));
    let held = Arc::new(Mutex::new(HashMap::from([(h.clone(), b"not it".to_vec())])));
    let srv = FundaCad::with_link(engine_holding(held).link());
    srv.t_doc_set(args(json!({"document": import_doc(&h)}))).await.unwrap();

    let out = tempfile::tempdir().unwrap();
    let path = a_path(&out, "part.funda");
    let r = srv
        .t_doc_save(args(json!({"path": path.to_string_lossy()})))
        .await
        .unwrap();
    assert!(is_error(&r), "{}", text_of(&r));
    assert!(!path.exists());
}

#[tokio::test]
async fn opening_a_file_hands_its_geometry_to_the_engine() {
    empty_local_store();
    let data = geometry(1);
    let h = digest(&data);
    let mut doc = import_doc(&h);
    doc["geometry"] = json!({h.clone(): b64(&data)});
    let dir = tempfile::tempdir().unwrap();
    let path = a_path(&dir, "part.funda");
    std::fs::write(&path, doc.to_string()).unwrap();

    let held = Arc::new(Mutex::new(HashMap::new()));
    let engine = engine_holding(held.clone());
    let srv = FundaCad::with_link(engine.link());
    let r = srv
        .t_doc_open(args(json!({"path": path.to_string_lossy()})))
        .await
        .unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    assert_eq!(held.lock().unwrap().get(&h), Some(&data));

    let again = FundaCad::with_link(engine.link());
    let before = engine.ops().len();
    again
        .t_doc_open(args(json!({"path": path.to_string_lossy()})))
        .await
        .unwrap();
    assert_eq!(
        engine.ops()[before..],
        ["blobHas".to_string()],
        "a blob the engine already has is sent again"
    );
}
