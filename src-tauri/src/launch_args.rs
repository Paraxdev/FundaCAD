//! The Tauri free half of launch.rs: which documents a launch names and the queue they wait in. Tauri free so
//! scripts/check-launch-args.sh can run these tests on Windows, where the app's test binary cannot start.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use url::Url;

#[derive(Default)]
pub struct LaunchPaths(Mutex<Vec<String>>);

impl LaunchPaths {
    /// Appends `paths` and says whether there were any.
    pub fn push(&self, paths: Vec<String>) -> bool {
        if paths.is_empty() {
            return false;
        }
        self.0.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
        true
    }

    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

fn document(path: PathBuf) -> Option<String> {
    crate::library::is_document(&path.file_name()?.to_string_lossy()).then(|| path.to_string_lossy().into_owned())
}

/// The documents in `argv`, absolute: flags skipped, `file://` decoded, anything else left out, which also drops the
/// pieces of an install path with spaces that the NSIS installer registers unquoted.
pub fn launch_paths(argv: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<String> {
    argv.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let arg = arg.into_string().ok()?;
            if arg.starts_with('-') {
                return None;
            }
            let path =
                if arg.starts_with("file://") { Url::parse(&arg).ok()?.to_file_path().ok()? } else { cwd.join(&arg) };
            document(path)
        })
        .collect()
}

/// The documents macOS hands a running app (Finder's Open With, a double click,
/// a drop on the Dock icon), which arrive as URLs rather than in argv.
pub fn opened_paths<'a>(urls: impl IntoIterator<Item = &'a Url>) -> Vec<String> {
    urls.into_iter().filter(|u| u.scheme() == "file").filter_map(|u| document(u.to_file_path().ok()?)).collect()
}

/// The local paths a drag's text/uri-list names, in order. Other schemes,
/// remote hosts and paths that are not UTF-8 are left out.
pub fn uri_list_paths<S: AsRef<str>>(uris: &[S]) -> Vec<String> {
    uris.iter()
        .filter_map(|u| Url::parse(u.as_ref().trim()).ok())
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok()?.into_os_string().into_string().ok())
        .collect()
}
