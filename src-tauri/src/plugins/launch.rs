//! Starting another program on this machine, for a plugin that hands its output
//! to one. The native half of the `process.spawn` grant.
//!
//! No shell is involved: the program is an absolute path to a file that exists,
//! and every argument reaches it as one argument, so nothing a plugin passes is
//! ever parsed as a command line. Detached, the app does not wait for it.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::bundle::safe_id;

/// Where programs and their settings usually live on this machine, so a plugin
/// can build candidate paths without guessing at environment variables.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDirs {
    pub os: String,
    pub home: Option<String>,
    /// Per-user settings: %APPDATA%, ~/Library/Application Support, ~/.config.
    pub config: Option<String>,
    /// Per-user installs: %LOCALAPPDATA%, and the same as `config` elsewhere.
    pub local_data: Option<String>,
    /// System-wide install roots, most likely first.
    pub programs: Vec<String>,
}

fn text(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command]
pub fn plugin_system_dirs(app: AppHandle) -> SystemDirs {
    let os = std::env::consts::OS.to_string();
    let programs = match os.as_str() {
        "windows" => ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|k| std::env::var_os(k).map(|v| text(PathBuf::from(v))))
            .collect(),
        "macos" => vec!["/Applications".to_string()],
        _ => vec!["/usr/bin".to_string(), "/usr/local/bin".to_string()],
    };
    SystemDirs {
        os,
        home: app.path().home_dir().ok().map(text),
        config: app.path().config_dir().ok().map(text),
        local_data: app.path().local_data_dir().ok().map(text),
        programs,
    }
}

/// The first candidate that is an absolute path to an existing file.
pub fn first_program(candidates: &[String]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_absolute() && p.is_file())
}

/// Start the first of `programs` that exists with `args`, and say which one.
#[tauri::command]
pub fn plugin_launch(plugin: String, programs: Vec<String>, args: Vec<String>) -> Result<String, String> {
    safe_id(&plugin)?;
    let Some(bin) = first_program(&programs) else {
        return Err(match programs.first() {
            Some(p) => format!("no program found at {p}"),
            None => "no program was named".into(),
        });
    };
    spawn(&bin, &args)?;
    Ok(text(bin))
}

fn spawn(bin: &Path, args: &[String]) -> Result<(), String> {
    std::process::Command::new(bin)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to start {}: {e}", bin.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_first_absolute_file_that_exists() {
        let dir = std::env::temp_dir().join(format!("fundacad-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("tool.bin");
        std::fs::write(&real, b"x").unwrap();
        let missing = text(dir.join("missing.bin"));
        let got = first_program(&[missing, "tool.bin".into(), text(dir.clone()), text(real.clone())]);
        assert_eq!(got, Some(real));
        assert_eq!(first_program(&[]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
