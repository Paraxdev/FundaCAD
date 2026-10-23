//! Which files the tools may touch, judged on the absolute path with `..` folded and symlinks resolved.
//! The app's folders are reached in full, since tempfile names its folders `.tmpXXXX`. By default so is any
//! path but home, a drive root, a folder holding home or a hidden part; strict mode (`--allow-path`,
//! FUNDACAD_MCP_ALLOW_PATHS, FUNDACAD_MCP_STRICT=1) keeps to the given folders and the document's.
//! Checked at the tool's entry, so a symlink swapped in before the write, or a hard link, is not caught.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reach {
    Full,
    Visible,
}

#[derive(Clone, Debug)]
struct Root {
    path: PathBuf,
    reach: Reach,
}

#[derive(Clone, Debug, Default)]
pub struct PathScope {
    roots: Vec<Root>,
    home: Option<PathBuf>,
    strict: bool,
    /// Folders that were given but not used, said again in every refusal.
    dropped: Vec<String>,
}

pub const ALLOW_ENV: &str = "FUNDACAD_MCP_ALLOW_PATHS";

impl PathScope {
    /// The second half is one line per refused folder, for the log.
    pub fn for_server(args: impl IntoIterator<Item = OsString>) -> (PathScope, Vec<String>) {
        let app =
            vec![std::env::temp_dir(), crate::app_session::app_data_dir().join("recovery"), crate::docfile::blob_dir()];
        let env = crate::link::appenv("MCP_ALLOW_PATHS").map(OsString::from);
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .filter(|h| !h.is_empty())
            .map(PathBuf::from);
        let allowed = allowed_paths(args, env);
        // Decided before any folder is dropped, so `--allow-path ~` alone
        // still keeps to the app's folders and the refusal says why.
        if strict(&allowed, crate::link::appenv("MCP_STRICT")) {
            PathScope::new(app, allowed, home)
        } else {
            PathScope::open(app, home)
        }
    }

    /// Strict: the app's folders, `allowed` and the open document's folder.
    pub fn new(app: Vec<PathBuf>, allowed: Vec<PathBuf>, home: Option<PathBuf>) -> (PathScope, Vec<String>) {
        PathScope::build(app, allowed, home, true)
    }

    /// The default: any path that is not refused for where it is.
    pub fn open(app: Vec<PathBuf>, home: Option<PathBuf>) -> (PathScope, Vec<String>) {
        PathScope::build(app, Vec::new(), home, false)
    }

    pub fn is_strict(&self) -> bool {
        self.strict
    }

    fn build(
        app: Vec<PathBuf>,
        allowed: Vec<PathBuf>,
        home: Option<PathBuf>,
        strict: bool,
    ) -> (PathScope, Vec<String>) {
        let mut scope = PathScope { roots: Vec::new(), home, strict, dropped: Vec::new() };
        let mut refused = Vec::new();
        let picked = app.into_iter().map(|p| (p, Reach::Full)).chain(allowed.into_iter().map(|p| (p, Reach::Visible)));
        for (path, reach) in picked {
            let spelled = path.to_string_lossy().into_owned();
            if let Some(why) = spelling_refusal(&spelled) {
                refused.push(format!("{spelled} was ignored as an allowed folder: it is {why}"));
                continue;
            }
            let path = abspath(&spelled);
            if let Some(why) = scope.root_refusal(&canonical(&path).unwrap_or_else(|| path.clone())) {
                refused.push(format!(
                    "{} was ignored as an allowed folder: it is {why}, give a folder inside it",
                    path.display()
                ));
                continue;
            }
            scope.roots.push(Root { path, reach });
        }
        scope.dropped.clone_from(&refused);
        (scope, refused)
    }

    pub fn folders(&self) -> Vec<PathBuf> {
        self.roots.iter().map(|r| r.path.clone()).collect()
    }

