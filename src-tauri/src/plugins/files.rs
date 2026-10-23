//! The ops a plugin cannot serve itself: picking, reading and writing files the person chooses, and the app info. A
//! path never leaves, a plugin gets a handle (rules in ./handed.rs). Grants are checked by the broker in
//! src/plugins/broker/, not here, and a dismissed dialog is `None`, not an error.

use base64::Engine;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::bundle::{now_secs, safe_id};
use super::handed::{clean_extensions, dialog_title, name_of, suggested_name, Table};

/// A plugin is source and documents are small. Anything past this is not a
/// thing to hand a plugin in one message across an IPC boundary.
const MAX_FILE: u64 = 32 * 1024 * 1024;

/// The files handed out this session, behind the lock Tauri state needs.
#[derive(Default)]
pub struct Handles(Mutex<Table>);

impl Handles {
    /// The path behind a handle this plugin was given, for another command that
    /// takes a handle in place of a path.
    pub(crate) fn path_for(&self, plugin: &str, handle: &str) -> Result<std::path::PathBuf, String> {
        self.0
            .lock()
            .map_err(|_| POISONED.to_string())?
            .path_for(plugin, handle)
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "that file was not offered to this plugin".to_string())
    }
}

/// What a plugin gets back for a file it may now read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub handle: String,
    /// The file name only, never the directory. See `handed::name_of`.
    pub name: String,
    pub len: u64,
}

/// Text for text formats, base64 for binary. Exactly one is set, so which arrived is never a guess.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBody {
    pub name: String,
    pub len: u64,
    pub text: Option<String>,
    pub base64: Option<String>,
}

/// What was written, for a plugin that wants to say so.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wrote {
    pub name: String,
    pub len: u64,
}

/// The app around a plugin, for a plugin that has to adapt to it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
}

/// Random rather than a counter, so a plugin cannot name a file it was never offered by guessing the next handle.
fn token() -> Result<String, String> {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).map_err(|e| format!("no randomness available: {e}"))?;
    let mut out = String::with_capacity(32);
    for b in raw {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

const POISONED: &str = "the file handles could not be read";

/// Ask the person for a file, and remember that they said yes.
#[tauri::command]
pub async fn plugin_file_pick(
    app: AppHandle,
    handles: State<'_, Handles>,
    plugin: String,
    purpose: String,
    extensions: Vec<String>,
) -> Result<Option<Picked>, String> {
    let plugin = safe_id(&plugin)?.to_string();
    let title = dialog_title(&plugin, &purpose, "Choose a file for");

    let mut dialog = app.dialog().file().set_title(&title);
    let exts = clean_extensions(&extensions);
    if !exts.is_empty() {
        let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        dialog = dialog.add_filter("Files", &refs);
    }

    // The blocking dialog APIs deadlock on the main thread, so this command stays async though nothing is awaited.
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| format!("that file has no readable path: {e}"))?;

    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", name_of(&path)))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", name_of(&path)));
    }

    let handle = token()?;
    let name = name_of(&path);
    let len = meta.len();
    handles.0.lock().map_err(|_| POISONED.to_string())?.remember(handle.clone(), plugin, path, now_secs());
    Ok(Some(Picked { handle, name, len }))
}

/// Takes a handle, never a path, so it reaches only files somebody chose, and only for the plugin named on the handle.
#[tauri::command]
pub fn plugin_file_read(handles: State<'_, Handles>, plugin: String, handle: String) -> Result<FileBody, String> {
    let plugin = safe_id(&plugin)?;
    let path = handles
        .0
        .lock()
        .map_err(|_| POISONED.to_string())?
        .path_for(plugin, &handle)
        .ok_or("that file was not offered to this plugin")?
        .to_path_buf();

    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", name_of(&path)))?;
    // Re-checked at read rather than trusted from the pick: the file may have
    // grown since, and the length that matters is the one about to cross IPC.
    if meta.len() > MAX_FILE {
        return Err(format!("{} is {} bytes", name_of(&path), meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", name_of(&path)))?;
    let len = bytes.len() as u64;
    let name = name_of(&path);

    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileBody { name, len, text: Some(text), base64: None }),
        Err(e) => Ok(FileBody {
            name,
            len,
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(e.as_bytes())),
        }),
    }
}

/// Asks where to put something and puts it there. There is no write handle, so writing twice to one place asks twice.
#[tauri::command]
pub async fn plugin_file_write(
    app: AppHandle,
    plugin: String,
    purpose: String,
    suggested: String,
    text: Option<String>,
    base64_body: Option<String>,
) -> Result<Option<Wrote>, String> {
    let plugin = safe_id(&plugin)?.to_string();

    // Decoded BEFORE the dialog. A plugin that sent nonsense should find out
    // without a person being asked to choose a filename for it first.
    let bytes: Vec<u8> = match (text, base64_body) {
        (Some(t), None) => t.into_bytes(),
        (None, Some(b)) => base64::engine::general_purpose::STANDARD
            .decode(b.as_bytes())
            .map_err(|e| format!("that is not base64: {e}"))?,
        (Some(_), Some(_)) => return Err("pass text or base64, not both".into()),
        (None, None) => return Err("nothing to write".into()),
    };
    if bytes.len() as u64 > MAX_FILE {
        return Err(format!("that is {} bytes", bytes.len()));
    }

    let title = dialog_title(&plugin, &purpose, "Save a file from");
    let mut dialog = app.dialog().file().set_title(&title);
    if let Some(name) = suggested_name(&suggested) {
        dialog = dialog.set_file_name(&name);
    }

    let Some(target) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = target.into_path().map_err(|e| format!("that location has no writable path: {e}"))?;

    std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", name_of(&path)))?;
    Ok(Some(Wrote { name: name_of(&path), len: bytes.len() as u64 }))
}

/// No grant needed: a plugin has to know which version it runs on, and none of this says anything about the person.
#[tauri::command]
pub fn plugin_app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}
