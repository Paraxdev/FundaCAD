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

#[cfg(test)]
mod tests {
    use super::*;

    /// Not tempfile's default `.tmpXXXX`, whose dot would hide everything below it.
    fn dir() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("scope-").tempdir().unwrap()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    /// A scope over one temp dir as an app folder, `allowed` as picked
    /// folders, and a home of its own so the real one is never judged.
    fn scope(app: &[&Path], allowed: &[&Path], home: &Path) -> PathScope {
        let (scope, refused) = PathScope::new(
            app.iter().map(|p| p.to_path_buf()).collect(),
            allowed.iter().map(|p| p.to_path_buf()).collect(),
            Some(home.to_path_buf()),
        );
        assert!(refused.is_empty(), "{refused:?}");
        scope
    }

    #[test]
    fn windows_spellings_that_reach_past_the_filesystem_are_refused() {
        for raw in [
            r"\\server\share\a.funda",
            "//server/share/a.funda",
            r"\\?\C:\a.funda",
            r"\\?\UNC\server\share\a.funda",
            r"\\.\NUL",
            r"\\.\PhysicalDrive0",
            r"\??\C:\a.funda",
            "C:a.funda",
            "C:",
            r"C:\x\a.funda:zone",
            r"C:\x\a.funda::$DATA",
            r"C:\x\NUL.txt",
            r"C:\x\com1",
            r"C:\x\LPT9.stl",
            "COM1",
            "con",
            "aux.funda",
        ] {
            assert!(spelling_refusal(raw).is_some(), "{raw} should be refused");
        }
    }

    #[test]
    fn plain_paths_and_names_that_only_look_like_devices_pass_the_spelling() {
        for raw in [
            r"C:\x\a.funda",
            "C:/x/a.funda",
            "/home/me/part.funda",
            "part.funda",
            "console.funda",
            "com10.stl",
            "lpt.stl",
            "nulled/a.funda",
        ] {
            assert_eq!(spelling_refusal(raw), None, "{raw}");
        }
    }