    /// `doc` is the open document's file; its folder joins the scope when it is one a person would pick.
    pub fn check(&self, raw: &str, doc: Option<&Path>) -> Result<PathBuf, String> {
        if let Some(why) = spelling_refusal(raw) {
            return Err(format!("{raw} is refused: it is {why}. Give a plain path on a local drive."));
        }
        let lexical = abspath(raw);
        let Some(target) = canonical(&lexical) else {
            return Err(format!("{} is refused: it is a link whose target does not exist.", lexical.display()));
        };
        if !self.strict {
            return self.check_open(lexical, &target);
        }
        let doc_root = doc.and_then(|d| self.document_folder(d));
        let roots = self
            .roots
            .iter()
            .filter_map(|r| canonical(&r.path).map(|c| (c, r.reach)))
            .chain(doc_root.map(|d| (d, Reach::Visible)));
        let mut hidden: Option<(PathBuf, String)> = None;
        for (root, reach) in roots {
            let Ok(rest) = target.strip_prefix(&root) else { continue };
            match (reach, rest.components().find_map(dot_name)) {
                (Reach::Visible, Some(name)) => hidden = Some((root, name)),
                _ => return Ok(lexical),
            }
        }
        if let Some((root, name)) = hidden {
            return Err(format!(
                "{} is refused: {name} below {} is a hidden folder or file, which this server does not reach. \
                 If it is meant, allow that folder itself: start the server with --mcp --allow-path <folder> \
                 (repeatable) or list it in {ALLOW_ENV}.{}",
                lexical.display(),
                root.display(),
                self.dropped_note()
            ));
        }
        Err(self.outside(&lexical, &target, doc))
    }

    fn check_open(&self, lexical: PathBuf, target: &Path) -> Result<PathBuf, String> {
        let in_app = self
            .roots
            .iter()
            .filter(|r| r.reach == Reach::Full)
            .any(|r| canonical(&r.path).is_some_and(|root| target.starts_with(root)));
        if in_app {
            return Ok(lexical);
        }
        let folder = target.parent().unwrap_or(target);
        if let Some(why) = self.root_refusal(folder) {
            return Err(format!(
                "{} is refused: its folder {} is {why}, which this server does not use. \
                 Use a folder inside it.{}",
                lexical.display(),
                folder.display(),
                self.dropped_note()
            ));
        }
        if let Some(name) = target.components().chain(lexical.components()).find_map(dot_name) {
            return Err(format!(
                "{} is refused: {name} is a hidden folder or file (its name starts with a dot), which this \
                 server does not reach. Use a folder whose name does not start with a dot.{}",
                lexical.display(),
                self.dropped_note()
            ));
        }
        Ok(lexical)
    }

    fn dropped_note(&self) -> String {
        self.dropped.iter().map(|d| format!(" Note: {d}.")).collect()
    }

    fn outside(&self, lexical: &Path, target: &Path, doc: Option<&Path>) -> String {
        let mut known: Vec<String> = self.folders().iter().map(|p| p.display().to_string()).collect();
        if let Some(d) = doc.and_then(|d| self.document_folder(d)) {
            known.push(format!("{} (the open document's folder)", d.display()));
        }
        let folder = target.parent().unwrap_or(target);
        let would = match self.root_refusal(folder) {
            None if dot_path(folder) => format!(
                "Allowing {} would let it through (a hidden folder is reached only when it is allowed itself).",
                folder.display()
            ),
            None => format!("Allowing {} would let it through.", folder.display()),
            Some(why) => {
                format!("Its folder {} cannot be allowed, it is {why}; pick a folder inside it.", folder.display())
            }
        };
        format!(
            "{} is outside the folders this server may use: {}. It was started with a folder list, so it \
             keeps to those. {would} To allow more, start the server with --mcp --allow-path <folder> \
             (repeatable), or list folders in {ALLOW_ENV}, separated the way PATH is. The folder of the \
             document the app has open is usable too. An assistant cannot change this itself: ask the \
             person to add the folder.{}",
            lexical.display(),
            known.join(", "),
            self.dropped_note()
        )
    }

    fn document_folder(&self, doc: &Path) -> Option<PathBuf> {
        if !doc.is_absolute() || spelling_refusal(&doc.to_string_lossy()).is_some() {
            return None;
        }
        let folder = canonical(doc.parent()?)?;
        (self.root_refusal(&folder).is_none() && !dot_path(&folder)).then_some(folder)
    }

    /// Why `folder` (canonical) cannot be a scope root.
    fn root_refusal(&self, folder: &Path) -> Option<&'static str> {
        if folder.parent().is_none() {
            return Some("a drive or filesystem root");
        }
        let home = self.home.as_deref().map(|h| canonical(h).unwrap_or_else(|| h.to_path_buf()))?;
        if home == folder {
            Some("the home folder itself")
        } else if home.starts_with(folder) {
            Some("a folder that holds the home folder")
        } else {
            None
        }
    }
}

