//! What Home learns about document files on disk: names, times and sizes,
//! never contents. Reached through home_commands.rs rather than the webview fs
//! scope, which stays narrow. No Tauri in here, so scripts/check-home-disk.sh
//! can run these tests on Windows, where the app's own test binary cannot start.

use serde::Serialize;
use std::time::UNIX_EPOCH;

/// More than Home ever shows at once (the recent list is capped at 50).
pub const STAT_CAP: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub exists: bool,
    pub mtime_ms: Option<u64>,
    pub size: Option<u64>,
}

pub fn stat_one(path: &str) -> FileStat {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => FileStat {
            path: path.to_string(),
            exists: true,
            mtime_ms: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
            size: Some(m.len()),
        },
        _ => FileStat { path: path.to_string(), exists: false, mtime_ms: None, size: None },
    }
}

pub fn stat_all(paths: &[String]) -> Vec<FileStat> {
    paths.iter().take(STAT_CAP).map(|p| stat_one(p)).collect()
}

pub const LIST_CAP: usize = 2000;
pub const LIST_DEPTH: usize = 4;
/// Not `json`: most JSON files in a project folder are not documents.
const DOC_EXTS: [&str; 4] = ["funda", "fundab", "neocad", "sindri"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListResult {
    pub files: Vec<FileStat>,
    pub truncated: bool,
}

fn is_document(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && DOC_EXTS.iter().any(|d| ext.eq_ignore_ascii_case(d)))
}

/// The documents in `dir` and its subfolders down to LIST_DEPTH, breadth first so a
/// cut at LIST_CAP keeps the shallow ones. Links are not followed and dot folders are
/// skipped (version control, sync tool state).
pub fn list_dir(dir: &str) -> Result<ListResult, String> {
    let root = std::path::PathBuf::from(dir);
    if !std::fs::metadata(&root).map_err(|e| e.to_string())?.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    let mut files = Vec::new();
    let mut level = vec![root];
    for depth in 0..=LIST_DEPTH {
        let mut next = Vec::new();
        for folder in &level {
            let Ok(read) = std::fs::read_dir(folder) else { continue };
            let mut items: Vec<_> = read.flatten().collect();
            items.sort_by_key(|e| e.file_name());
            for item in items {
                let name = item.file_name().to_string_lossy().into_owned();
                let Ok(meta) = std::fs::symlink_metadata(item.path()) else { continue };
                if meta.is_dir() {
                    if depth < LIST_DEPTH && !name.starts_with('.') {
                        next.push(item.path());
                    }
                } else if meta.is_file() && is_document(&name) {
                    if files.len() == LIST_CAP {
                        return Ok(ListResult { files, truncated: true });
                    }
                    files.push(stat_one(&item.path().to_string_lossy()));
                }
            }
        }
        level = next;
    }
    Ok(ListResult { files, truncated: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fundacad-library-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_existing_file_has_its_time_and_size() {
        let dir = temp_dir("stat");
        let file = dir.join("a.funda");
        std::fs::write(&file, b"{}").unwrap();
        let st = stat_one(file.to_str().unwrap());
        assert!(st.exists);
        assert_eq!(st.size, Some(2));
        assert!(st.mtime_ms.unwrap() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_or_a_folder_does_not_exist() {
        let dir = temp_dir("missing");
        let gone = stat_one(dir.join("gone.funda").to_str().unwrap());
        assert_eq!(gone, FileStat { path: gone.path.clone(), exists: false, mtime_ms: None, size: None });
        assert!(!stat_one(dir.to_str().unwrap()).exists);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_batch_is_capped_and_keeps_order() {
        let paths: Vec<String> = (0..STAT_CAP + 20).map(|i| format!("Z:/nowhere/{i}.funda")).collect();
        let out = stat_all(&paths);
        assert_eq!(out.len(), STAT_CAP);
        assert_eq!(out[3].path, "Z:/nowhere/3.funda");
    }

    fn names(r: &ListResult, root: &std::path::Path) -> Vec<String> {
        r.files
            .iter()
            .map(|f| {
                std::path::Path::new(&f.path).strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn a_folder_lists_its_documents_and_those_of_its_subfolders() {
        let dir = temp_dir("list");
        for f in ["a.funda", "b.FUNDAB", "c.neocad", "d.sindri", "notes.json", "e.stl", ".funda", "sub/f.funda"] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"{}").unwrap();
        }
        std::fs::create_dir_all(dir.join("x.funda")).unwrap();
        let r = list_dir(dir.to_str().unwrap()).unwrap();
        assert_eq!(names(&r, &dir), ["a.funda", "b.FUNDAB", "c.neocad", "d.sindri", "sub/f.funda"]);
        assert!(!r.truncated);
        assert!(r.files.iter().all(|f| f.exists && f.size == Some(2)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn listing_stops_at_the_depth_limit_and_skips_dot_folders() {
        let dir = temp_dir("deep");
        let mut p = dir.clone();
        for level in 0..=LIST_DEPTH + 1 {
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join(format!("l{level}.funda")), b"{}").unwrap();
            p = p.join("d");
        }
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/hidden.funda"), b"{}").unwrap();
        let r = list_dir(dir.to_str().unwrap()).unwrap();
        let got = names(&r, &dir);
        assert_eq!(got.len(), LIST_DEPTH + 1);
        assert!(got.iter().all(|n| !n.contains("hidden")));
        assert!(got.last().unwrap().ends_with(&format!("l{LIST_DEPTH}.funda")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_listing_is_capped_and_says_so() {
        let dir = temp_dir("cap");
        for i in 0..LIST_CAP + 3 {
            std::fs::write(dir.join(format!("{i:05}.funda")), b"").unwrap();
        }
        let r = list_dir(dir.to_str().unwrap()).unwrap();
        assert_eq!(r.files.len(), LIST_CAP);
        assert!(r.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_or_a_file_is_an_error() {
        let dir = temp_dir("nofolder");
        std::fs::write(dir.join("a.funda"), b"").unwrap();
        assert!(list_dir(dir.join("gone").to_str().unwrap()).is_err());
        assert!(list_dir(dir.join("a.funda").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn it_serialises_as_the_webview_reads_it() {
        let st = FileStat { path: "a".into(), exists: true, mtime_ms: Some(5), size: Some(1) };
        assert_eq!(serde_json::to_string(&st).unwrap(), r#"{"path":"a","exists":true,"mtimeMs":5,"size":1}"#);
    }
}
