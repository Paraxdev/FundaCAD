//! Over stdio: doc_save writes only .funda files, and export only files of the chosen format.

mod common;

use std::path::{Path, PathBuf};

use common::{env, Mcp};
use serde_json::json;

fn server(own: &Path, cwd: &Path) -> Mcp {
    let tmp = own.join("tmp");
    let blobs = own.join("blobs");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::create_dir_all(&blobs).unwrap();
    let (t, b) = (tmp.to_string_lossy().into_owned(), blobs.to_string_lossy().into_owned());
    let pairs = [("TMP", t.as_str()), ("TEMP", t.as_str()), ("TMPDIR", t.as_str()), ("FUNDACAD_BLOB_DIR", b.as_str())];
    Mcp::start_with_args(&env(&pairs), cwd, &[])
}

fn dirs() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
    let own = tempfile::Builder::new().prefix("writes-own-").tempdir().unwrap();
    let work = tempfile::Builder::new().prefix("writes-work-").tempdir().unwrap();
    let folder = work.path().join("parts");
    std::fs::create_dir_all(&folder).unwrap();
    (own, work, folder)
}

fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(folder).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn link_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link).is_ok();
    #[cfg(windows)]
    return std::os::windows::fs::symlink_file(target, link).is_ok();
}

#[test]
fn doc_save_writes_only_funda_files() {
    let (own, _work, folder) = dirs();
    let mut mcp = server(own.path(), &folder);
    for name in ["a.txt", "a.cmd", "a", "a.funda.bat", "a.cmd.", "a.cmd ", "a.json"] {
        let r = mcp.call("doc_save", json!({"path": slash(&folder.join(name))}));
        assert!(r.is_error, "{name:?}: {}", r.text);
        assert!(r.text.contains("only .funda files"), "{name:?}: {}", r.text);
    }
    assert!(names_in(&folder).is_empty(), "{:?}", names_in(&folder));
    let r = mcp.call("doc_save", json!({"path": "rel.txt"}));
    assert!(r.is_error && r.text.contains("only .funda files"), "{}", r.text);
    let upper = folder.join("b.FUNDA");
    let r = mcp.call("doc_save", json!({"path": slash(&upper)}));
    assert!(!r.is_error, "{}", r.text);
    assert!(upper.exists());
    let r = mcp.call("doc_save", json!({}));
    assert!(!r.is_error, "saving again to the path it was saved to: {}", r.text);
    let binary = folder.join("c.fundab");
    let r = mcp.call("doc_save", json!({"path": slash(&binary)}));
    assert!(r.is_error && r.text.contains("Save As .fundab"), "{}", r.text);
    assert!(!binary.exists());
}

#[test]
fn doc_save_refuses_a_funda_name_that_leads_to_another_kind_of_file() {
    let (own, _work, folder) = dirs();
    let notes = folder.join("notes.txt");
    std::fs::write(&notes, "keep me").unwrap();
    let link = folder.join("x.funda");
    if !link_file(&notes, &link) {
        eprintln!("this account cannot make links, skipped");
        return;
    }
    let mut mcp = server(own.path(), &folder);
    let r = mcp.call("doc_save", json!({"path": slash(&link)}));
    assert!(r.is_error && r.text.contains("only .funda files"), "{}", r.text);
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "keep me");
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
}
