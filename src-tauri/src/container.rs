//! The app's side of the document files: where the blob and mesh stores live,
//! and the commands the webview saves and opens through. The formats themselves
//! are the fundacad-format crate.

use std::collections::BTreeMap;
use std::path::PathBuf;

pub use fundacad_format::container::*;

/// The durable blob store: content-addressed geometry, one file per hash.
///
/// Under `app_data_dir()`, deliberately NOT the cache dir: geomstore's `evict()`
/// drops any blob with refcount 0 and `purge()` is wired to the Compute All
/// button, so a container blob there would be deleted by a button press.
///
/// This directory is the SEAM between the app and its engine worker: the app
/// writes it when opening a container, the engine writes it at import, both read
/// it (tests/container_seam.rs). Safe with no
/// locking because the path is a pure function of the content hash: two writers
/// racing on the same hash write byte-identical data, and each publishes by rename.
///
/// Flat, not sharded: geomstore holds one blob per BODY (3,060 for the reference
/// assembly), this one holds one per IMPORT FEATURE.
pub fn blob_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("blobs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Packed viewport meshes carried alongside the blobs. Purely a reopen-speed
/// cache, losing this costs re-tessellation time, never data, but it lives
/// next to the blobs rather than in geomstore so a container can seed it.
pub fn mesh_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("meshes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Tauri commands. Privileged IPC, the same pattern as `recovery_write`, the
// webview holds only `fs:allow-read-text-file` / `fs:allow-write-text-file`, so
// it could not read or write a ZIP itself even if we wanted it to. Widening that
// to the binary APIs would reopen the post-XSS persistence channel the security
// round deliberately closed.

/// Write the document and the geometry it references to `path`, atomically.
///
/// `hashes` are the content hashes the document's import features carry; the
/// frontend collects them because it owns the document. Deliberately does NOT
/// consult the engine, so a save never waits on a worker that crashed or is
/// restarting.
#[tauri::command]
pub async fn container_save(
    app: tauri::AppHandle,
    path: String,
    document_json: String,
    hashes: Vec<String>,
    mesh_keys: Vec<String>,
) -> Result<(), String> {
    let blobs_root = blob_dir(&app)?;
    let meshes_root = mesh_dir(&app)?;

    let mut blobs = BTreeMap::new();
    let mut missing = Vec::new();
    for h in hashes {
        let p = blobs_root.join(format!("{h}.bbrep"));
        if p.exists() {
            blobs.insert(h, p);
        } else {
            missing.push(h);
        }
    }
    // Refuse rather than write a document whose geometry is not in it. The
    // atomic publish means the user still has their previous file, and the
    // in-memory document is untouched, both strictly better than a saved file
    // that opens with missing bodies somewhere else.
    if !missing.is_empty() {
        return Err(format!(
            "{} of this document's imported bodies could not be found in local storage, \
             so saving was stopped rather than writing a file with missing geometry. \
             The previous file is unchanged.",
            missing.len()
        ));
    }

    let mut meshes = BTreeMap::new();
    for k in mesh_keys {
        let p = meshes_root.join(format!("{k}.bin"));
        if p.exists() {
            meshes.insert(k, p); // absent meshes are a cache miss, never an error
        }
    }

    let app_version = app.package_info().version.to_string();
    write_document(
        std::path::Path::new(&path),
        &document_json,
        &blobs,
        &meshes,
        &app_version,
    )
}

/// Read a document at `path`, binary or JSON: extract its geometry into the blob
/// store and return the document JSON. The blobs land before this returns, so the
/// rebuild the frontend kicks off on load can resolve them immediately.
#[tauri::command]
pub async fn container_open(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let blobs = blob_dir(&app)?;
    let meshes = mesh_dir(&app)?;
    open_document_checked(std::path::Path::new(&path), &blobs, Some(&meshes)).map(|(doc, _)| doc)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub document: String,
    pub repaired_shards: u64,
    pub used_backup_index: bool,
}

/// `container_open`, plus what the error correction had to repair. A file that
/// needed repair opens normally; saving it writes a clean copy.
#[tauri::command]
pub async fn container_open_checked(app: tauri::AppHandle, path: String) -> Result<OpenedDocument, String> {
    let blobs = blob_dir(&app)?;
    let meshes = mesh_dir(&app)?;
    let (document, report) = open_document_checked(std::path::Path::new(&path), &blobs, Some(&meshes))?;
    Ok(OpenedDocument { document, repaired_shards: report.repaired_shards, used_backup_index: report.used_backup_index })
}

/// Check a format 2 file end to end without opening it.
#[tauri::command]
pub async fn container_verify(path: String) -> Result<fundacad_format::fnda::RepairReport, String> {
    fundacad_format::fnda::verify(std::path::Path::new(&path))
}

/// True if `path` is a container rather than a legacy plain-JSON document.
#[tauri::command]
pub fn container_is_container(path: String) -> bool {
    looks_like_container(std::path::Path::new(&path))
}
