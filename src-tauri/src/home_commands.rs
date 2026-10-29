//! Home's disk commands. The work is in library.rs and thumbs.rs, off the IPC thread.

use crate::doc_paths::Provenance;
use crate::library::{list_dir, stat_all, FileStat, ListResult};
use tauri::Manager;

/// A network path no session handed over is left out, so Home shows it without a date.
#[tauri::command]
pub async fn library_stat(held: tauri::State<'_, Provenance>, paths: Vec<String>) -> Result<Vec<FileStat>, String> {
    let paths: Vec<String> = paths.into_iter().filter(|p| held.refuse_unknown(p).is_ok()).collect();
    tauri::async_runtime::spawn_blocking(move || stat_all(&paths)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn library_list(held: tauri::State<'_, Provenance>, dir: String) -> Result<ListResult, String> {
    held.refuse_unknown(&dir)?;
    tauri::async_runtime::spawn_blocking(move || list_dir(&dir)).await.map_err(|e| e.to_string())?
}

/// None for the old ZIP container, which Home asks the user to open instead.
#[tauri::command]
pub async fn doc_summary(
    held: tauri::State<'_, Provenance>,
    path: String,
) -> Result<Option<fundacad_format::summary::Summary>, String> {
    let path = held.check_home(&path)?;
    tauri::async_runtime::spawn_blocking(move || fundacad_format::summary::read_summary(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn thumbs_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("thumbs"))
}

#[tauri::command]
pub async fn thumb_get(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    let dir = thumbs_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::thumbs::get_all(&dir, &paths)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thumb_put(app: tauri::AppHandle, path: String, data_url: String) -> Result<(), String> {
    let dir = thumbs_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::thumbs::put(&dir, &path, &data_url))
        .await
        .map_err(|e| e.to_string())?
}
