//! Installing plugins: download a bundle, prove it is the one the user agreed to, and unpack it where it can only be
//! itself.
//! In Rust because widening `connect-src` would open the releases host to every script. Grants are opaque strings here.
//! A bundle may come from any HTTPS URL or a local zip. The link that is never optional: the unpacked bundle's grants
//! equal the ones on the consent screen. Signatures and revocation are a later phase.

pub mod bundle;
pub mod data;
pub mod files;
pub mod handed;
pub mod keystore;
pub mod launch;
pub mod localnet;
pub mod web;

use bundle::{
    allowed_bundle_url, extract_into, grants_match, is_official_url, now_secs, safe_id, sha256_hex, Consented,
    MAX_DOWNLOAD,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Written beside an installed plugin, in its directory rather than a settings key, so deleting the directory really
/// uninstalls it.
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
    /// Decided once at install, so the frontend needs no copy of the prefix. Carries no permission. Defaults to false
    /// for
    /// older records, the safer wrong label.
    #[serde(default)]
    pub official: bool,
    /// Whether the files on disk hold the geometry component the manifest
    /// names, read off the directory each time it is listed. False for a bundle
    /// built for the retired Python engine, which this engine cannot run.
    #[serde(default)]
    pub component: bool,
}

pub(crate) const RECORD: &str = "installed.json";
const MANIFEST: &str = "manifest.json";
/// The app-side module of a plugin that runs in the window. Named the same by
/// scripts/build-plugin-code.mjs, which writes it, and by build-plugins.py,
/// which puts it in the zip.
const CODE: &str = "main.js";

/// `pub(crate)` because the engine worker is told this path too, as for the blob store: the two must agree, and only
/// one installs.
pub(crate) fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("no app data directory: {e}"))?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// What the person agreed to for an installed plugin, or None when it is not installed.
pub(crate) fn consented_of(app: &AppHandle, id: &str) -> Option<bundle::Consented> {
    let dir = plugins_root(app).ok()?.join(safe_id(id).ok()?);
    read_record(&dir).map(|r| r.consented)
}

fn read_record(dir: &Path) -> Option<Installed> {
    let text = std::fs::read_to_string(dir.join(RECORD)).ok()?;
    let mut rec: Installed = serde_json::from_str(&text).ok()?;
    rec.component = has_component(dir);
    Some(rec)
}

/// The manifest field and file crates/fundacad-geom/src/plugins runs.
fn has_component(dir: &Path) -> bool {
    std::fs::read(dir.join(MANIFEST))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|m| m.get("geometryWasm")?.as_str().map(str::to_owned))
        .filter(|rel| !rel.is_empty())
        .is_some_and(|rel| rel.split('/').fold(dir.to_path_buf(), |p, part| p.join(part)).is_file())
}

/// A directory with no readable record is not reported as installed: nobody has a record of agreeing to it.
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

