//! Installing plugins: download a bundle, prove it is the one the user agreed
//! to, and unpack it somewhere it can only be itself.
//!
//! Rust owns this rather than the webview for two reasons. The first is the
//! content security policy: `connect-src` names the loopback engine and nothing
//! else, and widening it to the releases host so a fetch() could run would open
//! that host to every script in the window for the sake of one download. The
//! second is that the interesting work here is bytes on disk, and the webview
//! has no business doing that.
//!
//! WHAT THIS MODULE KNOWS ABOUT PERMISSIONS: nothing. It does not know what
//! `document.write` means and must not learn. The vocabulary lives in
//! src/plugins/manifest.ts, which is also what renders the screen the user
//! answers. All this side does is hold the two ends together: the grants the
//! user was shown, and the grants that actually arrived in the bundle, compared
//! as sets. Teaching both sides the meaning of a grant would give them two
//! chances to disagree about it.
//!
//! THE CHAIN, end to end, because no single link is worth much alone:
//!
//!   what the app offered  =  what was shown  =  the bundle's own manifest
//!
//! There is no index served over the wire and nothing to keep in step with one.
//! An official plugin is an asset on one of this repository's own releases, the
//! set the app offers is compiled into the app, and `allowed_bundle_url`
//! refuses every other origin. A file whose only job is to be trusted is a file
//! that can lie; not having one is cheaper than defending it.
//!
//! HTTPS to the releases host is where authenticity comes from. A caller may
//! pin the bytes with a sha256 and it is enforced when it is given, but a build
//! cannot carry the digest of an asset republished after it shipped, so what
//! arrived is recorded rather than demanded. The link that is never optional is
//! the last one: the permissions in the unpacked bundle must be the permissions
//! that were on the screen the user answered. Signatures, and with them a
//! publisher who is not us, are a later phase.

pub mod bundle;

use bundle::{
    allowed_bundle_url, extract_into, grants_match, now_secs, safe_id, sha256_hex, Consented,
    MAX_DOWNLOAD,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// What is written beside an installed plugin, and what the app reads back to
/// decide whether it is installed at all.
///
/// The record lives IN the plugin's directory rather than in a settings key, so
/// that deleting the directory really does uninstall the plugin. A record kept
/// somewhere else can disagree with the files, and when it does, the app
/// believes the record.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub id: String,
    pub version: String,
    /// Opaque here. It is `promiseOf()` from the frontend, stored so the same
    /// side that produced it can decide whether a later version is covered.
    pub promise: String,
    pub source: String,
    pub sha256: String,
    pub installed_at: u64,
    pub dir: String,
    pub consented: Consented,
}

const RECORD: &str = "installed.json";
const MANIFEST: &str = "plugin.json";

// ---------------------------------------------------------------------------
// on disk
// ---------------------------------------------------------------------------

fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

fn read_record(dir: &Path) -> Option<Installed> {
    let text = std::fs::read_to_string(dir.join(RECORD)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every plugin currently installed. A directory with no readable record is not
/// reported as installed: whatever is in there, nobody has a record of agreeing
/// to it, and the honest answer to "is this installed" is no.
#[tauri::command]
pub fn plugin_list(app: AppHandle) -> Result<Vec<Installed>, String> {
    let root = plugins_root(&app)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(rec) = read_record(&entry.path()) {
                out.push(rec);
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Download, verify, unpack, and only then let the result be called installed.
///
/// The order is the point. Nothing is written into the plugin's own directory
/// until the unpacked manifest has matched what the user was shown; a failure
/// at any step leaves whatever was installed before exactly as it was, rather
/// than half-replaced.
#[tauri::command]
pub async fn plugin_install(
    app: AppHandle,
    id: String,
    url: String,
    // Optional, and enforced when present. See the chain in the module docs:
    // this pins bytes, it does not establish who published them.
    sha256: Option<String>,
    promise: String,
    expect: Consented,
) -> Result<Installed, String> {
    let id = safe_id(&id)?.to_string();
    if !allowed_bundle_url(&url) {
        return Err(format!("that is not a FundaCAD plugin download: {url}"));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not download the plugin: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the download answered {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_DOWNLOAD {
        return Err(format!("the download is {} bytes", bytes.len()));
    }

    let got = sha256_hex(&bytes);
    if let Some(want) = sha256.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !got.eq_ignore_ascii_case(want) {
            return Err(format!(
                "the download does not match its checksum (expected {want}, got {got})"
            ));
        }
    }

    let root = plugins_root(&app)?;
    let staging = root.join(format!(".staging-{id}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;

    let finish = |res: Result<Installed, String>, staging: &Path| -> Result<Installed, String> {
        if res.is_err() {
            let _ = std::fs::remove_dir_all(staging);
        }
        res
    };

    if let Err(e) = extract_into(&bytes, &staging) {
        return finish(Err(e), &staging);
    }

    // The bundle's own account of itself, which is what will actually run.
    let manifest_text = match std::fs::read_to_string(staging.join(MANIFEST)) {
        Ok(t) => t,
        Err(e) => return finish(Err(format!("the bundle has no {MANIFEST}: {e}")), &staging),
    };
    let found: Consented = match serde_json::from_str(&manifest_text) {
        Ok(m) => m,
        Err(e) => return finish(Err(format!("unreadable {MANIFEST}: {e}")), &staging),
    };
    if let Err(e) = grants_match(&expect, &found) {
        return finish(Err(e), &staging);
    }

    let record = Installed {
        id: id.clone(),
        version: found.version.clone(),
        promise,
        source: url,
        sha256: got,
        installed_at: now_secs(),
        dir: String::new(),
        consented: found,
    };
    let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(staging.join(RECORD), text) {
        return finish(Err(format!("{}: {e}", staging.display())), &staging);
    }

    let dest = root.join(&id);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&staging, &dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        format!("could not put the plugin in place: {e}")
    })?;

    // Written last, once the directory is where it will stay, so the path in the
    // record is the path the plugin actually has.
    let mut record = read_record(&dest).ok_or("the installed plugin lost its record")?;
    record.dir = dest.to_string_lossy().to_string();
    let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    std::fs::write(dest.join(RECORD), text).map_err(|e| format!("{}: {e}", dest.display()))?;
    Ok(record)
}

#[tauri::command]
pub fn plugin_remove(app: AppHandle, id: String) -> Result<(), String> {
    let id = safe_id(&id)?;
    let dir = plugins_root(&app)?.join(id);
    if !dir.is_dir() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))
}

/// What a process plugin written in Python needs to be launched by somebody
/// else: the interpreter the app already installed, and the packages beside it.
///
/// Handed out rather than used, because nothing here launches an MCP server.
/// The host does (Claude Code, Claude Desktop, an editor), and it needs a
/// command line it can be given. Producing that command line is the entire
/// remaining job of installing the MCP plugin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRuntime {
    pub python: String,
    pub pythonpath: Option<String>,
    /// Where the geometry engine's sources are, for a plugin that has to start
    /// one of its own. Installed plugins live under the app data directory and
    /// have no path back to the app's resources otherwise.
    pub sidecar_dir: String,
}

#[tauri::command]
pub fn plugin_python(app: AppHandle) -> Result<PythonRuntime, String> {
    let rt = crate::sidecar::python_runtime(&app).map_err(|e| e.to_string())?;
    Ok(PythonRuntime {
        python: rt.0.to_string_lossy().to_string(),
        pythonpath: rt.1.map(|p| p.to_string_lossy().to_string()),
        sidecar_dir: rt.2.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
