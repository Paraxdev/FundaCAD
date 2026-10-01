//! The server runs from a copy of its executable, so a build can replace the
//! original while a host holds the server open. On by default on Windows only,
//! where a running executable cannot be overwritten; `FUNDACAD_MCP_SHADOW=1`
//! turns it on here.

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use common::{engine_binary, Mcp};
use serde_json::json;

fn copies(tmp: &Path, stem: &str) -> Vec<String> {
    std::fs::read_dir(tmp.join("fundacad-mcp-shadow"))
        .map(|d| {
            d.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with(&format!("{stem}-")) && !n.ends_with(".partial"))
                .collect()
        })
        .unwrap_or_default()
}

fn shadowed(tmp: &Path, extra: &[(&str, String)]) -> Mcp {
    let mut env = BTreeMap::new();
    env.insert("FUNDACAD_MCP_SHADOW".to_string(), "1".to_string());
    env.insert("FUNDACAD_MCP_MODE".to_string(), "standalone".to_string());
    // Where std::env::temp_dir() points the child, and with it the copies.
    env.insert("TMPDIR".to_string(), tmp.to_string_lossy().into_owned());
    env.insert("TEMP".to_string(), tmp.to_string_lossy().into_owned());
    env.insert("TMP".to_string(), tmp.to_string_lossy().into_owned());
    for (k, v) in extra {
        env.insert((*k).to_string(), v.clone());
    }
    Mcp::start(&env, tmp)
}

#[test]
fn the_server_answers_from_a_copy_of_itself() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let mut mcp = shadowed(
        tmp.path(),
        &[("FUNDACAD_ENGINE_CMD", engine_binary().to_string_lossy().into_owned())],
    );
    let reply = mcp.call("schema", json!({"type": "box"}));
    assert!(!reply.is_error && reply.text.contains("CENTRED ON THE ORIGIN"), "{}", reply.text);
    assert_eq!(copies(tmp.path(), "fundacad-mcp").len(), 1, "one copy of the server");
    // The override names the engine outright, so it is left alone, not copied.
    assert!(copies(tmp.path(), "fundacad-engine").is_empty());
}

#[test]
fn the_engine_it_finds_runs_from_a_copy_too() {
    // Found beside the server, the engine would hold the build's file open the
    // same way, so it is copied and the server's copy is pointed at it.
    let tmp = tempfile::tempdir().expect("a temp dir");
    let mut mcp = shadowed(tmp.path(), &[]);
    let r = mcp.call("feature_add", json!({"feature": {"type": "box", "length": 10, "width": 10, "height": 10}}));
    assert!(!r.is_error, "{}", r.text);
    let built = mcp.call("build", json!({}));
    assert!(!built.is_error && built.text.contains("body1"), "{}", built.text);
    assert_eq!(copies(tmp.path(), "fundacad-engine").len(), 1, "one copy of the engine");
}

#[test]
fn a_second_server_reuses_the_copy_of_an_unchanged_build() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let engine = [("FUNDACAD_ENGINE_CMD", engine_binary().to_string_lossy().into_owned())];
    let mut first = shadowed(tmp.path(), &engine);
    let mut second = shadowed(tmp.path(), &engine);
    assert!(!first.call("schema", json!({})).is_error);
    assert!(!second.call("schema", json!({})).is_error);
    assert_eq!(copies(tmp.path(), "fundacad-mcp").len(), 1);
}
