//! Recently opened and saved files, newest first, kept in the settings.

use std::path::{Path, PathBuf};

use gpui::App;
use serde::{Deserialize, Serialize};

pub const SETTING: &str = "recentFiles";
pub const MAX: usize = 50;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: PathBuf,
    /// Milliseconds since the Unix epoch.
    pub opened_at: u64,
}

fn same(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

/// `list` with `path` at the top, once, and at most `MAX` entries.
pub fn noted(mut list: Vec<Recent>, path: &Path, now: u64) -> Vec<Recent> {
    list.retain(|r| !same(&r.path, path));
    list.insert(0, Recent { path: path.to_path_buf(), opened_at: now });
    list.truncate(MAX);
    list
}

pub fn forgotten(mut list: Vec<Recent>, path: &Path) -> Vec<Recent> {
    list.retain(|r| !same(&r.path, path));
    list
}

pub fn list(cx: &App) -> Vec<Recent> {
    crate::settings::get(cx, SETTING).unwrap_or_default()
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

pub fn note(cx: &mut App, path: &Path) {
    let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let list = noted(list(cx), &path, now());
    crate::settings::set(cx, SETTING, &list);
}

pub fn forget(cx: &mut App, path: &Path) {
    let list = forgotten(list(cx), path);
    crate::settings::set(cx, SETTING, &list);
}

pub fn clear(cx: &mut App) {
    crate::settings::set(cx, SETTING, &Vec::<Recent>::new());
}
