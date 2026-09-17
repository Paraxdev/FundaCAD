//! Starting another program on this machine, for a plugin that hands its output
//! to one. The native half of the `process.spawn` grant.
//!
//! No shell is involved: the program is an absolute path to a file that exists,
//! and every argument reaches it as one argument, so nothing a plugin passes is
//! ever parsed as a command line. Detached, the app does not wait for it.
//!
//! The first time a plugin starts a given program the user is asked, natively,
//! and the answer is remembered. The grant check lives in the window, so without
//! this any script that got into the window could start any program on the
//! machine. The approvals file sits outside plugin-data, where a plugin could
//! otherwise write its own.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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

type Approvals = BTreeMap<String, Vec<String>>;

fn approvals_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("launch-approvals.json"))
}

fn read_approvals(path: &Path) -> Approvals {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn is_approved(approvals: &Approvals, plugin: &str, program: &str) -> bool {
    approvals.get(plugin).is_some_and(|p| p.iter().any(|x| x == program))
}

fn remember(path: &Path, plugin: &str, program: &str) -> Result<(), String> {
    let mut approvals = read_approvals(path);
    let list = approvals.entry(plugin.to_string()).or_default();
    if !list.iter().any(|x| x == program) {
        list.push(program.to_string());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&approvals).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

/// Start the first of `programs` that exists with `args`, and say which one.
#[tauri::command]
pub async fn plugin_launch(
    app: AppHandle,
    plugin: String,
    programs: Vec<String>,
    args: Vec<String>,
) -> Result<String, String> {
    safe_id(&plugin)?;
    let Some(bin) = first_program(&programs) else {
        return Err(match programs.first() {
            Some(p) => format!("no program found at {p}"),
            None => "no program was named".into(),
        });
    };
    let program = text(bin.clone());
    let path = approvals_path(&app)?;
    if !is_approved(&read_approvals(&path), &plugin, &program) {
        let dialog = app
            .dialog()
            .message(format!("The plugin {plugin} wants to start this program:

{program}

Allow it, now and next time?"))
            .title("Start a program")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Don't allow".into()));
        // blocking_show must not run on the main thread, which drives the dialog.
        let allowed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
            .await
            .map_err(|e| e.to_string())?;
        if !allowed {
            return Err(format!("starting {program} was not allowed"));
        }
        remember(&path, &plugin, &program)?;
    }
    spawn(&bin, &args)?;
    Ok(program)
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

    #[test]
    fn an_approval_is_for_one_plugin_and_one_program() {
        let dir = std::env::temp_dir().join(format!("fundacad-approvals-{}", std::process::id()));
        let path = dir.join("launch-approvals.json");
        assert!(!is_approved(&read_approvals(&path), "A.B", "/bin/x"));
        remember(&path, "A.B", "/bin/x").unwrap();
        remember(&path, "A.B", "/bin/x").unwrap();
        let got = read_approvals(&path);
        assert!(is_approved(&got, "A.B", "/bin/x"));
        assert!(!is_approved(&got, "A.B", "/bin/y"));
        assert!(!is_approved(&got, "C.D", "/bin/x"));
        assert_eq!(got["A.B"].len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