/// Shared by the URL and file installs. Nothing is written into the plugin's directory until the unpacked manifest
/// matches what the user was shown, so a failure leaves the previous install intact.
fn install_bytes(
    app: &AppHandle,
    id: &str,
    source: String,
    official: bool,
    bytes: &[u8],
    // Optional, and enforced when present. See the chain in the module docs:
    // this pins bytes, it does not establish who published them.
    sha256: Option<String>,
    promise: String,
    expect: Consented,
) -> Result<Installed, String> {
    let id = safe_id(id)?.to_string();
    if bytes.len() > MAX_DOWNLOAD {
        return Err(format!("the bundle is {} bytes", bytes.len()));
    }

    let got = sha256_hex(bytes);
    if let Some(want) = sha256.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !got.eq_ignore_ascii_case(want) {
            return Err(format!("the download does not match its checksum (expected {want}, got {got})"));
        }
    }

    let root = plugins_root(app)?;
    let staging = root.join(format!(".staging-{id}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;

    let finish = |res: Result<Installed, String>, staging: &Path| -> Result<Installed, String> {
        if res.is_err() {
            let _ = std::fs::remove_dir_all(staging);
        }
        res
    };

    if let Err(e) = extract_into(bytes, &staging) {
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
        source,
        sha256: got,
        installed_at: now_secs(),
        dir: String::new(),
        consented: found,
        official,
        component: false,
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

/// Read before anything is installed, since for an unseen URL the consent screen's only source is the bundle. Fetching
/// is not running: it unpacks to scratch with the same refusals, reads one file and deletes it. The digest comes back
/// as the install's pin, so bytes that moved in between are refused.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    /// Verbatim and unparsed, for the frontend's `parseManifest`, the same function that validates at install and
    /// renders
    /// the screen, so two parsers never disagree.
    pub manifest: serde_json::Value,
    pub sha256: String,
    pub source: String,
    pub official: bool,
}

fn inspect_bytes(app: &AppHandle, bytes: &[u8], source: String, official: bool) -> Result<Inspected, String> {
    if bytes.len() > MAX_DOWNLOAD {
        return Err(format!("the bundle is {} bytes", bytes.len()));
    }
    let sha256 = sha256_hex(bytes);

    // Named after the digest so two inspections cannot collide, under the plugins root so it shares the real install's
    // filesystem and link rules.
    let root = plugins_root(app)?;
    let scratch = root.join(format!(".inspect-{}", &sha256[..16]));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("{}: {e}", scratch.display()))?;

    let read = (|| -> Result<serde_json::Value, String> {
        extract_into(bytes, &scratch)?;
        let text = std::fs::read_to_string(scratch.join(MANIFEST))
            .map_err(|e| format!("the bundle has no {MANIFEST}: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("unreadable {MANIFEST}: {e}"))
    })();

    // Always, on both paths. A scratch directory left behind by a bundle that
    // failed to unpack is the one case where the leftovers are attacker-chosen.
    let _ = std::fs::remove_dir_all(&scratch);

    Ok(Inspected { manifest: read?, sha256, source, official })
}

/// Download a bundle and read its manifest, installing nothing.
#[tauri::command]
pub async fn plugin_inspect_url(app: AppHandle, url: String) -> Result<Inspected, String> {
    let bytes = fetch_bundle(&url).await?;
    let official = is_official_url(&url);
    inspect_bytes(&app, &bytes, url, official)
}

/// Read a bundle the user already has, installing nothing.
#[tauri::command]
pub fn plugin_inspect_file(app: AppHandle, path: String) -> Result<Inspected, String> {
    let bytes = read_bundle_file(&path)?;
    inspect_bytes(&app, &bytes, path, false)
}

/// Get a bundle's bytes over HTTPS, refusing to reach anywhere it may not.
async fn fetch_bundle(url: &str) -> Result<Vec<u8>, String> {
    if !allowed_bundle_url(url) {
        return Err(format!(
            "a plugin can only be downloaded over https from a named host, and that is not one: {url}"
        ));
    }

    // Every hop is checked: reqwest follows redirects, so an approved host could 302 to plain HTTP. The hop limit
    // restates
    // reqwest's default, since a custom policy replaces it.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if allowed_bundle_url(attempt.url().as_str()) {
                attempt.follow()
            } else {
                let to = attempt.url().to_string();
                attempt.error(format!("the download redirected somewhere it may not go: {to}"))
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| format!("could not download the plugin: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the download answered {}", resp.status()));
    }
    Ok(resp.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/// Read a bundle off the user's own disk.
fn read_bundle_file(path: &str) -> Result<Vec<u8>, String> {
    let file = PathBuf::from(path);
    let meta = std::fs::metadata(&file).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    // Checked before reading, so a huge file is refused rather than loaded into
    // memory to be refused.
    if meta.len() > MAX_DOWNLOAD as u64 {
        return Err(format!("that bundle is {} bytes", meta.len()));
    }
    std::fs::read(&file).map_err(|e| format!("{path}: {e}"))
}

/// Fetch a bundle over HTTPS and install it.
#[tauri::command]
pub async fn plugin_install(
    app: AppHandle,
    id: String,
    url: String,
    sha256: Option<String>,
    promise: String,
    expect: Consented,
) -> Result<Installed, String> {
    let bytes = fetch_bundle(&url).await?;
    let official = is_official_url(&url);
    install_bytes(&app, &id, url, official, &bytes, sha256, promise, expect)
}

/// Install a zip the user has. The same pipeline: the grant comparison is the only gate a local file has, so skipping
/// it
/// would make picking a file the way around consent. Never official, a file cannot prove where it came from.
#[tauri::command]
pub fn plugin_install_file(
    app: AppHandle,
    id: String,
    path: String,
    sha256: Option<String>,
    promise: String,
    expect: Consented,
) -> Result<Installed, String> {
    let bytes = read_bundle_file(&path)?;
    install_bytes(&app, &id, path, false, &bytes, sha256, promise, expect)
}

/// One file, named by the plugin's kind, not by the caller. The path is joined onto the plugins root rather than taken
/// from the record's own `dir`, since a directory that can rewrite its own path is not a boundary.
#[tauri::command]
pub fn plugin_entry(app: AppHandle, id: String) -> Result<String, String> {
    let id = safe_id(&id)?;
    let dir = plugins_root(&app)?.join(id);
    let record = read_record(&dir).ok_or("that plugin is not installed")?;
    let name = match record.consented.kind.as_str() {
        "compute" => "plugin.js",
        "panel" => "index.html",
        other => return Err(format!("a {other} plugin has no entry point to read")),
    };
    let path = dir.join(name);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    // The same cap the bundle got. A plugin that grew a 32MB entry point after
    // installation is not one to hand to a parser.
    if text.len() > MAX_DOWNLOAD {
        return Err(format!("{name} is {} bytes", text.len()));
    }
    Ok(text)
}

/// The one command that hands back code to run, in the app's own JS context where no sandbox exists. Three gates, each
/// refusing in its own words: the kind, the origin (`official`, decided at install), and the size, checked again at
/// read. A signature is the missing second anchor, see `verify_plugin_signature`.
#[tauri::command]
pub fn plugin_code(app: AppHandle, id: String) -> Result<String, String> {
    let id = safe_id(&id)?;
    let dir = plugins_root(&app)?.join(id);
    let record = read_record(&dir).ok_or("that plugin is not installed")?;

    // Only `builtin` and `process`, whose consent notes already promise no containment. `compute` and `panel` promise
    // no
    // network or files, which app side code would make false; build-plugins.py refuses to package one too.
    if !matches!(record.consented.kind.as_str(), "builtin" | "process") {
        return Err(format!(
            "a {} plugin is described to the person as contained, so it may not run code in              the app's own context",
            record.consented.kind
        ));
    }
    if !record.official {
        return Err(
            "this plugin did not come from FundaCAD's own releases, and code that runs in the              app's own context is loaded only from there"
                .into(),
        );
    }
    verify_plugin_signature(&dir, &record)?;

    let path = dir.join(CODE);
    // No app side module is the ordinary case: the caller gets an empty string and starts nothing.
    if !path.is_file() {
        return Ok(String::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if text.len() > MAX_DOWNLOAD {
        return Err(format!("{CODE} is {} bytes", text.len()));
    }
    Ok(text)
}

/// Fails closed: with no public key compiled in, the origin gate stands. Once a key exists every unsigned bundle is
/// refused, installed ones included, so the key is never decorative.
fn verify_plugin_signature(_dir: &Path, _record: &Installed) -> Result<(), String> {
    match PLUGIN_PUBLIC_KEY {
        None => Ok(()),
        Some(_key) => Err(
            "this build expects plugins to be signed, and signature checking is not implemented              yet. Remove the key or finish the check before shipping it."
                .into(),
        ),
    }
}

/// `None` until somebody generates a key pair, a key custody decision. A constant, so nothing that can write next to
/// the executable can swap it.
const PLUGIN_PUBLIC_KEY: Option<&str> = None;

#[tauri::command]
pub fn plugin_remove(app: AppHandle, id: String) -> Result<(), String> {
    let id = safe_id(&id)?;
    let dir = plugins_root(&app)?.join(id);
    if !dir.is_dir() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))
}
