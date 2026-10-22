//! What Home learns about documents on disk: names, times and sizes, never contents. Tauri free so
//! scripts/check-home-disk.sh can run its tests (tests/unit/library.rs) without the webview stack.

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
            mtime_ms: m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
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

pub(crate) fn is_document(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && DOC_EXTS.iter().any(|d| ext.eq_ignore_ascii_case(d)))
}

/// Breadth first down to LIST_DEPTH, so a cut at LIST_CAP keeps the shallow ones. Links are not followed and dot
/// folders (version control, sync state) are skipped.
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
