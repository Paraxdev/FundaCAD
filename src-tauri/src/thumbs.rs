//! Preview pictures for Home's cards, cached in app data. Served only while the document keeps the time and size it had
//! when taken, so an outside edit shows a placeholder. No Tauri in here, see library.rs.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::library::stat_one;

pub const GET_CAP: usize = 48;
pub const MAX_BYTES: usize = 512 * 1024;
pub const KEEP: usize = 1000;

const JPEG: &str = "data:image/jpeg;base64,";
const PNG: &str = "data:image/png;base64,";

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    path: String,
    mtime_ms: Option<u64>,
    size: Option<u64>,
    mime: String,
}

fn key(path: &str) -> String {
    fundacad_format::container::hash_bytes(path.as_bytes())
}

fn decode(data_url: &str) -> Result<(&'static str, Vec<u8>), String> {
    let (mime, body) = if let Some(b) = data_url.strip_prefix(JPEG) {
        ("image/jpeg", b)
    } else if let Some(b) = data_url.strip_prefix(PNG) {
        ("image/png", b)
    } else {
        return Err("a preview must be a JPEG or PNG data URL".into());
    };
    if body.len() > MAX_BYTES * 4 / 3 + 4 {
        return Err("the preview is too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(body).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("the preview is too large".into());
    }
    Ok((mime, bytes))
}

pub fn put(dir: &Path, path: &str, data_url: &str) -> Result<(), String> {
    let (mime, bytes) = decode(data_url)?;
    let st = stat_one(path);
    if !st.exists {
        return Err("the document is not on disk".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let k = key(path);
    let side = Sidecar { path: path.to_string(), mtime_ms: st.mtime_ms, size: st.size, mime: mime.into() };
    let img = dir.join(format!("{k}.img"));
    let json = dir.join(format!("{k}.json"));
    write_atomic(&img, &bytes)?;
    write_atomic(&json, serde_json::to_string(&side).map_err(|e| e.to_string())?.as_bytes())?;
    prune(dir, KEEP);
    Ok(())
}

/// A save and the capture after an open can put one document's picture at once,
/// so every write gets a temporary file of its own.
fn tmp_path(target: &Path) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = target.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    target.with_file_name(format!("{name}.{}.{n}.tmp", std::process::id()))
}

fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = tmp_path(target);
    let done = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, target));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done.map_err(|e| e.to_string())
}

pub fn get_one(dir: &Path, path: &str) -> Option<String> {
    let k = key(path);
    let side: Sidecar = serde_json::from_slice(&std::fs::read(dir.join(format!("{k}.json"))).ok()?).ok()?;
    let st = stat_one(path);
    if side.path != path || !st.exists || side.mtime_ms != st.mtime_ms || side.size != st.size {
        return None;
    }
    let bytes = std::fs::read(dir.join(format!("{k}.img"))).ok()?;
    let prefix = if side.mime == "image/png" { PNG } else { JPEG };
    Some(format!("{prefix}{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

pub fn get_all(dir: &Path, paths: &[String]) -> Vec<Option<String>> {
    paths.iter().take(GET_CAP).map(|p| get_one(dir, p)).collect()
}

/// Keeps the `keep` most recently written pictures.
pub fn prune(dir: &Path, keep: usize) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut sides: Vec<(std::time::SystemTime, PathBuf)> = read
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    if sides.len() <= keep {
        return;
    }
    sides.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, side) in sides.into_iter().skip(keep) {
        let _ = std::fs::remove_file(side.with_extension("img"));
        let _ = std::fs::remove_file(&side);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_never_share_a_temporary_file() {
        let dir = Path::new("thumbs");
        let a = tmp_path(&dir.join("k.img"));
        let b = tmp_path(&dir.join("k.img"));
        let c = tmp_path(&dir.join("k.json"));
        assert_ne!(a, b);
        assert_ne!(a.file_stem(), c.file_stem());
        assert!(a.to_string_lossy().ends_with(".tmp"));
    }
}
