//! The ZIP document container, format 1: the document JSON plus the geometry it references by content hash. On the 356
//! MiB STEP reference, base64 BREP in JSON is 541.8 MiB; BinTools is 224.1 MiB, 83.5 deflated, and reloads in 1.9 s.
//! The app owns it, not the engine worker, so a save never depends on a restarting worker. Two rules: hash the STORED
//! bytes once at write time, since `write(read(x)) != x` for BREP, and never use an archive name as a path: blobs
//! publish under the verified hash, so zip-slip is impossible.
//!
//! ```text
//! manifest.json        STORED, first, readable without a decompressor
//! document.json        DEFLATE, the CadDocument, carrying its own `version`
//! geom/<hash>.bbrep    DEFLATE, binary OCCT BinTools; the NAME is the hash
//! mesh/<key>.bin       DEFLATE(1), packed f32/u32; optional, skippable
//! ```

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use blake2::digest::consts::U16;
use blake2::{Blake2b, Digest};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

/// Bumped only when the ZIP layout changes, apart from the document's own `version` (migrate.ts FORMAT_VERSION): a
/// document migration does not reshape the archive, and vice versa.
pub const CONTAINER_VERSION: u32 = 1;

pub const HASH_ALG: &str = "blake2b-128";

const MANIFEST_NAME: &str = "manifest.json";
const DOCUMENT_NAME: &str = "document.json";

/// Zip-bomb guard on the declared sizes in the central directory, refused before inflating a byte. Absolute, not a
/// ratio: sparse blobs and pretty JSON deflate ~1000x legitimately, and the expanded size is what makes a bomb harmful.
const MAX_TOTAL_UNCOMPRESSED: u64 = 8 << 30; // 8 GiB

