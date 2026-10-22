//! Which files a plugin was handed and what it may be told about them. A plugin never learns a path: it gets a random
//! handle, a file name and a length. Tauri free so scripts/check-plugin-guards.sh can run these tests.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A cap rather than an expiry: it bounds a plugin asking in a loop without taking away a file somebody chose.
pub const MAX_HELD: usize = 64;

/// A file the person handed to a plugin, and nothing else.
pub struct Handed {
    /// Whose it is. Checked on every read, so one plugin cannot use another's
    /// handle even if it somehow learned the token.
    pub plugin: String,
    pub path: PathBuf,
    /// When, so the oldest can go first when a plugin hits the cap.
    pub at: u64,
}

/// In memory only, so a plugin cannot come back tomorrow holding a token for a file somebody forgot they offered.
#[derive(Default)]
pub struct Table(HashMap<String, Handed>);

impl Table {
    /// At the cap evicts this plugin's own oldest and only its own, so one plugin asking in a loop cannot take
    /// another's file.
    pub fn remember(&mut self, handle: String, plugin: String, path: PathBuf, at: u64) {
        let mut mine: Vec<(String, u64)> =
            self.0.iter().filter(|(_, h)| h.plugin == plugin).map(|(k, h)| (k.clone(), h.at)).collect();
        if mine.len() >= MAX_HELD {
            mine.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
            for (key, _) in mine.iter().take(mine.len() + 1 - MAX_HELD) {
                self.0.remove(key);
            }
        }
        self.0.insert(handle, Handed { plugin, path, at });
    }

    /// One answer for "no such handle" and "not yours", so a plugin cannot learn that another plugin's handle exists.
    pub fn path_for(&self, plugin: &str, handle: &str) -> Option<&Path> {
        self.0.get(handle).filter(|h| h.plugin == plugin).map(|h| h.path.as_path())
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Splits on both separators whatever this was compiled for: `Path::file_name` would return a Windows path whole on
/// Linux and leak it. Takes `&str` so the foreign case is testable on either platform.
fn last_component(raw: &str) -> &str {
    raw.rsplit(['/', '\\']).next().unwrap_or("")
}

/// The file name, never the directory, which would tell a plugin the person's name and disk layout. A Linux name that
/// contains a backslash is shown shortened, a cosmetic loss against a privacy promise.
pub fn name_of(path: &Path) -> String {
    let whole = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    match last_component(&whole) {
        "" => "the file".to_string(),
        name => name.to_string(),
    }
}

/// Advisory only: a filter narrows what is easy to pick, never what is allowed. Cleaned because "*.exe" or "../.." in a
/// native dialog filter is at best a dialog that behaves strangely.
pub fn clean_extensions(exts: &[String]) -> Vec<String> {
    exts.iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .take(16)
        .collect()
}

/// The title is the only place a plugin's words reach the person. The id is prepended here, not by the plugin, so a
/// plugin cannot claim to be another one.
pub fn dialog_title(plugin: &str, purpose: &str, fallback: &str) -> String {
    let mut said = purpose.trim().replace(['\r', '\n', '\t'], " ");
    // Truncated on a char boundary, because `String::truncate` panics in the
    // middle of a multi-byte character and a plugin's summary can be any text.
    let cut = said
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(said.len()))
        .take_while(|i| *i <= 120)
        .last()
        .unwrap_or(0);
    said.truncate(cut);
    let said = said.trim();
    if said.is_empty() {
        format!("{fallback} {plugin}")
    } else {
        format!("{plugin}: {said}")
    }
}

/// A suggestion carrying a path would let a plugin choose the dialog's directory, most of the way to the file.
pub fn suggested_name(raw: &str) -> Option<String> {
    let name = last_component(raw).trim();
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // On Windows `file_name` splits before the rule is reached, so the rule is asked directly with the string a Linux
    // `file_name` hands over.
    #[test]
    fn a_windows_path_is_split_on_this_platform_too() {
        assert_eq!(last_component("C:\\Users\\alice\\Documents\\part.step"), "part.step");
        assert_eq!(last_component("/home/alice/private/part.step"), "part.step");
        // Mixed, which is what a path assembled by hand tends to look like.
        assert_eq!(last_component("C:\\Users\\alice/part.step"), "part.step");
        // The controls: a plain name is not shortened, and a trailing separator
        // leaves nothing rather than reaching back for the directory.
        assert_eq!(last_component("part.step"), "part.step");
        assert_eq!(last_component("C:\\Users\\alice\\"), "");
    }
}
