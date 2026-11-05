//! Settings files Rust reads from the app data dir. One that does not parse is moved aside first, since read as empty
//! the next save would overwrite it.

use std::path::{Path, PathBuf};

pub fn unix_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Rename `path` to `<name>.bad-<unix secs>`, with `-<n>` added when that name
/// is taken, and return where it went.
pub fn back_up(path: &Path) -> std::io::Result<PathBuf> {
    back_up_at(path, unix_secs())
}

fn back_up_at(path: &Path, secs: u64) -> std::io::Result<PathBuf> {
    let name = path.file_name().ok_or_else(|| std::io::Error::other("no file name"))?.to_string_lossy().into_owned();
    let base = format!("{name}.bad-{secs}");
    let mut target = path.with_file_name(&base);
    let mut n = 1;
    while target.exists() {
        target = path.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    std::fs::rename(path, &target)?;
    Ok(target)
}

/// Move a JSON settings file that exists but does not parse out of the way.
pub fn check_json(path: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(path).ok()?;
    if serde_json::from_slice::<serde_json::Value>(&bytes).is_ok() {
        return None;
    }
    back_up(path).ok()
}

/// Check each settings file and return where the unreadable ones went.
pub fn check_settings(app_data: &Path, plugins_root: &Path, record: &str) -> Vec<PathBuf> {
    let mut files = vec![app_data.join("launch-approvals.json")];
    if let Ok(entries) = std::fs::read_dir(plugins_root) {
        files.extend(entries.flatten().map(|e| e.path().join(record)));
    }
    files.iter().filter_map(|f| check_json(f)).collect()
}

pub const BACKUPS: &str = "settings-backups";
pub const BACKUPS_KEPT: usize = 10;

/// `settings-<secs>.json` or `settings-<secs>-<n>.json` as `(secs, n)`, so the newest sorts last.
fn backup_order(name: &str) -> Option<(u64, u32)> {
    let stem = name.strip_prefix("settings-")?.strip_suffix(".json")?;
    match stem.split_once('-') {
        None => Some((stem.parse().ok()?, 0)),
        Some((secs, n)) => Some((secs.parse().ok()?, n.parse().ok()?)),
    }
}

/// Writes the page's settings backup (Reset settings) as `settings-<secs>.json` in `dir`, with `-<n>` added when that
/// name is taken, and keeps the newest `keep` backups.
pub fn write_backup(dir: &Path, secs: u64, text: &str, keep: usize) -> std::io::Result<PathBuf> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let mut n = 0;
    let (target, mut file) = loop {
        let name = if n == 0 { format!("settings-{secs}.json") } else { format!("settings-{secs}-{n}.json") };
        let target = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(file) => break (target, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    };
    if let Err(e) = file.write_all(text.as_bytes()).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&target);
        return Err(e);
    }
    drop(file);
    let mut backups: Vec<((u64, u32), PathBuf)> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|e| Some((backup_order(e.file_name().to_str()?)?, e.path())))
        .collect();
    backups.sort_by_key(|(order, _)| *order);
    let old = backups.len().saturating_sub(keep);
    for (_, path) in backups.drain(..old) {
        let _ = std::fs::remove_file(path);
    }
    Ok(std::path::absolute(&target).unwrap_or(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fundacad-settings-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_second_back_up_in_the_same_second_gets_its_own_name() {
        let d = dir("collide");
        let f = d.join("x.json");
        std::fs::write(&f, "1").unwrap();
        let a = back_up_at(&f, 7).unwrap();
        std::fs::write(&f, "2").unwrap();
        let b = back_up_at(&f, 7).unwrap();
        assert_eq!(a.file_name().unwrap(), "x.json.bad-7");
        assert_eq!(b.file_name().unwrap(), "x.json.bad-7-1");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "1");
    }
}
