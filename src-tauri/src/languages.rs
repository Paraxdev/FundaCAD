//! Own language files in `app_data_dir()/languages/<code>.json`. Each one is untrusted text: the page checks every
//! line, this side only guards the read.

use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

pub const MAX_BYTES: u64 = 256 * 1024;
const MAX_FILES: usize = 100;

/// The page's `LANGUAGE_CODE`, `^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$`. It admits no separator or dot,
/// so a code only ever names a file in the folder.
pub fn is_language_code(code: &str) -> bool {
    let mut parts = code.split('-').map(str::as_bytes);
    let language = parts.next().is_some_and(|l| matches!(l.len(), 2 | 3) && l.iter().all(u8::is_ascii_lowercase));
    let script = |s: &[u8]| s.len() == 4 && s[0].is_ascii_uppercase() && s[1..].iter().all(u8::is_ascii_lowercase);
    let region = |r: &[u8]| match r.len() {
        2 => r.iter().all(u8::is_ascii_uppercase),
        3 => r.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    let mut next = parts.next();
    if next.is_some_and(script) {
        next = parts.next();
    }
    if next.is_some_and(region) {
        next = parts.next();
    }
    language && next.is_none()
}

/// The codes of the `<code>.json` plain files in `dir`, sorted, at most 100. A `dir` that is a link reads as empty.
pub fn list(dir: &Path) -> Vec<String> {
    if !is_plain_dir(dir) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut codes: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name();
            let code = name.to_str()?.strip_suffix(".json")?;
            is_language_code(code).then(|| code.to_owned())
        })
        .collect();
    codes.sort();
    codes.truncate(MAX_FILES);
    codes
}

/// The text of `<code>.json` in `dir`, `None` when there is none. The code is checked before the disk is touched.
pub fn read(dir: &Path, code: &str) -> Result<Option<String>, String> {
    if !is_language_code(code) {
        return Err(format!("not a language code: {code:?}"));
    }
    if !is_plain_dir(dir) {
        return Ok(None);
    }
    let name = format!("{code}.json");
    let file = match open_no_link(&dir.join(&name)) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{name}: {e}")),
    };
    let meta = file.metadata().map_err(|e| format!("{name}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{name} is not a plain file"));
    }
    let too_large = || format!("{name} is over 256 KiB");
    if meta.len() > MAX_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    (&file).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("{name}: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(too_large());
    }
    String::from_utf8(bytes).map(Some).map_err(|_| format!("{name} is not UTF-8 text"))
}

/// Creates `dir` when it is missing. A link or a file in its place is refused, so Open folder never shows another one.
pub fn folder(dir: &Path) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("{}: {e}", dir.display());
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(format!("{} is a link or a file, not a folder", dir.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir_all(dir).map_err(failed),
        Err(e) => Err(failed(e)),
    }
}

fn is_plain_dir(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir())
}

/// A link opens as itself, never as the file it points to, which closes the race a `symlink_metadata` check leaves.
fn open_no_link(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    // O_NONBLOCK, so a FIFO named like a language file fails the plain file check instead of waiting for a writer.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW | libc::O_NONBLOCK);
    // FILE_FLAG_OPEN_REPARSE_POINT
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(&mut options, 0x0020_0000);
    options.open(path)
}

fn languages_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| format!("no app data directory: {e}"))?;
    Ok(data.join("languages"))
}

// Async so a slow disk holds a runtime thread, never the window's main thread. Safe mode reads no own file.
#[tauri::command]
pub async fn language_files_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, String> {
    if crate::safe_mode_active(&app) {
        return Ok(Vec::new());
    }
    Ok(list(&languages_dir(&app)?))
}

#[tauri::command]
pub async fn language_file_read<R: Runtime>(app: AppHandle<R>, code: String) -> Result<Option<String>, String> {
    if crate::safe_mode_active(&app) {
        return Ok(None);
    }
    read(&languages_dir(&app)?, &code)
}

#[tauri::command]
pub async fn language_folder_open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if crate::safe_mode_active(&app) {
        return Ok(());
    }
    let dir = languages_dir(&app)?;
    folder(&dir)?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| format!("{}: {e}", dir.display()))
}

#[cfg(test)]
#[path = "languages_tests.rs"]
mod tests;
