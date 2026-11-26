//! The file dialogs every transfer goes through, kept to these two so another picker can replace them.

use std::future::Future;
use std::path::{Path, PathBuf};

use gpui::{App, PathPromptOptions};

/// A path to save to, None when the user backed out.
pub fn pick_save_path(cx: &App, dir: &Path, suggested: &str) -> impl Future<Output = Option<PathBuf>> + 'static {
    let rx = cx.prompt_for_new_path(dir, Some(suggested));
    async move {
        match rx.await {
            Ok(Ok(path)) => path,
            Ok(Err(e)) => {
                log::error!("the save dialog failed: {e}");
                None
            }
            Err(_) => None,
        }
    }
}

/// Files to open with one of `exts`, empty when the user backed out.
pub fn pick_open_paths(
    cx: &App,
    exts: &'static [&'static str],
    multiple: bool,
) -> impl Future<Output = Vec<String>> + 'static {
    let rx = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple, prompt: None });
    async move {
        match rx.await {
            Ok(Ok(Some(paths))) => keep_exts(paths, exts),
            Ok(Err(e)) => {
                log::error!("the open dialog failed: {e}");
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

/// The platform dialog takes no filter, so what it returns is filtered here.
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
