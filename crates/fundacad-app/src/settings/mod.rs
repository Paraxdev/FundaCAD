//! The app's own settings, one JSON object in `settings.json` under FundaCAD 2's config folder. Each owner reads and
//! writes its key, so a key this build does not know is kept as it was.

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use gpui::{App, Global};
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

struct Settings(Store);

impl Global for Settings {}

pub fn init(cx: &mut App) {
    let store = Store::load(config_dir().as_deref());
    cx.set_global(Settings(store));
}

pub fn get<T: DeserializeOwned>(cx: &App, key: &str) -> Option<T> {
    cx.try_global::<Settings>()?.0.get(key)
}

/// Logs a failed write: the value still holds for this run.
pub fn set<T: Serialize>(cx: &mut App, key: &str, value: &T) {
    if !cx.has_global::<Settings>() {
        cx.set_global(Settings(Store::default()));
    }
    if let Err(e) = cx.global_mut::<Settings>().0.set(key, value) {
        log::warn!("the settings were not saved: {e}");
    }
}
