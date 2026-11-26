//! The app's own settings, one JSON object in `settings.json` under FundaCAD 2's config folder. Each owner reads and
//! writes its key, so a key this build does not know is kept as it was.

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::{LazyLock, Mutex, PoisonError};

use gpui::App;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

/// Tests and test runs point this at a temp folder, so they never read or write the real settings.
pub const DIR_ENV: &str = "FUNDA_CONFIG_DIR";
const APP_DIR: &str = "FundaCAD 2";
const FILE: &str = "settings.json";

/// The folder the settings live in, None when the OS names no config folder.
pub fn config_dir() -> Option<PathBuf> {
    dir_from(std::env::var_os(DIR_ENV), dirs::config_dir())
}

fn dir_from(env: Option<OsString>, os: Option<PathBuf>) -> Option<PathBuf> {
    match env.filter(|v| !v.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => os.map(|d| d.join(APP_DIR)),
    }
}

#[derive(Debug, Default)]
pub struct Store {
    path: Option<PathBuf>,
    values: Map<String, Value>,
}

impl Store {
    /// A file that is not a JSON object is moved aside to `settings.json.bad`, so the next save does not lose it.
    pub fn load(dir: Option<&Path>) -> Self {
        let Some(dir) = dir else { return Self::default() };
        let path = dir.join(FILE);
        let values = match std::fs::read_to_string(&path) {
            // Notepad may save the file with a byte order mark.
            Ok(text) => match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
                Ok(Value::Object(values)) => values,
                _ => {
                    log::warn!("{} is not a settings file, moved aside", path.display());
                    let _ = std::fs::rename(&path, dir.join(format!("{FILE}.bad")));
                    Map::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
            // A file that is there but cannot be read now, locked or not UTF-8, is left alone and never written over.
            Err(e) => {
                log::warn!("{} could not be read, settings stay unsaved this run: {e}", path.display());
                return Self { path: None, values: Map::new() };
            }
        };
        Self { path: Some(path), values }
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        serde_json::from_value(self.values.get(key)?.clone()).ok()
    }

    /// Writes the whole file at once, through a temp file so a crash leaves the old one whole.
    pub fn set<T: Serialize>(&mut self, key: &str, value: &T) -> Result<(), String> {
        let value = serde_json::to_value(value).map_err(|e| e.to_string())?;
        self.values.insert(key.to_string(), value);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let text = serde_json::to_string_pretty(&self.values).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// A static rather than a GPUI global, so code off the `App`, such as the transfer dialogs' memory, reads and writes it.
#[cfg(not(test))]
static STORE: LazyLock<Mutex<Store>> = LazyLock::new(Mutex::default);

#[cfg(not(test))]
fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    f(&mut STORE.lock().unwrap_or_else(PoisonError::into_inner))
}

// Each test runs on its own thread, so each gets its own settings.
#[cfg(test)]
thread_local! {
    static STORE: std::cell::RefCell<Store> = std::cell::RefCell::default();
}

#[cfg(test)]
fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    STORE.with_borrow_mut(f)
}

pub fn init(_cx: &mut App) {
    let loaded = Store::load(config_dir().as_deref());
    with_store(|s| *s = loaded);
}

pub fn get<T: DeserializeOwned>(_cx: &App, key: &str) -> Option<T> {
    read(key)
}

/// Logs a failed write: the value still holds for this run.
pub fn set<T: Serialize>(_cx: &mut App, key: &str, value: &T) {
    write(key, value);
}

pub fn read<T: DeserializeOwned>(key: &str) -> Option<T> {
    with_store(|s| s.get(key))
}

pub fn write<T: Serialize>(key: &str, value: &T) {
    if let Err(e) = with_store(|s| s.set(key, value)) {
        log::warn!("the settings were not saved: {e}");
    }
}