/// A folder was given, or `FUNDACAD_MCP_STRICT` is on.
pub fn strict(allowed: &[PathBuf], env: Option<String>) -> bool {
    !allowed.is_empty()
        || env.is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

/// `--allow-path X` and `--allow-path=X`, after `--mcp` when that is given,
/// then the env list.
pub fn allowed_paths(args: impl IntoIterator<Item = OsString>, env: Option<OsString>) -> Vec<PathBuf> {
    let args: Vec<OsString> = args.into_iter().skip(1).collect();
    let start = args.iter().position(|a| a == "--mcp").map_or(0, |i| i + 1);
    let mut out = Vec::new();
    let mut it = args[start..].iter();
    while let Some(a) = it.next() {
        let a = a.to_string_lossy();
        if a == "--allow-path" {
            if let Some(v) = it.next() {
                out.push(PathBuf::from(v));
            }
        } else if let Some(v) = a.strip_prefix("--allow-path=") {
            out.push(PathBuf::from(v));
        }
    }
    if let Some(env) = env {
        out.extend(std::env::split_paths(&env).filter(|p| !p.as_os_str().is_empty()));
    }
    out
}

/// Judged on the spelling alone, the same on every platform, so a file written on one opens on the other.
pub fn spelling_refusal(raw: &str) -> Option<&'static str> {
    if raw.is_empty() {
        return Some("empty");
    }
    let slashed = raw.replace('/', "\\");
    if slashed.starts_with(r"\\?\") || slashed.starts_with(r"\??\") {
        return Some("a verbatim path (\\\\?\\)");
    }
    if slashed.starts_with(r"\\.\") {
        return Some("a device path (\\\\.\\)");
    }
    if slashed.starts_with(r"\\") {
        return Some("a network (UNC) path");
    }
    let b = raw.as_bytes();
    let rest = if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        if b.len() == 2 || !matches!(b[2], b'\\' | b'/') {
            return Some("relative to a drive's current folder (C:name)");
        }
        &raw[2..]
    } else {
        raw
    };
    if rest.contains(':') {
        return Some("an NTFS alternate data stream (a colon in a name)");
    }
    if rest.split(['/', '\\']).any(is_device_name) {
        return Some("a device name such as NUL, CON or COM1");
    }
    None
}

fn is_device_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    let mut chars = stem.chars();
    let head: String = chars.by_ref().take(3).collect();
    let tail: String = chars.collect();
    (head == "COM" || head == "LPT")
        && matches!(tail.as_str(), "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "\u{b9}" | "\u{b2}" | "\u{b3}")
}

fn dot_name(c: Component<'_>) -> Option<String> {
    match c {
        Component::Normal(n) if n.to_string_lossy().starts_with('.') => Some(n.to_string_lossy().into_owned()),
        _ => None,
    }
}

fn dot_path(p: &Path) -> bool {
    p.components().any(|c| dot_name(c).is_some())
}

/// Existing parts resolved, links included, the rest appended as written. None for a link to a missing
/// target, which would otherwise be judged by its own name and written through.
pub fn canonical(path: &Path) -> Option<PathBuf> {
    let mut rest: Vec<OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if let Ok(c) = std::fs::canonicalize(&cur) {
            let mut out = plain(c);
            out.extend(rest.iter().rev());
            return Some(out);
        }
        if std::fs::symlink_metadata(&cur).is_ok() {
            return None;
        }
        match (cur.file_name(), cur.parent()) {
            (Some(n), Some(p)) => {
                rest.push(n.to_os_string());
                cur = p.to_path_buf();
            }
            _ => return Some(path.to_path_buf()),
        }
    }
}

/// Windows' canonical form is verbatim (`\\?\C:\...`); the plain form is what
/// every root is compared in.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(r) = s.strip_prefix(r"\\?\") {
        if r.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(r);
        }
    }
    p
}

pub fn abspath(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        normalise(p)
    } else {
        normalise(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(p))
    }
}

/// Without touching the filesystem, as `os.path.abspath` does: the path may not exist yet,
/// which is the point of `doc_save`.
fn normalise(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in p.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
