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
//!   what was shown  =  the bundle's own manifest
//!
//! There is no index served over the wire and nothing to keep in step with one.
//! A file whose only job is to be trusted is a file that can lie; not having one
//! is cheaper than defending it.
//!
//! A bundle may come from any HTTPS URL, or from a zip the user picked off
//! their own disk. That is a deliberate widening of what used to be a check
//! that only ever admitted this repository's releases. The origin was never the
//! thing that made a plugin safe — the grants it declared and the sandbox its
//! kind runs in are — and an allowlist containing only ourselves is not a
//! permission model, it is a distribution monopoly wearing one. What survives
//! of the old check is the part that was always doing the work:
//! `allowed_bundle_url` still insists on HTTPS and on an authority that means
//! what it reads, and `is_official_url` now answers the separate and purely
//! descriptive question of whether we published it.
//!
//! WHERE AUTHENTICITY COMES FROM, therefore, is the transport and the consent
//! screen together: TLS makes the host in the URL the host that answered, and
//! the origin is put in front of the user before anything is fetched. A caller
//! may pin the bytes with a sha256 and it is enforced when it is given, but a
//! build cannot carry the digest of an asset republished after it shipped, so
//! what arrived is recorded rather than demanded. The link that is never
//! optional is the last one: the permissions in the unpacked bundle must be the
//! permissions that were on the screen the user answered. Signatures, and with
//! them revocation, are a later phase.

pub mod bundle;
pub mod files;
pub mod handed;

use bundle::{
    allowed_bundle_url, extract_into, grants_match, is_official_url, now_secs, safe_id, sha256_hex,
    Consented, MAX_DOWNLOAD,
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
    /// Whether `source` is one of this repository's own release assets.
    ///
    /// Decided once, here, at install, rather than by the list re-deriving it
    /// from the URL every time it renders: the frontend would need its own copy
    /// of the prefix to do that, and a label that two places compute is a label
    /// two places can disagree about. Carries NO permission with it.
    ///
    /// Defaulted, so a record written before this field existed reads back as
    /// not-official rather than failing to parse. That is the right way round:
    /// the older records are all MCP from our own releases, so the default is
    /// wrong for them, and a plugin wrongly labelled as someone else's is a
    /// smaller problem than one wrongly labelled as ours.
    #[serde(default)]
    pub official: bool,
}

const RECORD: &str = "installed.json";
const MANIFEST: &str = "manifest.json";
/// The app-side module of a plugin that runs in the window. Named the same by
/// scripts/build-plugin-code.mjs, which writes it, and by build-plugins.py,
/// which puts it in the zip.
const CODE: &str = "main.js";

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

/// Verify, unpack, and only then let the result be called installed.
///
/// Everything after "we have the bytes" is identical whether they were
/// downloaded or read off the user's disk, so it lives here once. The two
/// commands below differ only in how they get the bytes and in what they record
/// as the source, which is the whole of the difference between installing from
/// a URL and installing from a file.
///
/// The order is the point. Nothing is written into the plugin's own directory
/// until the unpacked manifest has matched what the user was shown; a failure
/// at any step leaves whatever was installed before exactly as it was, rather
/// than half-replaced.
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
            return Err(format!(
                "the download does not match its checksum (expected {want}, got {got})"
            ));
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

/// What a bundle says about itself, read before anything is installed.
///
/// THE ORDER PROBLEM this solves. The consent screen shows what a plugin asks
/// for, and it has to show that before the plugin is installed. For the set
/// compiled into the app that is easy: the entry is already here. For a bundle
/// at a URL nobody has seen before, the only account of what it wants is inside
/// the bundle, so it has to be fetched and unpacked before there is anything to
/// put on a screen.
///
/// FETCHING IS NOT RUNNING, which is what makes that acceptable. This
/// downloads, unpacks into a scratch directory, reads one file, and deletes the
/// directory again. Nothing is executed, nothing is left behind, and nothing is
/// recorded as installed. The extractor's refusals — traversal, absolute paths,
/// symlinks, entry counts, unpacked size — all apply here exactly as they do on
/// the real thing, because it is the same function.
///
/// WHY THE DIGEST COMES BACK. The install that follows is a second fetch, and
/// between the two the asset could change: the screen would have described one
/// bundle and the install would have taken another. Passing this digest back in
/// as the pin closes that, and closes it in the direction that matters — a
/// bundle whose bytes moved is refused rather than silently accepted under the
/// old description.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    /// The bundle's `manifest.json`, verbatim and unparsed.
    ///
    /// Handed over as-is for the frontend to run through `parseManifest`, the
    /// same function that will validate it at install and the same one that
    /// renders the screen. This side must not pre-digest it: a manifest that
    /// two parsers understand differently is a screen that describes something
    /// other than what gets enforced.
    pub manifest: serde_json::Value,
    pub sha256: String,
    pub source: String,
    pub official: bool,
}