type Blake2b128 = Blake2b<U16>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BlobRow {
    pub entry: String,
    pub hash: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MeshRow {
    pub entry: String,
    pub key: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Manifest {
    pub container: u32,
    #[serde(rename = "hashAlg")]
    pub hash_alg: String,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub blobs: Vec<BlobRow>,
    #[serde(default)]
    pub meshes: Vec<MeshRow>,
}

/// The content hash of a blob, taken once on the bytes as first produced. Production code only verifies hashes while
/// streaming; this pins the digest the format uses, checked by `hash_matches_python`.
#[allow(dead_code)]
pub fn hash_bytes(data: &[u8]) -> String {
    let mut h = Blake2b128::new();
    h.update(data);
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// True if `path` is a packaged document, format 2 or the older ZIP, rather than
/// a legacy plain-JSON one. Cheap: reads the first bytes.
pub fn looks_like_container(path: &Path) -> bool {
    crate::fnda::looks_like_fnda(path) || looks_like_zip(path)
}

fn looks_like_zip(path: &Path) -> bool {
    let mut buf = [0u8; 2];
    File::open(path).and_then(|mut f| f.read_exact(&mut buf)).map(|_| &buf == b"PK").unwrap_or(false)
}

fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && !key.contains("..")
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// fsync a directory so a rename INTO it is durable across a crash. Tolerant of
/// filesystems that refuse the operation outright.
fn fsync_dir(dir: &Path) {
    if let Ok(f) = File::open(dir) {
        let _ = f.sync_all();
    }
}

/// A temp path that cannot collide, in the SAME directory as the target, a temp
/// dir on another filesystem would make the rename fail with EXDEV.
fn temp_sibling(target: &Path) -> PathBuf {
    let mut n = target.as_os_str().to_os_string();
    n.push(format!(".tmp-{}", uuid_hex()));
    PathBuf::from(n)
}

fn uuid_hex() -> String {
    let mut b = [0u8; 16];
    // Failure here would mean no entropy source at all; a timestamp is a fine
    // fallback for a name that only has to be unique within one directory.
    if getrandom::getrandom(&mut b).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        b[..16].copy_from_slice(&t.to_le_bytes()[..16.min(16)]);
    }
    hex(&b)
}

/// Publish a document at `dest` in the current format (format 2, fnda.rs),
/// atomically: built at a sibling temp path, fsynced, then renamed over the target.
pub fn write_container(
    dest: &Path,
    document_json: &str,
    blob_paths: &BTreeMap<String, PathBuf>,
    mesh_paths: &BTreeMap<String, PathBuf>,
    carried: &[(crate::fnda::Carried, PathBuf)],
    app: &str,
) -> Result<Manifest, String> {
    let info = crate::fnda::json_to_cbor(&serde_json::json!({ "app": app, "hashAlg": HASH_ALG }).to_string())?;
    let document = crate::fnda::json_to_cbor(document_json)?;
    let meshes: BTreeMap<String, PathBuf> =
        mesh_paths.iter().filter(|(k, p)| is_safe_key(k) && p.exists()).map(|(k, p)| (k.clone(), p.clone())).collect();
    let carried: Vec<(crate::fnda::Carried, PathBuf)> = carried.iter().filter(|(_, p)| p.exists()).cloned().collect();
    for src in blob_paths.values() {
        std::fs::metadata(src).map_err(|e| format!("could not read geometry {}: {e}", src.display()))?;
    }
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let tmp = temp_sibling(dest);
    let build = || -> Result<Vec<crate::fnda::Entry>, String> {
        let mut file = std::io::BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        let entries = crate::fnda::write(
            &mut file,
            &crate::fnda::document_sections(&info, &document, blob_paths, &meshes, &carried),
        )?;
        let file = file.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(entries)
    };
    let entries = match build() {
        Ok(e) => e,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Some(parent) = dest.parent() {
        fsync_dir(parent);
    }
    Ok(manifest_of(&entries, app))
}

/// The manifest a format 2 file implies, for callers written against the ZIP one.
fn manifest_of(entries: &[crate::fnda::Entry], app: &str) -> Manifest {
    Manifest {
        container: CONTAINER_VERSION,
        hash_alg: HASH_ALG.to_string(),
        app: app.to_string(),
        blobs: entries
            .iter()
            .filter(|e| e.kind == crate::fnda::KIND_GEOMETRY)
            .map(|e| BlobRow { entry: format!("geom/{}.bbrep", e.name), hash: e.name.clone(), bytes: e.raw_len })
            .collect(),
        meshes: entries
            .iter()
            .filter(|e| e.kind == crate::fnda::KIND_MESH)
            .map(|e| MeshRow { entry: format!("mesh/{}.bin", e.name), key: e.name.clone(), bytes: e.raw_len })
            .collect(),
    }
}

/// Publish a ZIP container (format 1) at `dest`, atomically. The app no longer writes it; kept so the old file reader
/// stays tested against real ones. `blob_paths` maps hash to a path with exactly the hashed bytes; `mesh_paths` is an
/// optional reopen cache. Built at a sibling temp path, fsynced, then renamed, so a crash never leaves a torn file.
pub fn write_zip_container(
    dest: &Path,
    document_json: &str,
    blob_paths: &BTreeMap<String, PathBuf>,
    mesh_paths: &BTreeMap<String, PathBuf>,
    app: &str,
) -> Result<Manifest, String> {
    let mut manifest = Manifest {
        container: CONTAINER_VERSION,
        hash_alg: HASH_ALG.to_string(),
        app: app.to_string(),
        blobs: Vec::new(),
        meshes: Vec::new(),
    };
    for (h, src) in blob_paths {
        let bytes =
            std::fs::metadata(src).map_err(|e| format!("could not read geometry {}: {e}", src.display()))?.len();
        manifest.blobs.push(BlobRow { entry: format!("geom/{h}.bbrep"), hash: h.clone(), bytes });
    }
    for (k, src) in mesh_paths {
        let bytes = match std::fs::metadata(src) {
            Ok(m) => m.len(),
            Err(_) => continue, // a cache entry that vanished is not an error
        };
        manifest.meshes.push(MeshRow { entry: format!("mesh/{k}.bin"), key: k.clone(), bytes });
    }

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let tmp = temp_sibling(dest);

    // Any failure past this point must not leave a temp file behind, and must
    // leave the previous file untouched.
    let build = || -> Result<(), String> {
        let file = File::create(&tmp).map_err(|e| e.to_string())?;
        let mut z = zip::ZipWriter::new(file);

        // STORED and first, so the manifest is readable by a hex dump or a
        // minimal reader with no decompressor in the loop.
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
        let deflated =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
        // Packed f32/u32 barely compresses; level 1 keeps the write fast.
        let deflated_fast = deflated.compression_level(Some(1));

        z.start_file(MANIFEST_NAME, stored).map_err(|e| e.to_string())?;
        let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        z.write_all(manifest_json.as_bytes()).map_err(|e| e.to_string())?;

        z.start_file(DOCUMENT_NAME, deflated).map_err(|e| e.to_string())?;
        z.write_all(document_json.as_bytes()).map_err(|e| e.to_string())?;

        for row in &manifest.blobs {
            z.start_file(&row.entry, deflated).map_err(|e| e.to_string())?;
            copy_into(&mut z, &blob_paths[&row.hash])?;
        }
        for row in &manifest.meshes {
            z.start_file(&row.entry, deflated_fast).map_err(|e| e.to_string())?;
            copy_into(&mut z, &mesh_paths[&row.key])?;
        }

        let mut file = z.finish().map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    };

    if let Err(e) = build() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Some(parent) = dest.parent() {
        fsync_dir(parent);
    }
    Ok(manifest)
}

/// Write a document in the format its extension names. A JSON file has no
/// sections, so `carried` is written to a binary one only.
pub fn write_document(
    dest: &Path,
    document_json: &str,
    blob_paths: &BTreeMap<String, PathBuf>,
    mesh_paths: &BTreeMap<String, PathBuf>,
    carried: &[(crate::fnda::Carried, PathBuf)],
    app: &str,
) -> Result<(), String> {
    if crate::json_doc::is_binary_doc_path(dest) {
        write_container(dest, document_json, blob_paths, mesh_paths, carried, app).map(|_| ())
    } else {
        crate::json_doc::write_json_document(dest, document_json, blob_paths)
    }
}

/// Open any document, whatever its extension says: the format is read from the
/// bytes, so a binary file renamed to `.funda` still opens.
pub fn open_document_checked(
    path: &Path,
    blob_dir: &Path,
    mesh_dir: Option<&Path>,
) -> Result<(String, crate::fnda::RepairReport), String> {
    if looks_like_container(path) {
        return read_container_checked(path, blob_dir, mesh_dir).map(|(doc, _, report)| (doc, report));
    }
    crate::json_doc::read_json_document(path, blob_dir).map(|doc| (doc, crate::fnda::RepairReport::default()))
}

pub struct OpenedFile {
    pub document: String,
    pub report: crate::fnda::RepairReport,
    pub carried: Vec<crate::fnda::Carried>,
}

/// `open_document_checked`, also copying the sections of a kind this version
/// does not read into `carry_dir`, so a save can write them back.
pub fn open_document_full(
    path: &Path,
    blob_dir: &Path,
    mesh_dir: Option<&Path>,
    carry_dir: Option<&Path>,
) -> Result<OpenedFile, String> {
    if crate::fnda::looks_like_fnda(path) {
        let o = crate::fnda::read_file(path, blob_dir, mesh_dir, carry_dir)?;
        return Ok(OpenedFile { document: o.document_json, report: o.report, carried: o.carried });
    }
    let (document, report) = open_document_checked(path, blob_dir, mesh_dir)?;
    Ok(OpenedFile { document, report, carried: Vec::new() })
}

pub struct OpenedBytes {
    pub document: String,
    pub report: crate::fnda::RepairReport,
    pub carried: Vec<crate::fnda::Carried>,
    pub was_container: bool,
}

/// `open_document_checked` for a document held as bytes with no path, like a file dropped on a webview that does not
/// name its paths. The readers need a seekable file, so the bytes are staged in a temp file first.
pub fn open_document_bytes(
    bytes: &[u8],
    blob_dir: &Path,
    mesh_dir: Option<&Path>,
    carry_dir: Option<&Path>,
) -> Result<OpenedBytes, String> {
    let staged = std::env::temp_dir().join(format!("fundacad-open-{}.tmp", uuid_hex()));
    std::fs::write(&staged, bytes).map_err(|e| format!("could not stage the document for opening ({e})"))?;
    let was_container = looks_like_container(&staged);
    let opened = open_document_full(&staged, blob_dir, mesh_dir, carry_dir);
    let _ = std::fs::remove_file(&staged);
    opened.map(|o| OpenedBytes { document: o.document, report: o.report, carried: o.carried, was_container })
}

fn copy_into<W: Write + Seek>(z: &mut zip::ZipWriter<W>, src: &Path) -> Result<(), String> {
    let mut f = File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
    std::io::copy(&mut f, z).map_err(|e| e.to_string())?;
    Ok(())
}

fn open_archive(path: &Path) -> Result<zip::ZipArchive<File>, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(f).map_err(|_| "This document is damaged and cannot be opened.".to_string())
}

/// Refuse a bomb BEFORE inflating anything.
fn guard(z: &mut zip::ZipArchive<File>) -> Result<(), String> {
    let mut total: u64 = 0;
    for i in 0..z.len() {
        total = total.saturating_add(z.by_index_raw(i).map_err(|e| e.to_string())?.size());
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err(format!(
                "This document expands to more than {} GiB and was refused.",
                MAX_TOTAL_UNCOMPRESSED >> 30
            ));
        }
    }
    Ok(())
}

/// The manifest alone, without inflating any geometry. The error strings are
/// user-facing.
pub fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let mut z = open_archive(path)?;
    guard(&mut z)?;
    let mut raw = String::new();
    z.by_name(MANIFEST_NAME)
        .map_err(|_| "This document is missing its manifest and cannot be opened.".to_string())?
        .read_to_string(&mut raw)
        .map_err(|_| "This document has an unreadable manifest and cannot be opened.".to_string())?;
    let manifest: Manifest = serde_json::from_str(&raw)
        .map_err(|_| "This document has an unreadable manifest and cannot be opened.".to_string())?;

    if manifest.container > CONTAINER_VERSION {
        return Err(format!(
            "This document uses a newer FundaCAD container format (v{}). \
             Update FundaCAD to open it.",
            manifest.container
        ));
    }
    if manifest.hash_alg != HASH_ALG {
        return Err(format!("This document uses an unsupported hash ({}).", manifest.hash_alg));
    }
    Ok(manifest)
}

