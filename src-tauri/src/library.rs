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

    #[test]
    fn it_serialises_as_the_webview_reads_it() {
        let st = FileStat { path: "a".into(), exists: true, mtime_ms: Some(5), size: Some(1) };
        assert_eq!(serde_json::to_string(&st).unwrap(), r#"{"path":"a","exists":true,"mtimeMs":5,"size":1}"#);
    }
}