fn inspect_bytes(
    app: &AppHandle,
    bytes: &[u8],
    source: String,
    official: bool,
) -> Result<Inspected, String> {
    if bytes.len() > MAX_DOWNLOAD {
        return Err(format!("the bundle is {} bytes", bytes.len()));
    }
    let sha256 = sha256_hex(bytes);

    // Named after the digest so two inspections cannot tread on each other, and
    // kept under the plugins root so it is on the same filesystem as the real
    // thing rather than somewhere with different rules about links.
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

    Ok(Inspected {
        manifest: read?,
        sha256,
        source,
        official,
    })
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

    // EVERY HOP IS CHECKED, not just the one that was typed. reqwest follows
    // redirects by default, so without this the check above secures the first
    // request and nothing else: a URL on a host the user approved could answer
    // 302 to plain HTTP, and the bytes that arrived would be whatever the
    // network chose while the consent screen still said https. The hop limit is
    // reqwest's own default, restated here because setting a custom policy
    // replaces it rather than extending it.
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

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not download the plugin: {e}"))?;
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

/// Install a bundle the user already has: a zip they downloaded themselves, or
/// one they built.
///
/// The same pipeline, and deliberately not a shortcut through it. A local file
/// has no origin to show and no transport to trust, so the ONLY thing standing
/// between it and the app is the comparison every bundle gets: the permissions
/// inside it must be the permissions that were on the screen. Skipping that for
/// a file because the user picked it would make "pick a file" the way around
/// the consent screen.
///
/// Never official, whatever it contains. A file on disk cannot demonstrate
/// where it came from, and a bundle that claims to be ours is exactly the one
/// that must not be believed for saying so.
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

/// The entry point of an installed plugin, as text.
///
/// One file, named by the plugin's kind, from inside the plugin's own
/// directory. NOT an arbitrary read: the caller does not choose the name, the
/// installed record does, so this cannot be turned into a file reader by asking
/// it nicely. The id is checked the same way it is everywhere else, and the
/// path is joined onto the plugins root rather than taken from the record's own
/// `dir`, because a record is a file inside the directory it describes and a
/// directory that can rewrite its own path is not a boundary.
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
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    // The same cap the bundle got. A plugin that grew a 32MB entry point after
    // installation is not one to hand to a parser.
    if text.len() > MAX_DOWNLOAD {
        return Err(format!("{name} is {} bytes", text.len()));
    }
    Ok(text)
}

/// The app-side module of an installed plugin, for the window to evaluate.
///
/// THE ONE COMMAND IN THIS FILE THAT HANDS BACK CODE TO BE RUN, and every
/// condition on it is load-bearing.
///
/// A plugin that draws — a menu row, a component, paint on the model — runs in
/// the application's own JavaScript context, because none of those is
/// expressible from a Worker or from a separate process. There is no sandbox to
/// put such a plugin in. So the only defensible rule is about WHERE THE CODE
/// CAME FROM, and it is enforced here rather than in the window: the frontend
/// cannot check the provenance of a string handed to it by the same call it is
/// trusting.
///
/// Three gates, and each refuses in its own words so that a person filing a bug
/// can say which one stopped them:
///
///   1. The kind. Only a `builtin` runs in the app's context; that is what the
///      word means on the consent screen, and `sandboxNote("builtin")` already
///      says "the list above is what it uses, not a limit on it".
///   2. The origin. Only a bundle from this project's own releases. `official`
///      was decided once, at install, from the URL it actually came from, and
///      is stored beside the plugin rather than re-derived from a string the
///      caller supplies.
///   3. The size. The same cap the bundle got, re-checked at read time, because
///      a file can grow after it is installed.
///
/// What is deliberately NOT here yet is a signature over the bundle. The origin
/// gate anchors on GitHub's TLS and this repository's path, which is the same
/// anchor the updater has before ITS signature check; adding the second anchor
/// needs a signing key, and generating one is not this file's decision to make.
/// `verify_plugin_signature` below is where it goes, and it fails closed the
/// moment a public key exists.
#[tauri::command]
pub fn plugin_code(app: AppHandle, id: String) -> Result<String, String> {
    let id = safe_id(&id)?;
    let dir = plugins_root(&app)?.join(id);
    let record = read_record(&dir).ok_or("that plugin is not installed")?;

    if record.consented.kind != "builtin" {
        return Err(format!(
            "a {} plugin does not run in the app's own context",
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
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if text.len() > MAX_DOWNLOAD {
        return Err(format!("{CODE} is {} bytes", text.len()));
    }
    Ok(text)
}

/// The second anchor, when there is one to check against.
///
/// FAILS CLOSED, and that is the whole design: with no public key compiled in,
/// there is nothing to verify against and the origin gate above is what stands.
/// The moment a key exists, a bundle without a good signature over it is
/// refused — including every bundle installed before the key existed, which is
/// the correct and slightly annoying outcome rather than a grandfather clause
/// that would make the key decorative.
fn verify_plugin_signature(_dir: &Path, _record: &Installed) -> Result<(), String> {
    match PLUGIN_PUBLIC_KEY {
        None => Ok(()),
        Some(_key) => Err(
            "this build expects plugins to be signed, and signature checking is not implemented              yet. Remove the key or finish the check before shipping it."
                .into(),
        ),
    }
}

/// The public key app-side plugin code is verified against, once there is one.
///
/// `None` until somebody generates a key pair, which is a decision with a
/// key-custody consequence and is not one to take on anybody's behalf. Written
/// as a constant rather than read from a file so that it cannot be swapped by
/// anything that can write next to the executable.
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
