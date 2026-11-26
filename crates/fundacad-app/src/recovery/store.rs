//! The snapshots on disk, FundaCAD 1's recovery_* commands. Each running app owns one slot in `<config>/recovery`:
//! `<id>.funda` (written as Save writes, so imported geometry comes back), `<id>.json` saying where it came from and
//! when, and `<id>.lock`, held locked while the app runs. A slot whose lock is free belongs to an app that is gone.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fundacad_client::Doc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    /// Where the document was last saved, None when it never was.
    pub source: Option<PathBuf>,
    #[serde(rename = "savedAt")]
    pub saved_at: u64,
}

/// A snapshot an app that is gone left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leftover {
    pub id: String,
    pub doc: PathBuf,
    pub envelope: Envelope,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn doc_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.funda"))
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn lock_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.lock"))
}

/// This app's slot. Dropping it frees the lock, the snapshot stays until `clear`.
pub struct Own {
    dir: PathBuf,
    id: String,
    _lock: File,
}

impl Own {
    pub fn claim(dir: &Path, id: String) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = lock_path(dir, &id);
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        lock.try_lock().map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self { dir: dir.to_path_buf(), id, _lock: lock })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn clear(&self) {
        remove_snapshot(&self.dir, &self.id);
    }
}

impl Drop for Own {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(lock_path(&self.dir, &self.id));
    }
}

/// Writes a slot's snapshot, the document first, so an envelope always has a whole document beside it.
pub fn write_slot(dir: &Path, id: &str, doc: &Doc, blob_dir: Option<&Path>, envelope: &Envelope) -> Result<(), String> {
    let tmp = dir.join(format!("{id}.tmp.funda"));
    crate::files::write(&tmp, doc, blob_dir)?;
    let target = doc_path(dir, id);
    std::fs::rename(&tmp, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    let meta = meta_path(dir, id);
    let text = serde_json::to_string(envelope).map_err(|e| e.to_string())?;
    std::fs::write(&meta, text).map_err(|e| format!("{}: {e}", meta.display()))
}

fn remove_snapshot(dir: &Path, id: &str) {
    let _ = std::fs::remove_file(meta_path(dir, id));
    let _ = std::fs::remove_file(doc_path(dir, id));
}

/// Whether the app that owns `id` still runs.
fn alive(dir: &Path, id: &str) -> bool {
    let Ok(lock) = OpenOptions::new().write(true).open(lock_path(dir, id)) else { return false };
    lock.try_lock().is_err()
}

/// What apps that are gone left, newest first. `own` is never listed.
pub fn leftovers(dir: &Path, own: Option<&str>) -> Vec<Leftover> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Leftover> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_owned();
            if Some(id.as_str()) == own || alive(dir, &id) {
                return None;
            }
            let envelope = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok())?;
            let doc = doc_path(dir, &id);
            doc.is_file().then_some(Leftover { id, doc, envelope })
        })
        .collect();
    out.sort_by(|a, b| b.envelope.saved_at.cmp(&a.envelope.saved_at).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Deletes a leftover snapshot, unless its app has come back.
pub fn discard(dir: &Path, id: &str) {
    if alive(dir, id) {
        return;
    }
    remove_snapshot(dir, id);
    let _ = std::fs::remove_file(lock_path(dir, id));
}

/// The recovery question, FundaCAD 1's recovery.ask.
pub fn question(envelope: &Envelope, now_ms: u64) -> String {
    let from = envelope
        .source
        .as_deref()
        .and_then(Path::file_name)
        .map_or_else(|| "an unsaved document".to_owned(), |n| n.to_string_lossy().into_owned());
    let age = (now_ms.saturating_sub(envelope.saved_at) as f64 / 60_000.0).round().max(1.0) as u64;
    format!("Recover unsaved work? ({from}, ~{age} min old)")
}
