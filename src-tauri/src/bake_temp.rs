//! Where Insert and Update of a linked document write the source's STEP before reading it back: a directory under the
//! app's cache that only this user can open, one fresh name per bake, removed once read. A file a crash left there is
//! swept by the next bake once it is older than BAKE_LIFETIME.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

pub const BAKE_LIFETIME: Duration = Duration::from_secs(60 * 60);
const PREFIX: &str = "insert-";
const SUFFIX: &str = ".step";

pub fn bake_dir(cache: &Path) -> PathBuf {
    cache.join("bakes")
}

fn is_bake_name(name: &str) -> bool {
    name.strip_prefix(PREFIX)
        .and_then(|rest| rest.strip_suffix(SUFFIX))
        .is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Removes the bakes in `dir` last written before `now - BAKE_LIFETIME`, and nothing else.
pub fn sweep(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(is_bake_name) {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .is_some_and(|t| t + BAKE_LIFETIME < now);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub fn fresh_path(dir: &Path) -> Result<PathBuf, String> {
    private_dir(dir)?;
    sweep(dir, SystemTime::now());
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).map_err(|e| format!("no randomness available: {e}"))?;
    let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    Ok(dir.join(format!("{PREFIX}{hex}{SUFFIX}")))
}

/// Removes one bake that `fresh_path` named in `dir`; any other path is refused, and one already gone is fine.
pub fn remove(dir: &Path, raw: &str) -> Result<(), String> {
    let path = Path::new(raw);
    let named = path.file_name().and_then(|n| n.to_str()).is_some_and(is_bake_name);
    if !named || path.parent() != Some(dir) {
        return Err(format!("{raw} is not a linked document bake, so it was not removed."));
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{raw}: {e}")),
    }
}

fn app_bake_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bake_dir(&app.path().app_cache_dir().map_err(|e| e.to_string())?))
}

#[tauri::command]
pub fn bake_temp_path(app: AppHandle) -> Result<String, String> {
    Ok(fresh_path(&app_bake_dir(&app)?)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn bake_temp_remove(app: AppHandle, path: String) -> Result<(), String> {
    remove(&app_bake_dir(&app)?, &path)
}

#[cfg(test)]
#[path = "bake_temp_tests.rs"]
mod tests;
