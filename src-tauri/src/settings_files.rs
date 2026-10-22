//! Settings files Rust reads from the app data dir. One that does not parse is moved aside first, since read as empty
//! the next save would overwrite it.

use std::path::{Path, PathBuf};

fn unix_secs() -> u64 {
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
    fn an_unreadable_settings_file_is_renamed_with_the_time() {
        let d = dir("bad");
        let plugins = d.join("plugins");
        std::fs::create_dir_all(plugins.join("good")).unwrap();
        std::fs::create_dir_all(plugins.join("broken")).unwrap();
        std::fs::write(d.join("launch-approvals.json"), "{\"a\": [").unwrap();
        std::fs::write(plugins.join("good/installed.json"), "{\"id\":\"good\"}").unwrap();
        std::fs::write(plugins.join("broken/installed.json"), "").unwrap();

        let moved = check_settings(&d, &plugins, "installed.json");
        assert_eq!(moved.len(), 2, "{moved:?}");
        assert!(!d.join("launch-approvals.json").exists());
        assert!(!plugins.join("broken/installed.json").exists());
        assert_eq!(std::fs::read_to_string(plugins.join("good/installed.json")).unwrap(), "{\"id\":\"good\"}");
        let name = moved[0].file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("launch-approvals.json.bad-"), "{name}");
        assert_eq!(std::fs::read_to_string(&moved[0]).unwrap(), "{\"a\": [");
        assert!(check_settings(&d, &plugins, "installed.json").is_empty());
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
