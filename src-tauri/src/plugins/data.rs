//! A plugin's own small files: its settings, and the outputs it hands to
//! another program. One directory per plugin, `app_data_dir()/plugin-data/<id>`.
//!
//! Kept apart from the installed bundle on purpose. Reinstalling or updating a
//! plugin replaces its bundle directory whole, and a person's configuration must
//! survive that.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::bundle::safe_id;

const MAX_TEXT: usize = 8 * 1024 * 1024;

/// A bare file name: a letter or digit first, then letters, digits, `.`, `-`
/// and `_`. No separators, so it can only ever name a file in its own directory.
pub fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if ok {
        Ok(name)
    } else {
        Err(format!("not a file name: {name:?}"))
    }
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("no app data directory: {e}"))
}

fn data_dir(app: &AppHandle, plugin: &str) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("plugin-data").join(safe_id(plugin)?);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// The file's text, or None when the plugin has never written it.
#[tauri::command]
pub fn plugin_data_read(app: AppHandle, plugin: String, name: String) -> Result<Option<String>, String> {
    let path = data_dir(&app, &plugin)?.join(safe_name(&name)?);
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{name}: {e}")),
    }
}

/// Replace the file atomically, so a crash mid-write leaves the old one.
#[tauri::command]
pub fn plugin_data_write(app: AppHandle, plugin: String, name: String, text: String) -> Result<(), String> {
    if text.len() > MAX_TEXT {
        return Err(format!("that is {} bytes", text.len()));
    }
    let path = data_dir(&app, &plugin)?.join(safe_name(&name)?);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{name}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{name}: {e}"))
}

/// Where a file of that name goes, for output another process writes, such as
/// the geometry engine exporting into it.
#[tauri::command]
pub fn plugin_data_path(app: AppHandle, plugin: String, name: String) -> Result<String, String> {
    let path = data_dir(&app, &plugin)?.join(safe_name(&name)?);
    Ok(path.to_string_lossy().into_owned())
}

/// Move a JSON file this plugin's code kept directly under the app data
/// directory, from before plugins had a directory of their own, into its data
/// directory as `name`. Does nothing when there is no such file or `name`
/// already exists. Returns whether it moved anything.
#[tauri::command]
pub fn plugin_data_adopt(app: AppHandle, plugin: String, legacy: String, name: String) -> Result<bool, String> {
    let legacy = safe_name(&legacy)?;
    if !legacy.ends_with(".json") {
        return Err(format!("{legacy} is not a JSON file"));
    }
    let from = app_data(&app)?.join(legacy);
    let to = data_dir(&app, &plugin)?.join(safe_name(&name)?);
    if !from.is_file() || to.exists() {
        return Ok(false);
    }
    std::fs::rename(&from, &to).map_err(|e| format!("{legacy}: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_cannot_leave_their_directory() {
        assert!(safe_name("devices.json").is_ok());
        assert!(safe_name("part_1-a.3mf").is_ok());
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "..", "c:x", &"x".repeat(101)] {
            assert!(safe_name(bad).is_err(), "{bad:?}");
        }
    }
}
