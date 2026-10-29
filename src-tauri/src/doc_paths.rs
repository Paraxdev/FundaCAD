//! Which paths the document commands may touch. A network or device path is opened only when the person handed it over
//! in this session, through a dialog, a launch argument, a drop or the recent list. Tauri free so the unit tests can
//! drive it.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// A cap rather than an expiry, like plugins::handed::MAX_HELD: it bounds the set without taking away a recent choice.
pub const MAX_VOUCHED: usize = 256;

fn is_sep(b: u8) -> bool {
    b == b'\\' || b == b'/'
}

/// UNC, device namespace and verbatim forms all start with two separators. Windows also passes an NT object path that
/// starts with a separator, `??` and a separator straight through, so that form counts too.
pub fn is_remote_or_device(raw: &str) -> bool {
    let b = raw.as_bytes();
    if b.len() >= 2 && is_sep(b[0]) && is_sep(b[1]) {
        return true;
    }
    if b.len() >= 4 && is_sep(b[0]) && b[1] == b'?' && b[2] == b'?' && is_sep(b[3]) {
        return true;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if let Some(Component::Prefix(p)) = Path::new(raw).components().next() {
            return !matches!(p.kind(), Prefix::Disk(_));
        }
    }
    false
}

/// Windows compares paths without case and treats both separators alike, so the key does too there.
fn key_of(raw: &str) -> String {
    if cfg!(windows) {
        raw.replace('/', "\\").to_lowercase()
    } else {
        raw.to_string()
    }
}

/// In memory only, so a network path vouched for today is not trusted tomorrow from a document alone.
#[derive(Default)]
pub struct Vouched(VecDeque<String>);

impl Vouched {
    pub fn vouch(&mut self, raw: &str) {
        let key = key_of(raw);
        self.0.retain(|k| *k != key);
        if self.0.len() >= MAX_VOUCHED {
            self.0.pop_front();
        }
        self.0.push_back(key);
    }

    pub fn contains(&self, raw: &str) -> bool {
        let key = key_of(raw);
        self.0.iter().any(|k| *k == key)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// A string check only, so a refused path never reaches the file system (which would authenticate to a remote host).
pub fn refuse_unvouched(raw: &str, vouched: &Vouched) -> Result<(), String> {
    if is_remote_or_device(raw) && !vouched.contains(raw) {
        return Err(format!(
            "{raw} is a network or device path. FundaCAD opens one only after it is picked in a dialog, dropped, \
             passed at launch or chosen from the recent list"
        ));
    }
    Ok(())
}

/// The provenance check, then a regular file, so a device node or a pipe is never opened.
pub fn check_open(raw: &str, vouched: &Vouched) -> Result<PathBuf, String> {
    refuse_unvouched(raw, vouched)?;
    require_file(raw)
}

pub fn require_file(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(path.to_path_buf()),
        Ok(_) => Err(format!("{raw} is not a file")),
        Err(e) => Err(format!("{raw}: {e}")),
    }
}

/// What a link compares on open instead of the linked file's content.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocStat {
    pub size: u64,
    pub mtime_ms: u64,
}

/// Metadata only, the file is never opened. None when nothing is there.
pub fn stat_path(raw: &str) -> Result<Option<DocStat>, String> {
    match std::fs::metadata(raw) {
        Ok(meta) if meta.is_file() => {
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
            Ok(Some(DocStat { size: meta.len(), mtime_ms }))
        }
        Ok(_) => Err(format!("{raw} is not a file")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{raw}: {e}")),
    }
}

/// Only an absolute path with a document extension, so a save never writes any other kind of file.
pub fn check_save(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("{raw} is not a full path, so it was not saved."));
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let ours = [crate::DOC_EXT, fundacad_format::json_doc::BINARY_DOC_EXT]
        .into_iter()
        .chain(crate::LEGACY_DOC_EXTS)
        .any(|e| e.eq_ignore_ascii_case(ext));
    if !ours {
        return Err("FundaCAD saves documents only as .funda, .fundab, .neocad or .sindri files.".to_string());
    }
    Ok(path.to_path_buf())
}

/// The app state the open commands consult. The lock covers the string check only, so a slow network stat never
/// holds up another command.
#[derive(Default)]
pub struct Provenance(Mutex<Vouched>);

impl Provenance {
    pub fn vouch_all<'a>(&self, paths: impl IntoIterator<Item = &'a str>) {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for p in paths {
            held.vouch(p);
        }
    }

    pub fn refuse_unvouched(&self, raw: &str) -> Result<(), String> {
        refuse_unvouched(raw, &self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn check_open(&self, raw: &str) -> Result<PathBuf, String> {
        self.refuse_unvouched(raw)?;
        require_file(raw)
    }

    pub fn stat(&self, raw: &str) -> Result<Option<DocStat>, String> {
        self.refuse_unvouched(raw)?;
        stat_path(raw)
    }
}