    #[test]
    fn unix_roots_home_and_what_holds_home_are_never_allowed_folders() {
        let base = dir();
        let home = base.path().join("home").join("me");
        std::fs::create_dir_all(&home).unwrap();
        let (scope, refused) = PathScope::new(
            vec![],
            vec![PathBuf::from("/"), home.clone(), base.path().join("home")],
            Some(home.clone()),
        );
        assert!(scope.roots.is_empty(), "{:?}", scope.roots);
        assert_eq!(refused.len(), 3, "{refused:?}");
        assert!(refused[0].contains("root"), "{}", refused[0]);
        assert!(refused[1].contains("home folder itself"), "{}", refused[1]);
        assert!(refused[2].contains("holds the home folder"), "{}", refused[2]);
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_root_is_never_an_allowed_folder() {
        let base = dir();
        let (scope, refused) = PathScope::new(vec![], vec![PathBuf::from(r"C:\")], Some(base.path().to_path_buf()));
        assert!(scope.roots.is_empty());
        assert!(refused[0].contains("drive or filesystem root"), "{refused:?}");
    }

    #[test]
    fn home_and_a_drive_root_are_not_adopted_as_the_document_folder() {
        let base = dir();
        let home = base.path().join("me");
        std::fs::create_dir_all(&home).unwrap();
        let scope = scope(&[], &[], &home);
        let in_home = home.join("part.funda");
        let err = scope.check(&s(&in_home), Some(&in_home)).unwrap_err();
        assert!(err.contains("cannot be allowed"), "{err}");
        assert!(err.contains("home folder itself"), "{err}");
        let at_root = if cfg!(windows) { PathBuf::from(r"C:\part.funda") } else { PathBuf::from("/part.funda") };
        assert!(scope.check(&s(&at_root), Some(&at_root)).is_err());
    }

    #[test]
    fn the_document_folder_is_reached_but_not_hidden_names_below_it() {
        let base = dir();
        let docs = base.path().join("work").join("parts");
        std::fs::create_dir_all(docs.join(".git")).unwrap();
        let scope = scope(&[], &[], &base.path().join("me"));
        let doc = docs.join("a.funda");
        assert_eq!(scope.check(&s(&docs.join("b.stl")), Some(&doc)).unwrap(), docs.join("b.stl"));
        let err = scope.check(&s(&docs.join(".git").join("x.funda")), Some(&doc)).unwrap_err();
        assert!(err.contains(".git") && err.contains("hidden"), "{err}");
        assert!(scope.check(&s(&docs.join(".env")), Some(&doc)).is_err());
        assert!(scope.check(&s(&docs.join("b.stl")), None).is_err(), "no document, no folder");
    }

    #[test]
    fn a_document_in_a_hidden_folder_does_not_open_its_folder() {
        let base = dir();
        let dotted = base.path().join("me").join(".config").join("x");
        std::fs::create_dir_all(&dotted).unwrap();
        let scope = scope(&[], &[], &base.path().join("me"));
        let doc = dotted.join("a.funda");
        assert!(scope.check(&s(&dotted.join("b.funda")), Some(&doc)).is_err());
    }

    #[test]
    fn an_app_folder_is_reached_in_full_hidden_names_included() {
        let temp = tempfile::tempdir().unwrap();
        assert!(temp.path().file_name().unwrap().to_string_lossy().starts_with(".tmp"));
        let inner = temp.path().join(".tmpinner").join("a.funda");
        std::fs::create_dir_all(inner.parent().unwrap()).unwrap();
        let scope = scope(&[temp.path()], &[], Path::new("/nonexistent-home"));
        assert_eq!(scope.check(&s(&inner), None).unwrap(), inner);
    }

    #[test]
    fn dot_dot_cannot_climb_out_of_an_allowed_folder() {
        let base = dir();
        let root = base.path().join("allowed");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let scope = scope(&[], &[&root], &base.path().join("me"));
        let out = format!("{}/sub/../../out.funda", s(&root));
        let err = scope.check(&out, None).unwrap_err();
        assert!(err.contains("outside the folders"), "{err}");
        let inside = format!("{}/sub/../in.funda", s(&root));
        assert_eq!(scope.check(&inside, None).unwrap(), root.join("in.funda"));
    }

    #[test]
    fn a_folder_not_made_yet_is_judged_by_where_it_would_be() {
        let base = dir();
        let root = base.path().join("allowed");
        std::fs::create_dir_all(&root).unwrap();
        let scope = scope(&[], &[&root], &base.path().join("me"));
        assert!(scope.check(&s(&root.join("new").join("a.stl")), None).is_ok());
        assert!(scope.check(&s(&base.path().join("new").join("a.stl")), None).is_err());
    }

    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, link).is_ok();
        // A junction needs no developer mode, so the test runs on any Windows.
        #[cfg(windows)]
        return std::os::windows::fs::symlink_dir(target, link).is_ok()
            || std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .is_ok_and(|o| o.status.success());
    }

    #[test]
    fn a_link_inside_an_allowed_folder_cannot_lead_out_of_it() {
        let base = dir();
        let root = base.path().join("allowed");
        let away = base.path().join("away");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&away).unwrap();
        if !link_dir(&away, &root.join("door")) {
            eprintln!("symlinks need developer mode here, skipped");
            return;
        }
        let scope = scope(&[], &[&root], &base.path().join("me"));
        let err = scope.check(&s(&root.join("door").join("a.funda")), None).unwrap_err();
        assert!(err.contains("outside the folders"), "{err}");
        if link_dir(&base.path().join("gone"), &root.join("dangling")) {
            assert!(scope.check(&s(&root.join("dangling")), None).is_err());
        }
    }

    #[test]
    fn the_refusal_names_the_folder_that_would_be_allowed_and_how() {
        let base = dir();
        let root = base.path().join("allowed");
        let other = base.path().join("other");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let scope = scope(&[], &[&root], &base.path().join("me"));
        let err = scope.check(&s(&other.join("a.funda")), None).unwrap_err();
        let other_c = canonical(&other).unwrap();
        assert!(err.contains(&format!("Allowing {} would", other_c.display())), "{err}");
        assert!(err.contains("--mcp --allow-path") && err.contains(ALLOW_ENV), "{err}");
        assert!(err.contains(&root.display().to_string()), "{err}");
        assert!(!err.contains("copy the file"), "{err}");
    }

    fn open(app: &[&Path], home: &Path) -> PathScope {
        let (scope, refused) = PathScope::open(app.iter().map(|p| p.to_path_buf()).collect(), Some(home.to_path_buf()));
        assert!(refused.is_empty(), "{refused:?}");
        scope
    }

    #[test]
    fn by_default_a_folder_a_person_uses_is_reached() {
        let base = dir();
        let me = base.path().join("me");
        for sub in ["Documents", "Downloads", "work/deep"] {
            std::fs::create_dir_all(me.join(sub)).unwrap();
        }
        std::fs::create_dir_all(base.path().join("proj")).unwrap();
        let scope = open(&[], &me);
        for p in [
            base.path().join("proj").join("a.funda"),
            me.join("Documents").join("a.funda"),
            me.join("Downloads").join("a.step"),
            me.join("work").join("deep").join("a.stl"),
            me.join("new").join("x.funda"),
        ] {
            assert_eq!(scope.check(&s(&p), None), Ok(p.clone()), "{}", p.display());
        }
    }

    #[test]
    fn by_default_a_relative_path_resolves_in_the_working_folder_and_is_reached() {
        let cwd = std::env::current_dir().unwrap();
        let (scope, _) = PathScope::open(vec![], None);
        assert_eq!(scope.check("x.funda", None).unwrap(), cwd.join("x.funda"));
    }

    #[test]
    fn by_default_home_a_root_dot_folders_and_odd_spellings_are_refused() {
        let base = dir();
        let me = base.path().join("me");
        let proj = base.path().join("proj");
        std::fs::create_dir_all(me.join(".ssh")).unwrap();
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        let scope = open(&[], &me);
        let root = if cfg!(windows) { "C:/a.funda" } else { "/a.funda" };
        for (raw, why) in [
            (s(&me.join("a.funda")), "home folder itself"),
            (root.to_string(), "root"),
            (s(&base.path().join("x.funda")), "holds the home folder"),
            (s(&me.join(".ssh").join("a.funda")), "hidden"),
            (s(&proj.join(".git").join("x")), "hidden"),
            (s(&proj.join(".bashrc")), "hidden"),
            (s(&me.join(".config").join("new").join("a.funda")), "hidden"),
            ("//srv/share/a.funda".to_string(), "network"),
            (s(&proj.join("NUL")), "device"),
            (format!("{}:ads", s(&proj.join("a.funda"))), "alternate data stream"),
        ] {
            let err = scope.check(&raw, None).unwrap_err();
            assert!(err.contains(why), "{raw}: {err}");
        }
    }

    #[test]
    fn by_default_dot_dot_and_links_cannot_reach_a_refused_place() {
        let base = dir();
        let me = base.path().join("me");
        let proj = base.path().join("proj");
        std::fs::create_dir_all(me.join(".ssh")).unwrap();
        std::fs::create_dir_all(&proj).unwrap();
        let scope = open(&[], &me);
        let climb = format!("{}/../me/.ssh/k", s(&proj));
        assert!(scope.check(&climb, None).unwrap_err().contains("hidden"), "{climb}");
        let climb = format!("{}/sub/../../me/a.funda", s(&proj));
        assert!(scope.check(&climb, None).unwrap_err().contains("home folder itself"), "{climb}");
        if !link_dir(&me.join(".ssh"), &proj.join("innocent")) {
            eprintln!("symlinks need developer mode here, skipped");
            return;
        }
        let err = scope.check(&s(&proj.join("innocent").join("a.funda")), None).unwrap_err();
        assert!(err.contains("hidden"), "{err}");
        if link_dir(&me, &proj.join("h")) {
            let err = scope.check(&s(&proj.join("h").join("a.funda")), None).unwrap_err();
            assert!(err.contains("home folder itself"), "{err}");
        }
    }

    #[test]
    fn by_default_the_apps_own_dot_folders_are_reached() {
        let temp = tempfile::tempdir().unwrap();
        assert!(temp.path().file_name().unwrap().to_string_lossy().starts_with(".tmp"));
        let inner = temp.path().join(".tmpinner").join("a.funda");
        std::fs::create_dir_all(inner.parent().unwrap()).unwrap();
        let scope = open(&[temp.path()], Path::new("/nonexistent-home"));
        assert_eq!(scope.check(&s(&inner), None).unwrap(), inner);
    }

    #[test]
    fn strict_mode_is_a_given_folder_or_the_strict_env() {
        let one = [PathBuf::from("D:/parts")];
        assert!(strict(&one, None));
        assert!(strict(&[], Some("1".into())));
        assert!(strict(&[], Some(" true ".into())));
        assert!(!strict(&[], None));
        assert!(!strict(&[], Some("0".into())));
        assert!(!strict(&[], Some(String::new())));
    }

    #[test]
    fn a_dropped_allow_path_is_named_in_the_refusal() {
        let base = dir();
        let home = base.path().join("me");
        let other = base.path().join("other");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let (scope, refused) = PathScope::new(vec![], vec![home.clone()], Some(home.clone()));
        assert_eq!(refused.len(), 1, "{refused:?}");
        let err = scope.check(&s(&other.join("a.funda")), None).unwrap_err();
        assert!(err.contains(&home.display().to_string()) && err.contains("ignored"), "{err}");
        assert!(err.contains("home folder itself"), "{err}");
        assert!(err.contains("--mcp --allow-path"), "{err}");
        assert!(!err.contains("copy the file"), "{err}");
    }

    #[test]
    fn allow_path_is_read_repeated_after_mcp_and_from_the_env_list() {
        let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        let got = allowed_paths(os(&["fundacad-mcp", "--allow-path", "A", "--allow-path=B", "--other"]), None);
        assert_eq!(got, vec![PathBuf::from("A"), PathBuf::from("B")]);
        let got = allowed_paths(os(&["fundacad", "--allow-path", "X", "--mcp", "--allow-path", "C"]), None);
        assert_eq!(got, vec![PathBuf::from("C")], "only what follows --mcp");
        let env = std::env::join_paths(["D", "E"]).unwrap();
        let got = allowed_paths(os(&["fundacad-mcp"]), Some(env));
        assert_eq!(got, vec![PathBuf::from("D"), PathBuf::from("E")]);
        assert!(allowed_paths(os(&["fundacad-mcp", "--allow-path"]), None).is_empty());
    }

    #[test]
    fn a_relative_path_resolves_against_the_working_folder_before_it_is_judged() {
        let cwd = std::env::current_dir().unwrap();
        let (scope, _) = PathScope::new(vec![], vec![cwd.clone()], None);
        assert_eq!(scope.check("x.funda", None).unwrap(), cwd.join("x.funda"));
    }
}
