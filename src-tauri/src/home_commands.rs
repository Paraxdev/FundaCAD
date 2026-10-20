//! Home's disk commands. The work is in library.rs and thumbs.rs, off the IPC thread.

use crate::library::{stat_all, FileStat};

#[tauri::command]
pub async fn library_stat(paths: Vec<String>) -> Result<Vec<FileStat>, String> {
    tauri::async_runtime::spawn_blocking(move || stat_all(&paths))
        .await
        .map_err(|e| e.to_string())
}
