//! The server runs from a copy of its executable, so a build can replace the original. On by default
//! on Windows only; `FUNDACAD_MCP_SHADOW=1` turns it on here.

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use common::{engine_binary, mcp_binary, Mcp};
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
    let mut mcp = shadowed(tmp.path(), &[("FUNDACAD_ENGINE_CMD", engine_binary().to_string_lossy().into_owned())]);
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
    assert!(!second.log().contains("running in place"), "{}", second.log());
}

#[test]
fn a_copy_whose_bytes_differ_from_the_build_is_made_again() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let exe = mcp_binary();
    let meta = std::fs::metadata(&exe).expect("the server binary");
    let stamp =
        meta.modified().expect("an mtime").duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_millis();
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let dir = tmp.path().join("fundacad-mcp-shadow");
    std::fs::create_dir_all(&dir).expect("the shadow dir");
    let planted = dir.join(format!("fundacad-mcp-{}-{stamp}{ext}", meta.len()));
    std::fs::write(&planted, vec![0u8; meta.len() as usize]).expect("a same size file");
    let mut mcp = shadowed(tmp.path(), &[("FUNDACAD_ENGINE_CMD", engine_binary().to_string_lossy().into_owned())]);
    let reply = mcp.call("schema", json!({"type": "box"}));
    assert!(!reply.is_error, "{}", reply.text);
    let copy = std::fs::read(&planted).expect("the copy");
    assert!(copy == std::fs::read(&exe).expect("the server binary"), "the copy holds the build's bytes");
}

fn engine_copy(tmp: &Path) -> std::path::PathBuf {
    let names = copies(tmp, "fundacad-engine");
    assert_eq!(names.len(), 1, "one copy of the engine: {names:?}");
    tmp.join("fundacad-mcp-shadow").join(&names[0])
}

#[cfg(windows)]
#[test]
fn the_copies_cannot_be_changed_while_the_server_runs() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let mut mcp = shadowed(tmp.path(), &[]);
    assert!(!mcp.call("schema", json!({})).is_error);
    let copy = engine_copy(tmp.path());
    assert!(std::fs::OpenOptions::new().append(true).open(&copy).is_err(), "the engine copy opens for writing");
    assert!(std::fs::rename(&copy, copy.with_extension("moved")).is_err(), "the engine copy can be moved");
    let r = mcp.call("feature_add", json!({"feature": {"type": "box", "length": 10, "width": 10, "height": 10}}));
    assert!(!r.is_error, "{}", r.text);
    let built = mcp.call("build", json!({}));
    assert!(!built.is_error && built.text.contains("body1"), "{}", built.text);
}

fn link_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("a link");
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("cmd runs");
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
    }
}

#[test]
fn a_shadow_folder_that_is_a_link_is_not_used() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).expect("a folder");
    link_dir(&elsewhere, &tmp.path().join("fundacad-mcp-shadow"));
    let mut mcp = shadowed(tmp.path(), &[("FUNDACAD_ENGINE_CMD", engine_binary().to_string_lossy().into_owned())]);
    let reply = mcp.call("schema", json!({"type": "box"}));
    assert!(!reply.is_error, "{}", reply.text);
    let inside: Vec<_> = std::fs::read_dir(&elsewhere).expect("the folder").flatten().map(|e| e.file_name()).collect();
    assert!(inside.is_empty(), "{inside:?}");
    assert!(mcp.log().contains("running in place"), "{}", mcp.log());
}

#[cfg(unix)]
#[test]
fn a_shadow_folder_others_can_write_to_is_not_used() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().expect("a temp dir");
    let shared = tmp.path().join("fundacad-mcp-shadow");
    std::fs::create_dir(&shared).expect("a folder");
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).expect("open to all");
    let mut mcp = shadowed(tmp.path(), &[("FUNDACAD_ENGINE_CMD", engine_binary().to_string_lossy().into_owned())]);
    let reply = mcp.call("schema", json!({"type": "box"}));
    assert!(!reply.is_error, "{}", reply.text);
    assert!(copies(tmp.path(), "fundacad-mcp").is_empty(), "{:?}", copies(tmp.path(), "fundacad-mcp"));
    assert!(mcp.log().contains("running in place"), "{}", mcp.log());
}
