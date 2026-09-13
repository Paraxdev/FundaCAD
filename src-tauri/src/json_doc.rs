//! The readable document file: `.funda` is pretty JSON, `.fundab` is the binary
//! format in fnda.rs, the way `.gcode` and `.bgcode` split.
//!
//! JSON has nowhere to put an imported body's BREP, so the geometry the document
//! references rides along in one top-level map, content hash to base64 BinTools
//! bytes, written LAST so the feature tree is what a person sees first. Opening
//! publishes each blob into the store only once its bytes prove the hash, the
//! same rule the binary and ZIP readers follow.
//!
//! No Tauri in here, so the file can be compiled and tested on its own where the
//! app's test binary cannot start (see scripts/check-plugin-guards.sh).

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
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(BINARY_DOC_EXT))
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

/// Publish a document at `dest` as pretty JSON, atomically.
///
/// The geometry map is spliced onto the end of the frontend's own text rather
/// than re-serialised, because serde_json sorts keys and the file is meant to be
/// read by a person.
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

/// Open a JSON document: publish its embedded geometry into `blob_dir`, each blob
/// verified against its hash, and return the document without the geometry map.
/// Text that is not a JSON object comes back untouched, so the frontend reports
/// it the way it always has.
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

    fn tmpdir(tag: &str) -> PathBuf {
        let mut b = [0u8; 8];
        getrandom::getrandom(&mut b).unwrap();
        let d = std::env::temp_dir().join(format!("fundacad_jsondoc_{tag}_{}", u64::from_le_bytes(b)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn blob(dir: &Path, data: &[u8]) -> (String, BTreeMap<String, PathBuf>) {
        let h = hash_hex(data);
        let p = dir.join(format!("{h}.src"));
        std::fs::write(&p, data).unwrap();
        (h.clone(), BTreeMap::from([(h, p)]))
    }

    fn pretty_doc(hash: &str) -> String {
        format!("{{\n  \"version\": 9,\n  \"features\": [\n    {{\n      \"id\": \"im\",\n      \"type\": \"import\",\n      \"geom\": \"{hash}\"\n    }}\n  ]\n}}")
    }

    #[test]
    fn hash_matches_the_blob_store() {
        assert_eq!(hash_hex(b"fundacad"), "5648909c8c0ccf6096c0e672255e68a0");
    }

    #[test]
    fn only_the_binary_extension_is_binary() {
        assert!(is_binary_doc_path(Path::new("a/part.fundab")));
        assert!(is_binary_doc_path(Path::new("PART.FUNDAB")));
        for p in ["part.funda", "part.neocad", "part.sindri", "part.json", "part", "fundab"] {
            assert!(!is_binary_doc_path(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn round_trips_its_geometry_and_keeps_the_text_readable() {
        let dir = tmpdir("rt");
        let data: Vec<u8> = (0..150_000u32).map(|i| (i.wrapping_mul(2246822519) >> 16) as u8).collect();
        let (h, blobs) = blob(&dir, &data);
        let doc = pretty_doc(&h);
        let dest = dir.join("part.funda");
        write_json_document(&dest, &doc, &blobs).unwrap();

        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.starts_with(&doc[..doc.len() - 2]), "the frontend's text is kept as written");
        assert!(text.find("\"features\"").unwrap() < text.find("\"geometry\"").unwrap());

        let store = dir.join("blobs");
        let opened = read_json_document(&dest, &store).unwrap();
        let got: serde_json::Value = serde_json::from_str(&opened).unwrap();
        let want: serde_json::Value = serde_json::from_str(&doc).unwrap();
        assert_eq!(got, want, "the geometry map is removed, everything else survives");
        assert_eq!(std::fs::read(store.join(format!("{h}.bbrep"))).unwrap(), data);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_geometry_is_refused_and_nothing_is_published() {
        let dir = tmpdir("tamper");
        let data = vec![5u8; 9_000];
        let (h, blobs) = blob(&dir, &data);
        let dest = dir.join("part.funda");
        write_json_document(&dest, &pretty_doc(&h), &blobs).unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        let at = text.find(&format!("\"{h}\": \"")).unwrap() + 40;
        let mut bytes = text.into_bytes();
        bytes[at] = if bytes[at] == b'A' { b'Q' } else { b'A' };
        std::fs::write(&dest, bytes).unwrap();

        let store = dir.join("blobs");
        let err = read_json_document(&dest, &store).unwrap_err();
        assert!(err.contains("does not match") || err.contains("damaged"), "unexpected: {err}");
        assert!(!store.join(format!("{h}.bbrep")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_document_without_geometry_is_passed_through_untouched() {
        let dir = tmpdir("plain");
        let dest = dir.join("part.funda");
        write_json_document(&dest, "{}", &BTreeMap::new()).unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "{\n}\n");
        let doc = "{\n  \"version\": 9,\n  \"features\": []\n}";
        write_json_document(&dest, doc, &BTreeMap::new()).unwrap();
        assert_eq!(read_json_document(&dest, &dir.join("blobs")).unwrap(), format!("{doc}\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_object_still_gets_a_valid_geometry_map() {
        let dir = tmpdir("empty");
        let (h, blobs) = blob(&dir, b"payload");
        let dest = dir.join("part.funda");
        write_json_document(&dest, "{}", &blobs).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
        assert!(v["geometry"][&h].is_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_document_that_already_uses_the_key() {
        let dir = tmpdir("clash");
        let err = write_json_document(&dir.join("p.funda"), r#"{"geometry":1}"#, &BTreeMap::new()).unwrap_err();
        assert!(err.contains("already has"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
