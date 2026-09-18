//! FundaCAD Tauri shell entry. Supervises the geometry engine, this executable
//! started again as `--engine` (engine.rs), and relays it to the webview over
//! Tauri IPC; owns the window, native dialogs and the document container.

// `pub` so tests/container_seam.rs can drive the engine environment and the
// container the way the app does.
pub mod engine;
pub mod container;
pub use fundacad_format::{fnda, json_doc};
pub mod plugins;
pub mod session_file;
mod spacemouse;
// WebKitGTK only exists on Linux; macOS and Windows use WKWebView and WebView2.
#[cfg(target_os = "linux")]
mod webkit;

/// What a saved document is called on disk. New files take the first; the
/// second is read forever, because every document written before the rename is
/// still on someone's disk and no upgrade step can reach it. Kept in step with
/// src/io/documentExt.ts.
const DOC_EXT: &str = "funda";
/// Every extension a document was saved as before, read forever. Kept in step
/// with LEGACY_DOC_EXTS in src/io/documentExt.ts.
const LEGACY_DOC_EXTS: [&str; 2] = ["neocad", "sindri"];

use tauri::{Manager, RunEvent};

/// `fundacad --engine`: this process is the geometry worker, not the app.
pub fn run_engine_worker() -> ! {
    engine::run_worker()
}

/// Restart the app after an update, tearing down the geometry engine and
/// releasing the single-instance lock first, so the replacement process comes up
/// clean. Neither step can be left to a destructor, see the body.
#[tauri::command]
fn restart_for_update(app: tauri::AppHandle) {
    // Stop the geometry engine EXPLICITLY: `app.restart()` ends this process
    // through exit(), which runs no destructors, and the worker only notices its
    // stdin closing once the kernel call it is in returns. `Engine::stop` waits
    // for the worker, so the replacement never meets the old one.
    if let Some(engine) = app.try_state::<engine::Engine>() {
        engine.stop();
    }
    // Then release the single-instance lock. The frontend used to call the process
    // plugin's `relaunch()` directly, which maps to `app.request_restart()` and
    // spawns the replacement while this process is still shutting down, so with a
    // single-instance guard in place the NEW instance can find the lock still held
    // and exit immediately, leaving the user with no app at all after an update.
    // `destroy` is synchronous on every platform (D-Bus release_name on Linux,
    // ReleaseMutex + DestroyWindow on Windows), so it completes before the spawn.
    tauri_plugin_single_instance::destroy(&app);
    app.restart();
}

// --- crash-recovery snapshots -------------------------------------------------
// Autosave lives OUTSIDE the webview's tightened fs scope on purpose: widening
// `fs:scope` to an app-data dir would re-open part of the post-XSS persistence
// channel the security round closed. Instead the frontend calls these commands
// (privileged IPC, same pattern as the container commands) and Rust owns the recovery
// directory under app_data_dir()/recovery/. Writes are atomic (tmp + rename).

fn recovery_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// slot names are caller-chosen but sanitized hard: they become file names.
fn slot_file(app: &tauri::AppHandle, slot: &str) -> Result<std::path::PathBuf, String> {
    let safe: String = slot
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    if safe.is_empty() {
        return Err("empty recovery slot".into());
    }
    Ok(recovery_dir(app)?.join(format!("{safe}.{DOC_EXT}")))
}

