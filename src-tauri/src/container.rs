//! The app's side of document files: the blob and mesh stores and the save and open commands. The formats are in
//! fundacad-format.

use std::collections::BTreeMap;
use std::path::PathBuf;

pub use fundacad_format::container::*;

/// Not under the cache dir, where Compute All's purge would delete it. App and engine share it lock free, as the path
/// is the content hash and writes publish by rename (tests/container_seam.rs). Flat: one blob per import feature, not
/// per body like geomstore, which holds 3,060 for the reference assembly.
pub fn blob_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("blobs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Packed viewport meshes, only a reopen speed cache, kept beside the blobs so a container can seed it.
pub fn mesh_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("meshes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Sections of a `.fundab` this version does not read, copied out on open and
/// written back on save, one file per section named by its hash.
pub fn section_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("sections");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The folders a save reads from.
pub struct Stores {
    pub blobs: PathBuf,
    pub meshes: PathBuf,
    pub sections: PathBuf,
}

fn is_hash(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `container_save` without the app handle.
#[allow(clippy::too_many_arguments)]
pub fn save_document(
    stores: &Stores,
    path: &std::path::Path,
    document_json: &str,
    hashes: Vec<String>,
    optional_hashes: Vec<String>,
    mesh_keys: Vec<String>,
    carried: Vec<fundacad_format::fnda::Carried>,
    app_version: &str,
) -> Result<(), String> {
    let mut blobs = BTreeMap::new();
    let mut missing = Vec::new();
    for h in hashes {
        let p = stores.blobs.join(format!("{h}.bbrep"));
        if p.exists() {
            blobs.insert(h, p);
        } else {
            missing.push(h);
        }
    }
    // Refuse rather than save a document missing geometry. The atomic publish leaves the previous file intact.
    if !missing.is_empty() {
        return Err(format!(
            "{} of this document's imported bodies could not be found in local storage, \
             so saving was stopped rather than writing a file with missing geometry. \
             The previous file is unchanged.",
            missing.len()
        ));
    }
    // Hash shaped strings the document holds outside its imports, which a
    // feature of a type this version does not know may use to name geometry.
    for h in optional_hashes.into_iter().filter(|h| is_hash(h)) {
        let p = stores.blobs.join(format!("{h}.bbrep"));
        if p.exists() {
            blobs.entry(h).or_insert(p);
        }
    }

    let mut meshes = BTreeMap::new();
    for k in mesh_keys {
        let p = stores.meshes.join(format!("{k}.bin"));
        if p.exists() {
            meshes.insert(k, p); // absent meshes are a cache miss, never an error
        }
    }

    let carried: Vec<_> = carried
        .into_iter()
        .filter(|c| is_hash(&c.hash))
        .map(|c| {
            let p = stores.sections.join(format!("{}.bin", c.hash));
            (c, p)
        })
        .collect();

    write_document(path, document_json, &blobs, &meshes, &carried, app_version)
}

// Privileged IPC like `recovery_write`: the webview may only read and write text files, and widening that to binary
// would reopen the post XSS persistence channel.

/// Writes the document and its geometry to `path` atomically, without asking the engine, so a save never waits on a
/// crashed worker. The frontend collects `hashes` from the import features since it owns the document;
/// `optional_hashes` are other hash shaped strings in it, embedded when the store has them.
#[tauri::command]
pub async fn container_save(
    app: tauri::AppHandle,
    path: String,
    document_json: String,
    hashes: Vec<String>,
    mesh_keys: Vec<String>,
    optional_hashes: Option<Vec<String>>,
    carried: Option<Vec<fundacad_format::fnda::Carried>>,
) -> Result<(), String> {
    let stores = Stores { blobs: blob_dir(&app)?, meshes: mesh_dir(&app)?, sections: section_dir(&app)? };
    let app_version = app.package_info().version.to_string();
    save_document(
        &stores,
        std::path::Path::new(&path),
        &document_json,
        hashes,
        optional_hashes.unwrap_or_default(),
        mesh_keys,
        carried.unwrap_or_default(),
        &app_version,
    )
}

/// Opens a binary or JSON document. Its blobs land in the store before this returns, so the rebuild on load finds them.
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
    pub carried: Vec<fundacad_format::fnda::Carried>,
}

/// `container_open`, plus what the error correction had to repair. A file that
/// needed repair opens normally; saving it writes a clean copy.
#[tauri::command]
pub async fn container_open_checked(app: tauri::AppHandle, path: String) -> Result<OpenedDocument, String> {
    let blobs = blob_dir(&app)?;
    let meshes = mesh_dir(&app)?;
    let sections = section_dir(&app)?;
    let o = open_document_full(std::path::Path::new(&path), &blobs, Some(&meshes), Some(&sections))?;
    Ok(OpenedDocument {
        document: o.document,
        repaired_shards: o.report.repaired_shards,
        used_backup_index: o.report.used_backup_index,
        carried: o.carried,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDroppedDocument {
    pub document: String,
    pub repaired_shards: u64,
    pub used_backup_index: bool,
    pub was_container: bool,
    pub carried: Vec<fundacad_format::fnda::Carried>,
}

/// `container_open_checked` for a drop that gives the page bytes but no path. They arrive as the raw IPC body, as a
/// large document would not survive a JSON array.
#[tauri::command]
pub async fn container_open_bytes(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<OpenedDroppedDocument, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("the dropped document did not arrive as bytes".into());
    };
    let blobs = blob_dir(&app)?;
    let meshes = mesh_dir(&app)?;
    let sections = section_dir(&app)?;
    let opened = open_document_bytes(bytes, &blobs, Some(&meshes), Some(&sections))?;
    Ok(OpenedDroppedDocument {
        document: opened.document,
        repaired_shards: opened.report.repaired_shards,
        used_backup_index: opened.report.used_backup_index,
        was_container: opened.was_container,
        carried: opened.carried,
    })
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
