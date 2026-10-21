//! Documents handed to FundaCAD on its command line: a double click or Open
//! With in a file manager starts `fundacad %F`. The first launch reads its own
//! argv; a second launch hands its argv to the running instance through the
//! single-instance plugin. Both land in one queue the page drains, so a path
//! that arrives before the page listens is kept rather than lost.

use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;

use tauri::{Emitter, Manager, Runtime};

#[derive(Default)]
pub struct LaunchPaths(Mutex<Vec<String>>);

/// The documents in `argv`, absolute. argv[0] and flags are skipped, a
/// `file://` URI is decoded, and anything that is not a document is left out.
pub fn launch_paths(argv: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<String> {
    argv.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let arg = arg.into_string().ok()?;
            if arg.starts_with('-') {
                return None;
            }
            let path = if arg.starts_with("file://") {
                tauri::Url::parse(&arg).ok()?.to_file_path().ok()?
            } else {
                cwd.join(&arg)
            };
            crate::library::is_document(&path.file_name()?.to_string_lossy()).then(|| path.to_string_lossy().into_owned())
        })
        .collect()
}

pub fn queue_first_launch<R: Runtime>(app: &tauri::App<R>) {
    let cwd = std::env::current_dir().unwrap_or_default();
    let paths = launch_paths(std::env::args_os(), &cwd);
    app.state::<LaunchPaths>().0.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
}

pub fn queue_second_launch<R: Runtime>(app: &tauri::AppHandle<R>, argv: Vec<String>, cwd: &str) {
    let paths = launch_paths(argv.into_iter().map(OsString::from), Path::new(cwd));
    if paths.is_empty() {
        return;
    }
    app.state::<LaunchPaths>().0.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
    let _ = app.emit_to("main", "launch-paths", ());
}

#[tauri::command]
pub fn take_launch_paths(state: tauri::State<'_, LaunchPaths>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }

    #[cfg(unix)]
    #[test]
    fn launch_paths_keeps_documents_and_resolves_them_against_the_cwd() {
        let argv = args(&["/usr/bin/fundacad", "part.funda", "/tmp/Big.FUNDAB", "--flag", "notes.txt", "file:///tmp/a%20b.funda"]);
        assert_eq!(
            launch_paths(argv, Path::new("/home/u/cad")),
            vec!["/home/u/cad/part.funda", "/tmp/Big.FUNDAB", "/tmp/a b.funda"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn launch_paths_keeps_documents_and_resolves_them_against_the_cwd() {
        let argv = args(&["fundacad.exe", "part.funda", r"C:\tmp\Big.FUNDAB", "--flag", "notes.txt", "file:///C:/tmp/a%20b.funda"]);
        assert_eq!(
            launch_paths(argv, Path::new(r"C:\Users\u\cad")),
            vec![r"C:\Users\u\cad\part.funda", r"C:\tmp\Big.FUNDAB", r"C:\tmp\a b.funda"]
        );
    }

    #[test]
    fn launch_paths_skips_the_program_and_the_engine_modes() {
        assert!(launch_paths(args(&["fundacad", "--engine"]), Path::new("/")).is_empty());
        assert!(launch_paths(args(&["part.funda"]), Path::new("/")).is_empty());
        assert!(launch_paths(args(&["fundacad", ".funda"]), Path::new("/")).is_empty());
    }
}
