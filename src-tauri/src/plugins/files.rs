//! The ops a plugin cannot serve itself: asking the person for a file, reading
//! the one they chose, writing one where they say, and asking what it is
//! running on.
//!
//! WHY THESE ARE HERE. Not because the webview is untrusted — it is the app —
//! but because this is where the paths and the dialogs are, and the useful
//! property is that a path never leaves. What a plugin gets back is a handle, a
//! file name and a length; to read the file it hands the handle back. The rules
//! about handles, names and titles are all in ./handed.rs, which is written
//! without Tauri so it can actually be run by a test.
//!
//! WHAT THIS DOES NOT DO is decide whether the plugin was allowed to ask. That
//! is the broker, in src/plugins/broker/, against the grants recorded at
//! install; this side knows nothing about `files.read` and must not learn, for
//! the same reason the installer next door knows nothing about
//! `document.write`. Two places that both understand a permission are two
//! places that can come to understand it differently.
//!
//! THE DIALOG IS THE LAST WORD REGARDLESS. Every one of these opens a native
//! picker and does nothing at all if it is dismissed, so a plugin holding every
//! grant in the vocabulary still cannot touch a file nobody chose. A dismissed
//! dialog is `None` and not an error: "I would rather not" is a complete
//! answer, and a plugin that reported it as a failure would show somebody an
//! error for having changed their mind.

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

/// What a plugin gets back for a file it may now read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub handle: String,
    /// The file name only, never the directory. See `handed::name_of`.
    pub name: String,
    pub len: u64,
}

/// A file's contents, as whichever of the two a plugin can actually use.
///
/// Both fields rather than always base64: a plugin reading JSON, CSV, SVG, a
/// STEP file or G-code wants text, and making every one of them decode base64
/// would be a worse API for the common case. Binary (STL, 3MF) still works, and
/// which one arrived is not a guess, because exactly one is ever set.
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

/// A handle nobody can guess.
///
/// Random rather than a counter, because a counter would let a plugin name a
/// file it was never offered by asking for the handle next to its own. The
/// per-plugin check in `Table::path_for` would still refuse it, but a guard
/// that only works because of a second guard is one guard.
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

    // Blocking, from an `async` command, which Tauri runs off the main thread.
    // The blocking dialog APIs deadlock when called ON the main thread, so this
    // command must stay async even though nothing in it is awaited.
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("that file has no readable path: {e}"))?;

    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", name_of(&path)))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", name_of(&path)));
    }

    let handle = token()?;
    let name = name_of(&path);
    let len = meta.len();
    handles
        .0
        .lock()
        .map_err(|_| POISONED.to_string())?
        .remember(handle.clone(), plugin, path, now_secs());
    Ok(Some(Picked { handle, name, len }))
}

/// Read a file the person already picked for this plugin.
///
/// NOT a file reader. It takes a handle, never a path, so the set of files it
/// can reach is exactly the set somebody chose, and the plugin named on the
/// handle has to be the plugin asking.
#[tauri::command]
pub fn plugin_file_read(
    handles: State<'_, Handles>,
    plugin: String,
    handle: String,
) -> Result<FileBody, String> {
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
        Ok(text) => Ok(FileBody {
            name,
            len,
            text: Some(text),
            base64: None,
        }),
        Err(e) => Ok(FileBody {
            name,
            len,
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(e.as_bytes())),
        }),
    }
}

/// Ask the person where to put something, and put it there.
///
/// There is no handle for writing and no way to write twice to one place
/// without asking again, which is the difference between "save this file" and
/// "may I write to your disk".
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
    let path = target
        .into_path()
        .map_err(|e| format!("that location has no writable path: {e}"))?;

    std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", name_of(&path)))?;
    Ok(Some(Wrote {
        name: name_of(&path),
        len: bytes.len() as u64,
    }))
}

/// What build of what app, on what machine.
///
/// No grant, and the argument is the one `schema` makes: a plugin that cannot
/// tell which version it is running on has to either assume or break, and none
/// of these three says anything about the person.
#[tauri::command]
pub fn plugin_app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}