#[tauri::command]
// async: Tauri runs sync commands on the MAIN thread, a multi-MB snapshot
// write would stall the UI for its full fs time. async moves it to the runtime
// pool; the tmp-write + rename stays atomic either way.
async fn recovery_write(app: tauri::AppHandle, slot: String, json: String) -> Result<(), String> {
    let path = slot_file(&app, &slot)?;
    let tmp = path.with_extension(concat!("funda", ".tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn recovery_read(app: tauri::AppHandle, slot: String) -> Result<Option<String>, String> {
    let path = slot_file(&app, &slot)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// list slots with their last-modified time (ms since epoch), newest first.
#[tauri::command]
fn recovery_list(app: tauri::AppHandle) -> Result<Vec<(String, u64)>, String> {
    let dir = recovery_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        // Both names, because a snapshot written before the rename is exactly
        // the case recovery exists for: the app crashed, and the next launch is
        // the one that has to find it.
        match p.extension().and_then(|e| e.to_str()) {
            Some(e) if e == DOC_EXT || LEGACY_DOC_EXTS.contains(&e) => {}
            _ => continue,
        }
        let name = match p.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push((name, mtime));
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(out)
}

#[tauri::command]
fn recovery_clear(app: tauri::AppHandle, slot: String) -> Result<(), String> {
    let path = slot_file(&app, &slot)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// In-app updates only apply to formats the Tauri updater can replace: the NSIS
/// install on Windows, the .app on macOS, and the AppImage on Linux. A deb/rpm
/// install belongs to the package manager, so the frontend hides the update UI
/// when this is false.
#[tauri::command]
fn updates_supported() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

// --- frontend load watchdog ---------------------------------------------------
// A webview that never loads its page shows a blank window and says NOTHING.
// Issue #3 spent four rounds on that: the geometry engine was up and logging
// happily, the window painted, and there was no way to tell from the outside
// whether the document had failed to load, or had loaded and thrown. Every reply
// was a guess at an environment variable.
//
// So the frontend reports in, and Rust says so when it does not.

/// Set by `frontend_ready`. `AtomicBool` rather than a channel because the
/// watchdog only ever asks one yes/no question, and a channel would have to be
/// kept alive for a message that normally never comes.
struct FrontendReady(std::sync::atomic::AtomicBool);

/// How long to wait before concluding the interface is not coming.
///
/// Generous on purpose. A cold first launch on a slow disk has to parse and
/// execute the whole bundle, and the cost of being wrong is asymmetric: a late
/// line in a log is harmless, while crying wolf on a working app would teach
/// people to ignore the one message that matters. This is why the watchdog only
/// logs and does not raise a dialog.
const FRONTEND_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// Called by `src/boot.ts` as the document loads. Its only job is to prove the
/// webview got far enough to run our code and reach Tauri IPC.
#[tauri::command]
fn frontend_ready(state: tauri::State<'_, FrontendReady>) {
    state.0.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Watch for the frontend checking in, and write a diagnosis if it never does.
///
/// The message deliberately rules the geometry engine out by name. That is the
/// wrong turn this is built to prevent: the engine is the loudest thing in the
/// log, so a blank window with a healthy engine above it reads as an engine
/// problem to everyone who sees it, and it is not one.
fn watch_frontend_load(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FRONTEND_READY_TIMEOUT);

        let ready = app
            .try_state::<FrontendReady>()
            .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false);
        if ready {
            return;
        }

        let secs = FRONTEND_READY_TIMEOUT.as_secs();
        let lines = [
            format!("[ui] WARNING: the interface has not loaded after {secs}s."),
            "[ui] The window opened but the page never started, so this is NOT a geometry".to_string(),
            "[ui] engine problem, the engine's own status is logged separately above."
                .to_string(),
            "[ui] Either the document failed to load, or a script threw while loading it."
                .to_string(),
            "[ui] Please report this log at https://github.com/Paraxdev/fundacad/issues"
                .to_string(),
        ];
        lines.iter().for_each(|l| eprintln!("{l}"));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FIRST, before any GTK/WebKit type is touched: the web process inherits this
    // environment when WebKit spawns it, so a variable set later is a variable the
    // renderer never sees. See webkit.rs for what it changes and why (issue #6).
    #[cfg(target_os = "linux")]
    webkit::apply_gpu_workarounds();

    let builder = tauri::Builder::default()
        // MUST be registered before every other plugin (Tauri's documented
        // requirement). A second launch focuses the window that is already open
        // instead of starting a second app on the same documents and plugins.
        // No `fileAssociations` exist, so `argv` carries nothing worth forwarding;
        // if one is ever added, this callback has to hand it to the running
        // instance or double-clicking a document file will silently do nothing.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize(); // a minimized window would otherwise just blink
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let builder = builder.invoke_handler(tauri::generate_handler![
        engine::mcp_server,
        engine::engine_attach,
        engine::engine_send,
        restart_for_update,
        updates_supported,
        frontend_ready,
        recovery_write,
        recovery_read,
        recovery_list,
        recovery_clear,
        container::container_save,
        container::container_open,
        container::container_open_checked,
        container::container_verify,
        container::container_is_container,
        plugins::plugin_list,
        plugins::plugin_inspect_url,
        plugins::plugin_inspect_file,
        plugins::plugin_install,
        plugins::plugin_install_file,
        plugins::plugin_entry,
        plugins::plugin_code,
        plugins::plugin_remove,
        plugins::files::plugin_file_pick,
        plugins::files::plugin_file_read,
        plugins::files::plugin_file_write,
        plugins::files::plugin_app_info,
        plugins::data::plugin_data_read,
        plugins::data::plugin_data_write,
        plugins::data::plugin_data_path,
        plugins::data::plugin_data_adopt,
        plugins::localnet::plugin_local_request,
        plugins::launch::plugin_system_dirs,
        plugins::launch::plugin_launch,
        spacemouse::spacemouse_inventory,
        spacemouse::spacemouse_start,
        spacemouse::spacemouse_stop
    ]);

    let app = builder
        .manage(spacemouse::Inventory::default())
        // The files a person has handed to a plugin this session. Session-lived
        // and nowhere on disk: a plugin cannot come back tomorrow holding a
        // token for a file somebody forgot they had offered it.
        .manage(plugins::files::Handles::default())
        .setup(|app| {
            app.manage(engine::Engine::start(app.handle()));
            // The 3D-mouse reader is NOT started here any more. It is a
            // capability the user can turn off (Preferences, Plugins), and one
            // that is off must not hold the HID device open. The frontend
            // starts it with spacemouse_start once it has its listeners up,
            // which also removes the old race where the reader published its
            // inventory before anything was listening.
            // Started here rather than before the builder because the clock
            // should run from the window existing, not from process start:
            // everything above it is work the frontend has to wait for anyway,
            // and counting it would eat into the timeout.
            app.manage(FrontendReady(std::sync::atomic::AtomicBool::new(false)));
            watch_frontend_load(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FundaCAD");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            if let Some(e) = app_handle.try_state::<engine::Engine>() {
                e.stop();
            }
        }
    });
}
