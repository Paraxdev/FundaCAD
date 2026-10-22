//! Documents the system hands over by double click or Open With: argv on first launch, the single instance plugin on
//! later ones, Opened events on macOS. All go to one queue the page drains, so a path that arrives early is kept.

use std::ffi::OsString;
use std::path::Path;

use tauri::{Emitter, Manager, Runtime};

use crate::launch_args::launch_paths;
pub use crate::launch_args::LaunchPaths;

pub fn queue_first_launch<R: Runtime>(app: &tauri::App<R>) {
    let cwd = std::env::current_dir().unwrap_or_default();
    app.state::<LaunchPaths>().push(launch_paths(std::env::args_os(), &cwd));
}

fn queue_and_tell<R: Runtime>(app: &tauri::AppHandle<R>, paths: Vec<String>) {
    if app.state::<LaunchPaths>().push(paths) {
        let _ = app.emit_to("main", "launch-paths", ());
    }
}

pub fn queue_second_launch<R: Runtime>(app: &tauri::AppHandle<R>, argv: Vec<String>, cwd: &str) {
    queue_and_tell(app, launch_paths(argv.into_iter().map(OsString::from), Path::new(cwd)));
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn queue_opened<R: Runtime>(app: &tauri::AppHandle<R>, urls: &[tauri::Url]) {
    queue_and_tell(app, crate::launch_args::opened_paths(urls));
}

#[tauri::command]
pub fn take_launch_paths(state: tauri::State<'_, LaunchPaths>) -> Vec<String> {
    state.take()
}
