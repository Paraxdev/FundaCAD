//! Crash recovery snapshots in app_data_dir()/recovery/, one file per slot. The commands in lib.rs resolve the
//! directory and call these.

use std::path::{Path, PathBuf};

use crate::{DOC_EXT, LEGACY_DOC_EXTS};

/// Slot names are caller chosen but sanitized hard: they become file names.
fn safe_name(slot: &str) -> Result<String, String> {
    let safe: String = slot
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    if safe.is_empty() {
        return Err("empty recovery slot".into());
    }
    Ok(safe)
}

/// Every file a slot may live in, the current name first. A snapshot from before the rename still belongs to its slot.
fn candidates(dir: &Path, slot: &str) -> Result<Vec<PathBuf>, String> {
    let safe = safe_name(slot)?;
    Ok(std::iter::once(DOC_EXT)
        .chain(LEGACY_DOC_EXTS)
        .map(|ext| dir.join(format!("{safe}.{ext}")))
        .collect())
}

pub fn write(dir: &Path, slot: &str, json: &str) -> Result<(), String> {
    let path = dir.join(format!("{}.{DOC_EXT}", safe_name(slot)?));
    let tmp = path.with_extension(concat!("funda", ".tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn read(dir: &Path, slot: &str) -> Result<Option<String>, String> {
    for path in candidates(dir, slot)? {
        match std::fs::read_to_string(&path) {
            Ok(s) => return Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(None)
}

/// Slots with their last modified time (ms since epoch), newest first.
pub fn list(dir: &Path) -> Result<Vec<(String, u64)>, String> {
    let mut out: Vec<(String, u64)> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        match p.extension().and_then(|e| e.to_str()) {
            Some(e) if e == DOC_EXT || LEGACY_DOC_EXTS.contains(&e) => {}
            _ => continue,
        }
        let name = match p.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some((_, t)) => *t = (*t).max(mtime),
            None => out.push((name, mtime)),
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(out)
}

pub fn clear(dir: &Path, slot: &str) -> Result<(), String> {
    for path in candidates(dir, slot)? {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
