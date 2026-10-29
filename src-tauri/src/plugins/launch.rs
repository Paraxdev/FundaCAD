//! The native half of the `process.spawn` grant. No shell: an absolute path to an existing file, each argument passed
//! as one, detached. The grant is checked here as well as in the window, each program and argument shape is approved
//! natively once, and the approvals file sits outside plugin-data where a plugin could write its own.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::bundle::{safe_id, Consented};

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
    candidates.iter().map(PathBuf::from).find(|p| p.is_absolute() && p.is_file())
}

const SHIPPED: &[&str] = &[include_str!("../../../plugins/FundaCAD.Printing/manifest.json")];

/// Whether `plugin` may start programs: its consented grants when installed, else its shipped manifest.
pub fn may_spawn(consented: Option<&Consented>, plugin: &str) -> bool {
    match consented {
        Some(c) => c.grants.iter().any(|g| g == SPAWN),
        None => SHIPPED.iter().any(|m| shipped_spawn(m, plugin)),
    }
}

const SPAWN: &str = "process.spawn";

fn shipped_spawn(manifest: &str, plugin: &str) -> bool {
    let Ok(m) = serde_json::from_str::<serde_json::Value>(manifest) else { return false };
    m["id"].as_str() == Some(plugin)
        && m["grants"].as_array().is_some_and(|g| g.iter().any(|x| x.as_str() == Some(SPAWN)))
}

/// A file of one of these types runs as code when passed to an interpreter, so its approval names the file.
const CODE_EXTS: &str = "app applescript bash bat cjs cmd com command cpl desktop dll dylib exe fish hta inf jar js \
                         jse ksh lnk lua mjs msc msi msp php pif pl pm ps1 psd1 psm1 py pyc pyw pyz rb reg run scpt \
                         scr sh so tcl vbe vbs wsf wsh zsh";

/// What an approval remembers about the arguments: an absolute file path by its folder and extension, so a new
/// export next to the last one is covered, and anything else exactly.
pub fn args_shape(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|a| {
            let p = Path::new(a);
            let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase());
            match (p.is_absolute(), p.parent(), ext) {
                (true, Some(dir), Some(ext)) if !CODE_EXTS.split_whitespace().any(|c| c == ext) => {
                    text(dir.join(format!("*.{ext}")))
                }
                _ => a.clone(),
            }
        })
        .collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Approval {
    pub program: String,
    pub args: Vec<String>,
}

pub type Approvals = BTreeMap<String, Vec<Approval>>;

fn approvals_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("launch-approvals.json"))
}

/// An older file that keyed approvals on the program alone reads as empty, so each is asked again.
pub fn read_approvals(path: &Path) -> Approvals {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn is_approved(approvals: &Approvals, plugin: &str, program: &str, args: &[String]) -> bool {
    let want = args_shape(args);
    approvals.get(plugin).is_some_and(|p| p.iter().any(|x| x.program == program && x.args == want))
}

pub fn remember(path: &Path, plugin: &str, program: &str, args: &[String]) -> Result<(), String> {
    let mut approvals = read_approvals(path);
    let want = Approval { program: program.to_string(), args: args_shape(args) };
    let list = approvals.entry(plugin.to_string()).or_default();
    if !list.contains(&want) {
        list.push(want);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&approvals).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

fn one_line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { '\u{FFFD}' } else { c }).collect()
}

pub fn approval_text(plugin: &str, program: &str, args: &[String]) -> String {
    let listed = if args.is_empty() {
        "with no arguments".to_string()
    } else {
        let lines: Vec<String> = args.iter().map(|a| format!("  {}", one_line(a))).collect();
        format!("with these arguments:\n{}", lines.join("\n"))
    };
    let later = if args_shape(args) == args {
        "for the same arguments"
    } else {
        "for the same arguments or another file of the same type in the same folder"
    };
    format!(
        "The plugin {} wants to start this program:\n\n{}\n\n{listed}\n\nAllow it now, and later {later}?",
        one_line(plugin),
        one_line(program)
    )
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
    if !may_spawn(super::consented_of(&app, &plugin).as_ref(), &plugin) {
        return Err(format!("{plugin} was not granted process.spawn"));
    }
    let Some(bin) = first_program(&programs) else {
        return Err(match programs.first() {
            Some(p) => format!("no program found at {p}"),
            None => "no program was named".into(),
        });
    };
    let program = text(bin.clone());
    let path = approvals_path(&app)?;
    if !is_approved(&read_approvals(&path), &plugin, &program, &args) {
        let dialog = app
            .dialog()
            .message(approval_text(&plugin, &program, &args))
            .title("Start a program")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Don't allow".into()));
        // blocking_show must not run on the main thread, which drives the dialog.
        let allowed =
            tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await.map_err(|e| e.to_string())?;
        if !allowed {
            return Err(format!("starting {program} was not allowed"));
        }
        remember(&path, &plugin, &program, &args)?;
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
