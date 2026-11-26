//! The file dialogs every transfer goes through, rfd's as files::open and save use.

use std::future::Future;
use std::path::{Path, PathBuf};

/// A path to save to, None when the user backed out.
pub fn pick_save_path(dir: &Path, suggested: &str) -> impl Future<Output = Option<PathBuf>> + 'static {
    let dialog = rfd::AsyncFileDialog::new().set_title("Export").set_directory(dir).set_file_name(suggested);
    async move { dialog.save_file().await.map(|f| f.path().to_path_buf()) }
}

/// Files to open with one of `exts`, empty when the user backed out.
pub fn pick_open_paths(exts: &'static [&'static str], multiple: bool) -> impl Future<Output = Vec<String>> + 'static {
    let dialog = rfd::AsyncFileDialog::new().add_filter("Supported files", exts);
    async move {
        let picked = if multiple {
            dialog.pick_files().await.unwrap_or_default()
        } else {
            dialog.pick_file().await.into_iter().collect()
        };
        keep_exts(picked.iter().map(|f| f.path().to_path_buf()).collect(), exts)
    }
}

/// The filter is only a hint on some platforms, so what the dialog returns is filtered again.
pub fn keep_exts(paths: Vec<PathBuf>, exts: &[&str]) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            exts.iter().any(|x| x.eq_ignore_ascii_case(ext))
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}