/// Open a container: extract its geometry into `blob_dir` and return `(document_json, manifest)`. Each blob streams to
/// a temp file while hashed and publishes under that hash only when it matches the manifest; a mismatch means
/// truncation or tampering and is a hard error.
pub fn read_container(path: &Path, blob_dir: &Path, mesh_dir: Option<&Path>) -> Result<(String, Manifest), String> {
    read_container_checked(path, blob_dir, mesh_dir).map(|(doc, manifest, _)| (doc, manifest))
}

/// As `read_container`, also saying what had to be repaired on the way in.
pub fn read_container_checked(
    path: &Path,
    blob_dir: &Path,
    mesh_dir: Option<&Path>,
) -> Result<(String, Manifest, crate::fnda::RepairReport), String> {
    if crate::fnda::looks_like_fnda(path) {
        let opened = crate::fnda::read_file(path, blob_dir, mesh_dir, None)?;
        let manifest = manifest_of(&opened.entries, "");
        return Ok((opened.document_json, manifest, opened.report));
    }
    read_zip_container(path, blob_dir, mesh_dir)
        .map(|(doc, manifest)| (doc, manifest, crate::fnda::RepairReport::default()))
}

fn read_zip_container(path: &Path, blob_dir: &Path, mesh_dir: Option<&Path>) -> Result<(String, Manifest), String> {
    let manifest = read_manifest(path)?;
    std::fs::create_dir_all(blob_dir).map_err(|e| e.to_string())?;
    if let Some(d) = mesh_dir {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }

    let mut z = open_archive(path)?;
    let mut document_json = String::new();
    z.by_name(DOCUMENT_NAME)
        .map_err(|_| "This document is missing its contents and cannot be opened.".to_string())?
        .read_to_string(&mut document_json)
        .map_err(|_| "This document is damaged and cannot be opened.".to_string())?;

    for row in &manifest.blobs {
        let final_path = blob_dir.join(format!("{}.bbrep", row.hash));
        if final_path.exists() {
            continue; // same hash => same bytes; nothing to do
        }
        extract_verified(&mut z, &row.entry, Some(&row.hash), &final_path, blob_dir)?;
    }

    if let Some(dir) = mesh_dir {
        for row in &manifest.meshes {
            // Keys land in a filename, so validate rather than trust the file. Meshes are derived data: a bad row costs
            // a re-tessellation and must never fail an open.
            if !is_safe_key(&row.key) {
                continue;
            }
            let dest = dir.join(format!("{}.bin", row.key));
            let _ = extract_verified(&mut z, &row.entry, None, &dest, dir);
        }
    }

    Ok((document_json, manifest))
}

