//! The readable `.funda`, pretty JSON. JSON has nowhere for an import's BREP, so the referenced geometry rides in one
//! top-level map of content hash to base64 BinTools bytes, written last so a person sees the feature tree first.
//! Opening publishes each blob only once its bytes prove the hash, as the binary and ZIP readers do.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use blake2::digest::consts::U16;
use blake2::{Blake2b, Digest};

/// The extension that selects the binary format. `.funda` and every other
/// document extension is written as JSON.
pub const BINARY_DOC_EXT: &str = "fundab";

/// Top-level key of a JSON document holding the geometry its imports reference.
pub const EMBEDDED_GEOMETRY_KEY: &str = "geometry";

const MAX_TOTAL: u64 = 8 << 30;

const DAMAGED: &str = "This document's embedded geometry is damaged and cannot be opened.";

type Blake2b128 = Blake2b<U16>;

pub fn is_binary_doc_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(BINARY_DOC_EXT))
}

fn is_hash(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hash_hex(data: &[u8]) -> String {
    let mut h = Blake2b128::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn temp_sibling(target: &Path) -> PathBuf {
    let mut b = [0u8; 8];
    let _ = getrandom::getrandom(&mut b);
    let mut n = target.as_os_str().to_os_string();
    n.push(format!(".tmp-{}-{}", std::process::id(), u64::from_le_bytes(b)));
    PathBuf::from(n)
}

fn fsync_dir(dir: &Path) {
    if let Ok(f) = File::open(dir) {
        let _ = f.sync_all();
    }
}

/// Publish a document at `dest` as pretty JSON, atomically. The geometry map is spliced onto the frontend's own text
/// rather than reserialised, because serde_json sorts keys and the file is meant for a person to read.
pub fn write_json_document(
    dest: &Path,
    document_json: &str,
    blob_paths: &BTreeMap<String, PathBuf>,
) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(document_json).map_err(|e| format!("the document is not valid JSON: {e}"))?;
    let obj = value.as_object().ok_or("the document is not a JSON object")?;
    if obj.contains_key(EMBEDDED_GEOMETRY_KEY) {
        return Err(format!("the document already has a `{EMBEDDED_GEOMETRY_KEY}` field"));
    }
    for (hash, src) in blob_paths {
        if !is_hash(hash) {
            return Err(format!("not a geometry hash: {hash}"));
        }
        std::fs::metadata(src).map_err(|e| format!("could not read geometry {}: {e}", src.display()))?;
    }
    let trimmed = document_json.trim_end();
    let body = trimmed[..trimmed.len() - 1].trim_end();

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let tmp = temp_sibling(dest);
    let build = || -> Result<(), String> {
        let mut out = std::io::BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        let w = |out: &mut std::io::BufWriter<File>, s: &str| out.write_all(s.as_bytes()).map_err(|e| e.to_string());
        w(&mut out, body)?;
        if !blob_paths.is_empty() {
            if body != "{" {
                w(&mut out, ",")?;
            }
            w(&mut out, &format!("\n  \"{EMBEDDED_GEOMETRY_KEY}\": {{"))?;
            for (i, (hash, src)) in blob_paths.iter().enumerate() {
                w(&mut out, &format!("{}\n    \"{hash}\": \"", if i == 0 { "" } else { "," }))?;
                let mut f = File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
                {
                    let mut enc =
                        base64::write::EncoderWriter::new(&mut out, &base64::engine::general_purpose::STANDARD);
                    std::io::copy(&mut f, &mut enc).map_err(|e| e.to_string())?;
                    enc.finish().map_err(|e| e.to_string())?;
                }
                w(&mut out, "\"")?;
            }
            w(&mut out, "\n  }")?;
        }
        w(&mut out, "\n}\n")?;
        let file = out.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
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
    Ok(())
}

/// Open a JSON document: publish its geometry into `blob_dir`, each blob verified against its hash, and return the
/// document without the map. Text that is not a JSON object comes back untouched for the frontend to report.
pub fn read_json_document(path: &Path, blob_dir: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if !text.contains(&format!("\"{EMBEDDED_GEOMETRY_KEY}\"")) {
        return Ok(text);
    }
    let mut value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(text),
    };
    let Some(geometry) = value.as_object_mut().and_then(|o| o.remove(EMBEDDED_GEOMETRY_KEY)) else {
        return Ok(text);
    };
    let map = geometry.as_object().ok_or(DAMAGED)?;
    std::fs::create_dir_all(blob_dir).map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    for (hash, data) in map {
        let b64 = data.as_str().filter(|_| is_hash(hash)).ok_or(DAMAGED)?;
        total = total.saturating_add(b64.len() as u64 / 4 * 3);
        if total > MAX_TOTAL {
            return Err(format!("This document expands to more than {} GiB and was refused.", MAX_TOTAL >> 30));
        }
        let final_path = blob_dir.join(format!("{hash}.bbrep"));
        if final_path.exists() {
            continue;
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| DAMAGED.to_string())?;
        if hash_hex(&bytes) != *hash {
            return Err("This document's geometry does not match its hash, the file is damaged \
                        or was modified. Opening it was refused rather than showing you the \
                        wrong shape."
                .to_string());
        }
        let tmp = temp_sibling(&final_path);
        let publish = || -> Result<(), String> {
            let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
            out.write_all(&bytes).map_err(|e| e.to_string())?;
            out.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())
        };
        if let Err(e) = publish() {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    }
    fsync_dir(blob_dir);
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_the_blob_store() {
        assert_eq!(hash_hex(b"fundacad"), "5648909c8c0ccf6096c0e672255e68a0");
    }
}
