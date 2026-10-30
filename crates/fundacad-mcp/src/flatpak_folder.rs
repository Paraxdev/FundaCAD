//! In the Flatpak an assistant reaches one folder of its own, and any other path asks the user in the app.

use crate::scope::{canonical, within};
use std::future::Future;
use std::path::{Path, PathBuf};

pub const FOLDER_NAME: &str = "FundaCAD";

/// The same test the app makes for its system line.
pub fn in_flatpak() -> bool {
    cfg!(target_os = "linux") && Path::new("/.flatpak-info").exists()
}

/// XDG_DOCUMENTS_DIR from a user-dirs.dirs text with $HOME expanded. None when it is unset, relative, or home
/// itself, which the XDG spec reads as no such folder.
pub fn documents_dir(user_dirs: &str, home: &Path) -> Option<PathBuf> {
    let quoted = user_dirs.lines().map(str::trim).filter_map(|l| l.strip_prefix("XDG_DOCUMENTS_DIR=")).last()?;
    let quoted = quoted.trim().trim_matches('"');
    let (home_relative, raw) = match quoted.strip_prefix("$HOME") {
        Some(rest) => (true, rest),
        None => (false, quoted),
    };
    let mut value = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        value.push(if c == '\\' { chars.next().unwrap_or(c) } else { c });
    }
    let dir = match home_relative.then_some(value.as_str()) {
        Some(rest) if rest.trim_matches('/').is_empty() => return None,
        Some(rest) if rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        Some(_) => return None,
        None if value.starts_with('/') => PathBuf::from(&value),
        None => return None,
    };
    (dir != home).then_some(dir)
}

/// The folder under the documents folder user-dirs.dirs names, else under ~/Documents.
pub fn documents_folder(home: &Path, user_dirs: Option<&str>) -> PathBuf {
    user_dirs.and_then(|t| documents_dir(t, home)).unwrap_or_else(|| home.join("Documents")).join(FOLDER_NAME)
}

/// `found` lists the FundaCAD folders that exist, `primary` among them or not. When `primary` is missing and the
/// sandbox shows exactly one other, that one is the folder the Flatpak was given under a translated name.
pub fn choose_folder(primary: PathBuf, found: &[PathBuf]) -> PathBuf {
    match found {
        [only] if *only != primary => only.clone(),
        _ => primary,
    }
}

/// Where the Flatpak keeps an assistant's files, and the document portal mounts, which hold only files the user
/// granted this app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sandbox {
    pub folder: PathBuf,
    pub mounts: Vec<PathBuf>,
}

impl Sandbox {
    /// None outside the Flatpak, where nothing changes.
    pub fn detect() -> Option<Sandbox> {
        if !in_flatpak() {
            return None;
        }
        let home = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute())?;
        let env_dir = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
        let config = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
        let user_dirs = std::fs::read_to_string(config.join("user-dirs.dirs")).ok();
        let primary = documents_folder(&home, user_dirs.as_deref());
        let mut found: Vec<PathBuf> = std::fs::read_dir(&home)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path().join(FOLDER_NAME))
            .filter(|p| p.is_dir())
            .collect();
        if primary.is_dir() && !found.contains(&primary) {
            found.push(primary.clone());
        }
        let mut mounts = vec![PathBuf::from("/run/flatpak/doc")];
        mounts.extend(env_dir("XDG_RUNTIME_DIR").map(|r| r.join("doc")));
        Some(Sandbox { folder: choose_folder(primary, &found), mounts })
    }

    pub fn inside(&self, path: &Path) -> bool {
        let Some(target) = canonical(path) else { return false };
        std::iter::once(&self.folder)
            .chain(&self.mounts)
            .filter(|p| p.is_absolute())
            .filter_map(|p| canonical(p))
            .any(|p| within(&target, &p))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Go,
    Ask,
    Refuse,
}

pub fn decide(flatpak: bool, inside: bool, window: bool) -> Decision {
    match (flatpak, inside, window) {
        (false, _, _) | (true, true, _) => Decision::Go,
        (true, false, true) => Decision::Ask,
        (true, false, false) => Decision::Refuse,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskKind {
    Open,
    Save,
    Folder,
}

impl AskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AskKind::Open => "open",
            AskKind::Save => "save",
            AskKind::Folder => "folder",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathAsk {
    pub kind: AskKind,
    pub tool: String,
    pub path: PathBuf,
    pub exts: Vec<String>,
}

impl PathAsk {
    pub fn new(kind: AskKind, tool: &str, path: PathBuf, exts: &[&str]) -> PathAsk {
        PathAsk { kind, tool: tool.to_owned(), path, exts: exts.iter().map(|e| (*e).to_owned()).collect() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Picked(PathBuf),
    Declined,
    /// The window stopped hosting before it answered.
    NoWindow,
}

/// Shows the file chooser in the app window and waits for the user's pick.
pub trait AskUser {
    fn ask(&self, ask: PathAsk) -> impl Future<Output = Result<Answer, String>> + Send;
}

pub fn folder_only(folder: &Path) -> String {
    format!(
        "FundaCAD runs as a Flatpak here, so an assistant reaches only files in {}. Use a path there, or have the \
         user open FundaCAD with Live document set to share in Preferences, AI assistants, so FundaCAD can ask them \
         for any other file.",
        folder.display()
    )
}

pub fn declined(kind: AskKind, path: &Path) -> String {
    let (verb, done) = match kind {
        AskKind::Open => ("open", "opened"),
        AskKind::Save | AskKind::Folder => ("write", "written"),
    };
    format!("The user declined in the FundaCAD window to let you {verb} {}, so nothing was {done}.", path.display())
}

/// The path a tool may use: the asked one inside the folder or outside the Flatpak, else the user's pick from the
/// file chooser while the app window hosts, else a refusal that says why.
pub async fn reach<A: AskUser>(
    ask: PathAsk,
    sandbox: Option<&Sandbox>,
    window: bool,
    asker: &A,
) -> Result<PathBuf, String> {
    let inside = sandbox.is_some_and(|s| s.inside(&ask.path));
    let refusal = || sandbox.map(|s| folder_only(&s.folder)).unwrap_or_default();
    match decide(sandbox.is_some(), inside, window) {
        Decision::Go => Ok(ask.path),
        Decision::Refuse => Err(refusal()),
        Decision::Ask => {
            let (kind, path) = (ask.kind, ask.path.clone());
            match asker.ask(ask).await? {
                Answer::Picked(picked) => Ok(picked),
                Answer::Declined => Err(declined(kind, &path)),
                Answer::NoWindow => Err(refusal()),
            }
        }
    }
}