fn extract_verified(
    z: &mut zip::ZipArchive<File>,
    entry: &str,
    want_hash: Option<&str>,
    final_path: &Path,
    dest_dir: &Path,
) -> Result<(), String> {
    let tmp = temp_sibling(final_path);
    let mut run = || -> Result<(), String> {
        let mut src =
            z.by_name(entry).map_err(|_| format!("This document is missing part of its geometry ({entry})."))?;
        let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
        let mut h = Blake2b128::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = src.read(&mut buf).map_err(|_| "This document is damaged and cannot be opened.".to_string())?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
        out.flush().map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        if let Some(want) = want_hash {
            if hex(&h.finalize()) != want {
                return Err("This document's geometry does not match its manifest, the file \
                            is damaged or was modified. Opening it was refused rather than \
                            showing you the wrong shape."
                    .to_string());
            }
        }
        Ok(())
    };
    if let Err(e) = run() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, final_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    fsync_dir(dest_dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fundacad_container_{tag}_{}", uuid_hex()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Zip-slip: an archive naming its blob `../../evil` must not write there.
    /// The destination comes from the hash WE computed, so the name is inert.
    #[test]
    fn entry_names_are_never_used_as_paths() {
        let dir = tmpdir("slip");
        let data = b"payload".repeat(100);
        let h = hash_bytes(&data);
        let evil = dir.join("evil.funda");
        {
            let mut z = zip::ZipWriter::new(File::create(&evil).unwrap());
            let opts = SimpleFileOptions::default();
            let manifest = Manifest {
                container: 1,
                hash_alg: HASH_ALG.to_string(),
                app: String::new(),
                blobs: vec![BlobRow {
                    entry: "../../../../tmp/pwned.bbrep".into(),
                    hash: h.clone(),
                    bytes: data.len() as u64,
                }],
                meshes: vec![MeshRow { entry: "m".into(), key: "../../pwned".into(), bytes: 1 }],
            };
            z.start_file(MANIFEST_NAME, opts).unwrap();
            z.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
            z.start_file(DOCUMENT_NAME, opts).unwrap();
            z.write_all(br#"{"version":5}"#).unwrap();
            z.start_file("../../../../tmp/pwned.bbrep", opts).unwrap();
            z.write_all(&data).unwrap();
            z.finish().unwrap();
        }

        let out = dir.join("blobs");
        read_container(&evil, &out, Some(&dir.join("meshes"))).unwrap();
        let names: Vec<_> =
            std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec![format!("{h}.bbrep")], "nothing escaped the store");
        assert!(!is_safe_key("../../pwned"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
