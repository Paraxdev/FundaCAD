//! The file tools reach only the folders the server was given, over stdio.

mod common;

use std::path::{Path, PathBuf};

use common::{env, Mcp};
use serde_json::json;

/// A server whose temp, blob dir and working folder are all inside `own`, so
/// the system temp the test folders live in is not one of its folders.
fn server(own: &Path, extra: &[(&str, &str)], args: &[&str]) -> Mcp {
    let tmp = own.join("tmp");
    let blobs = own.join("blobs");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::create_dir_all(&blobs).unwrap();
    let (t, b) = (tmp.to_string_lossy().into_owned(), blobs.to_string_lossy().into_owned());
    let mut pairs = vec![("TMP", t.as_str()), ("TEMP", t.as_str()), ("TMPDIR", t.as_str()), ("FUNDACAD_BLOB_DIR", b.as_str())];
    pairs.extend_from_slice(extra);
    Mcp::start_with_args(&env(&pairs), &tmp, args)
}

fn dirs() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
    let own = tempfile::Builder::new().prefix("scope-own-").tempdir().unwrap();
    let work = tempfile::Builder::new().prefix("scope-work-").tempdir().unwrap();
    let folder = work.path().join("parts");
    std::fs::create_dir_all(&folder).unwrap();
    (own, work, folder)
}

fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[test]
fn a_folder_not_given_is_refused_and_the_error_says_how_to_give_it() {
    let (own, _work, folder) = dirs();
    let mut mcp = server(own.path(), &[], &[]);
    let r = mcp.call("doc_save", json!({"path": slash(&folder.join("a.funda"))}));
    assert!(r.is_error, "{}", r.text);
    assert!(!folder.join("a.funda").exists());
    let canon = std::fs::canonicalize(&folder).unwrap();
    let canon = canon.to_string_lossy();
    let canon = canon.trim_start_matches(r"\\?\");
    assert!(r.text.contains("outside the folders"), "{}", r.text);
    assert!(r.text.contains(&format!("Allowing {canon} would")), "{}", r.text);
    assert!(r.text.contains("--allow-path") && r.text.contains("FUNDACAD_MCP_ALLOW_PATHS"), "{}", r.text);
    let r = mcp.call("doc_open", json!({"path": slash(&folder.join("a.funda"))}));
    assert!(r.is_error && r.text.contains("outside the folders"), "{}", r.text);
    let r = mcp.call("doc_import", json!({"path": slash(&folder.join("a.step"))}));
    assert!(r.is_error && r.text.contains("outside the folders"), "{}", r.text);
    let r = mcp.call("export", json!({"path": slash(&folder.join("a.stl")), "format": "stl"}));
    assert!(r.is_error && r.text.contains("outside the folders"), "{}", r.text);
}

#[test]
fn allow_path_and_the_env_list_open_a_folder_but_not_its_hidden_ones() {
    let (own, _work, folder) = dirs();
    let given = folder.to_string_lossy().into_owned();
    for (extra, args) in [
        (vec![], vec!["--allow-path", given.as_str()]),
        (vec![("FUNDACAD_MCP_ALLOW_PATHS", given.as_str())], vec![]),
    ] {
        let mut mcp = server(own.path(), &extra, &args);
        let file = folder.join("a.funda");
        let _ = std::fs::remove_file(&file);
        let r = mcp.call("doc_save", json!({"path": slash(&file)}));
        assert!(!r.is_error, "{args:?} {extra:?}: {}", r.text);
        assert!(file.exists());
        let r = mcp.call("doc_open", json!({"path": slash(&file)}));
        assert!(!r.is_error, "{}", r.text);
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        let r = mcp.call("doc_save", json!({"path": slash(&folder.join(".git").join("b.funda"))}));
        assert!(r.is_error && r.text.contains("hidden"), "{}", r.text);
        let r = mcp.call("doc_save", json!({"path": format!("{}/../escaped.funda", slash(&folder))}));
        assert!(r.is_error && r.text.contains("outside the folders"), "{}", r.text);
    }
}

#[test]
fn the_documents_folder_joins_once_it_is_saved_there() {
    let (own, _work, folder) = dirs();
    let given = folder.to_string_lossy().into_owned();
    let mut mcp = server(own.path(), &[], &["--allow-path", &given]);
    let sub = folder.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let r = mcp.call("doc_save", json!({"path": slash(&sub.join("a.funda"))}));
    assert!(!r.is_error, "{}", r.text);
    let r = mcp.call("doc_save", json!({}));
    assert!(!r.is_error, "saving again where it was opened: {}", r.text);
}

#[test]
fn the_hints_reach_the_client_in_tools_list() {
    let (own, _work, _folder) = dirs();
    let mut mcp = server(own.path(), &[], &[]);
    let tools = mcp.tools();
    let get = |name: &str| tools.iter().find(|t| t["name"] == name).cloned().unwrap();
    assert_eq!(get("inspect")["annotations"]["readOnlyHint"], json!(true));
    assert_eq!(get("doc_save")["annotations"]["readOnlyHint"], json!(false));
    assert_eq!(get("export")["annotations"]["destructiveHint"], json!(true));
    assert!(tools.iter().all(|t| t["annotations"]["openWorldHint"] == json!(false)));
}
