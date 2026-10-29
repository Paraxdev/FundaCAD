//! The Tauri shell: supervises the engine worker (engine.rs) and relays it to the webview, and owns the window, dialogs
//! and the document container.

// `pub` so tests/container_seam.rs can drive the engine environment and the
// container the way the app does.
pub mod container;
pub mod engine;
pub use fundacad_format::{fnda, json_doc};
mod drop_paths;
pub mod frames;
mod home_commands;
mod launch;
pub mod launch_args;
pub mod library;
mod log_file;
pub mod plugins;
pub mod safe_mode;
pub mod session_file;
pub mod settings_files;
mod spacemouse;
mod system_info;
pub mod thumbs;
pub mod webkit;

/// Kept in step with src/io/documentExt.ts.
const DOC_EXT: &str = "funda";
/// Read forever: documents saved under these names sit on disks no upgrade step reaches. Kept in step with
/// LEGACY_DOC_EXTS in src/io/documentExt.ts.
const LEGACY_DOC_EXTS: [&str; 2] = ["neocad", "sindri"];

use tauri::{Manager, RunEvent};

/// `fundacad --engine`: this process is the geometry worker, not the app.
pub fn run_engine_worker() -> ! {
    engine::run_worker()
}

/// Restart after an update, stopping the engine and releasing the single instance lock first so the new process comes
/// up clean. Neither can be left to a destructor.
#[tauri::command]
fn restart_for_update(app: tauri::AppHandle) {
    // exit() runs no destructors and the worker only sees its stdin close after its current kernel call, so stop it
    // here. `Engine::stop` waits, so the replacement never meets the old worker.
    if let Some(engine) = app.try_state::<engine::Engine>() {
        engine.stop();
    }
    // The replacement can start before this process ends and find the lock still held, leaving no app after an update.
    // `destroy` is synchronous on every platform, so it completes before the spawn.
    tauri_plugin_single_instance::destroy(&app);
    app.restart();
}

// Crash recovery snapshots live outside the webview's fs scope on purpose, since widening it would reopen the post XSS
// persistence channel. Rust owns app_data_dir()/recovery/ and writes atomically (tmp + rename).

fn recovery_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recovery");
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
// async: Tauri runs sync commands on the main thread, where a multi MB snapshot write would stall the UI.
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
        // Both names: a snapshot written before the rename is exactly what recovery exists for.
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

/// In app updates only apply to what the Tauri updater can replace: NSIS on Windows, the .app, the AppImage. A deb or
/// rpm install belongs to the package manager, so the frontend hides the update UI.
#[tauri::command]
fn updates_supported() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

// A webview that never loads shows a blank window and says nothing (issue #3), so the frontend reports in and Rust logs
// when it does not.

/// Set by `frontend_ready`: `booted` when the document loads, `mounted` once the interface painted.
#[derive(Default)]
struct FrontendReady {
    booted: std::sync::atomic::AtomicBool,
    mounted: std::sync::atomic::AtomicBool,
}

fn frontend_mounted(app: &tauri::AppHandle) -> bool {
    app.try_state::<FrontendReady>().is_some_and(|s| s.mounted.load(std::sync::atomic::Ordering::Relaxed))
}

/// Generous on purpose: a cold first launch on a slow disk parses the whole bundle, and crying wolf on a working app
/// would teach people to ignore the message. So the watchdog only logs.
const FRONTEND_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// Called by `src/boot.ts` as the document loads, and by `src/main.ts` with `stage: "mounted"` once the interface is
/// up, which is what counts as a finished start. The boot ping runs too early to prove that.
#[tauri::command]
fn frontend_ready(state: tauri::State<'_, FrontendReady>, safe: tauri::State<'_, SafeMode>, stage: Option<String>) {
    use std::sync::atomic::Ordering::Relaxed;
    state.booted.store(true, Relaxed);
    if stage.as_deref() != Some("mounted") {
        return;
    }
    state.mounted.store(true, Relaxed);
    if safe_mode::clears_count(safe.reason) {
        safe_mode::cleared(&safe.dir);
    }
}

/// Sent by src/app/firstFrame.ts when scripts run but no frame ever paints, the WebKit compositor stall the Steam
/// Deck showed (webkit.rs). Remembers it for this machine and starts again with DMA-BUF off, once.
#[tauri::command]
fn frontend_stalled(app: tauri::AppHandle) {
    if !cfg!(target_os = "linux") {
        eprintln!("[frontend] the page runs but never painted");
        return;
    }
    let (dir, reason) = {
        let safe = app.state::<SafeMode>();
        (safe.dir.clone(), safe.reason)
    };
    match webkit::on_stall(std::env::var_os(webkit::DMABUF).is_some(), webkit::opted_out()) {
        webkit::StallAction::Restart => {}
        webkit::StallAction::Forget => {
            if let Err(e) = webkit::forget_stall(&dir) {
                eprintln!("[gpu] could not forget the stall in {}: {e}", dir.display());
            }
            eprintln!("[gpu] the page runs but never painted with the WebKitGTK DMABUF renderer off either");
            return;
        }
        webkit::StallAction::GiveUp => {
            eprintln!("[gpu] the page runs but never painted, with no renderer fallback left to try");
            return;
        }
    }
    if let Err(e) = webkit::record_stall(&dir) {
        eprintln!("[gpu] could not remember the stall in {}: {e}", dir.display());
    }
    println!("[gpu] the page runs but never painted, starting again with the WebKitGTK DMABUF renderer off");
    // The stalled start is not a failed one, or the restart would count towards safe mode. A safe session keeps its
    // switch and count, so it comes back safe.
    if safe_mode::clears_count(reason) {
        safe_mode::cleared(&dir);
    }
    let args = app.env().args_os;
    respawn(&app, args, |cmd| {
        cmd.env(webkit::DMABUF, "1");
    });
}

/// What a bug report attaches of the log: the report reaches a GitHub issue
/// through the clipboard, and an issue body holds 65,536 characters.
const LOG_TAIL: u64 = 16 << 10;

#[tauri::command]
fn log_tail(run: tauri::State<'_, log_file::RunLog>) -> Option<String> {
    log_file::tail_for_run(&run, LOG_TAIL)
}

/// A crumb from the page, kept in the log where it outlives the window.
#[tauri::command]
fn log_line(line: String) {
    println!("[crumb] {line}");
}

/// Why this session runs in safe mode, if it does (safe_mode.rs).
struct SafeMode {
    reason: Option<safe_mode::Reason>,
    dir: std::path::PathBuf,
    set_compositing: bool,
}

pub(crate) fn safe_mode_active(app: &tauri::AppHandle) -> bool {
    app.try_state::<SafeMode>().is_some_and(|s| s.reason.is_some())
}

/// The banner's "Restart normally": a new process without this session's safe mode switch, variable or compositing
/// setting, and a cleared count.
#[tauri::command]
fn safe_mode_exit(app: tauri::AppHandle) {
    let (dir, set_compositing) = {
        let safe = app.state::<SafeMode>();
        (safe.dir.clone(), safe.set_compositing)
    };
    safe_mode::cleared(&dir);
    let args = safe_mode::restart_args(app.env().args_os);
    respawn(&app, args, |cmd| {
        cmd.env_remove(safe_mode::ENV);
        if set_compositing {
            cmd.env_remove(safe_mode::COMPOSITING);
        }
    });
}

/// Starts this binary again with `args` (the first is the program and is skipped) and exits. Teardown as in
/// `restart_for_update`. A child spawned inside a Flatpak keeps the sandbox alive, so this works there too.
fn respawn(
    app: &tauri::AppHandle,
    args: Vec<std::ffi::OsString>,
    adjust: impl FnOnce(&mut std::process::Command),
) -> ! {
    if let Some(engine) = app.try_state::<engine::Engine>() {
        engine.stop();
    }
    tauri_plugin_single_instance::destroy(app);
    match tauri::process::current_binary(&app.env()) {
        Ok(exe) => {
            let mut cmd = std::process::Command::new(exe);
            cmd.args(args.iter().skip(1));
            adjust(&mut cmd);
            if let Err(e) = cmd.spawn() {
                eprintln!("[restart] could not start FundaCAD again: {e}");
            }
        }
        Err(e) => eprintln!("[restart] could not find the FundaCAD executable: {e}"),
    }
    app.cleanup_before_exit();
    std::process::exit(0);
}

/// Reads the count and the switches before any webview exists. The count is only written in `.setup`, after the single
/// instance check, or every second launch would count as a failure.
fn safe_mode_decide() -> SafeMode {
    let dir = fundacad_mcp::app_session::app_data_dir();
    let reason = safe_mode::decide(
        safe_mode::misses(&dir),
        safe_mode::has_flag(std::env::args_os()),
        std::env::var(safe_mode::ENV).ok().as_deref(),
    );
    let set_compositing =
        cfg!(target_os = "linux") && reason.is_some() && std::env::var_os(safe_mode::COMPOSITING).is_none();
    if set_compositing {
        // Issue #6: with it off WebKitGTK came up on GPUs the DMABUF rule misses.
        std::env::set_var(safe_mode::COMPOSITING, "1");
    }
    if let Some(r) = reason {
        println!(
            "[safe-mode] starting in safe mode because {}: no plugins, default preferences, \
             no work recovery{}. Restart normally from the banner to leave it.",
            r.describe(),
            if set_compositing { ", WebKit compositing off" } else { "" },
        );
    }
    SafeMode { reason, dir, set_compositing }
}

/// Writes a diagnosis if the frontend never checks in. It rules the engine out by name: the loudest thing in the log, a
/// healthy engine above a blank window reads as an engine problem, and it is not.
fn watch_frontend_load(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FRONTEND_READY_TIMEOUT);

        let ready =
            app.try_state::<FrontendReady>().is_some_and(|s| s.booted.load(std::sync::atomic::Ordering::Relaxed));
        if ready {
            return;
        }

        let secs = FRONTEND_READY_TIMEOUT.as_secs();
        let lines = [
            format!("[ui] WARNING: the interface has not loaded after {secs}s."),
            "[ui] The window opened but the page never started, so this is NOT a geometry".to_string(),
            "[ui] engine problem, the engine's own status is logged separately above.".to_string(),
            "[ui] Either the document failed to load, or a script threw while loading it.".to_string(),
            "[ui] Please report this log at https://github.com/Paraxdev/fundacad/issues".to_string(),
        ];
        lines.iter().for_each(|l| eprintln!("{l}"));
    });
}

fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

/// Read from the build config, which the development build overrides, so the MCP server finds the session and data
/// directory of the app it ships in.
pub fn share_app_identifier() {
    fundacad_mcp::app_session::set_app_identifier(&context().config().identifier);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    share_app_identifier();
    // First, before any GTK or WebKit type is touched: the web process inherits this environment when WebKit spawns it.
    // webkit.rs says what it changes and why (issue #6).
    let safe = safe_mode_decide();
    #[cfg(target_os = "linux")]
    webkit::apply_gpu_workarounds(&safe.dir);

    let builder = tauri::Builder::default()
        // Must be registered before every other plugin (Tauri's requirement). A second launch focuses the open window
        // and hands it its documents (launch.rs).
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize(); // a minimized window would otherwise just blink
                let _ = w.show();
                let _ = w.set_focus();
            }
            launch::queue_second_launch(app, argv, &cwd);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The page's close listener (unsavedGuard.ts) makes Tauri wait for the page to close the window, and a page
        // that never mounted may never answer, so the window could not be closed. Nothing unsaved exists before mount.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if !frontend_mounted(window.app_handle()) {
                    let _ = window.destroy();
                }
            }
        });
    let builder = match safe.reason {
        Some(reason) => builder.plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("fundacad-safe-mode")
                .js_init_script(safe_mode::init_script(reason))
                .build(),
        ),
        None => builder,
    };

    let builder = builder.invoke_handler(tauri::generate_handler![
        engine::mcp_server,
        engine::engine_attach,
        engine::engine_send,
        restart_for_update,
        updates_supported,
        frontend_ready,
        frontend_stalled,
        log_tail,
        log_line,
        system_info::system_info,
        safe_mode_exit,
        launch::take_launch_paths,
        drop_paths::drop_paths_take,
        recovery_write,
        recovery_read,
        recovery_list,
        recovery_clear,
        container::container_save,
        container::container_open,
        container::container_open_checked,
        container::container_open_bytes,
        container::container_verify,
        container::container_is_container,
        home_commands::library_stat,
        home_commands::library_list,
        home_commands::doc_summary,
        home_commands::thumb_get,
        home_commands::thumb_put,
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
        plugins::web::plugin_web_request,
        plugins::web::plugin_download_remove,
        plugins::keystore::plugin_secret_set,
        plugins::keystore::plugin_secret_get,
        plugins::keystore::plugin_secret_delete,
        plugins::launch::plugin_system_dirs,
        plugins::launch::plugin_launch,
        spacemouse::spacemouse_inventory,
        spacemouse::spacemouse_start,
        spacemouse::spacemouse_stop,
        frames::frames_open,
        frames::frames_next,
        frames::frames_resize,
        frames::frames_close,
        frames::tracer::pt_scene,
        frames::tracer::pt_mesh,
        frames::tracer::pt_env,
        frames::tracer::pt_colors,
        frames::tracer::pt_camera,
        frames::tracer::pt_look,
        frames::tracer::pt_cap,
        frames::tracer::pt_budget,
        frames::tracer::pt_denoise,
        frames::tracer::pt_bloom,
        frames::tracer::pt_status,
        frames::tracer::pt_picture,
        frames::tracer::pt_picture_cancel,
        frames::tracer::pt_probe,
        frames::tracer::pt_selfcheck,
        frames::denoiser::pt_denoiser,
        frames::denoiser::pt_denoiser_download
    ]);

    let app = builder
        .manage(spacemouse::Inventory::default())
        .manage(launch::LaunchPaths::default())
        .manage(drop_paths::Held::default())
        // Files a person handed to a plugin this session, never on disk, so a plugin cannot come back tomorrow holding
        // a token for a file somebody forgot they offered.
        .manage(plugins::files::Handles::default())
        .manage(safe)
        .setup(|app| {
            // A Windows or Linux debug build runs in a dev's terminal, which `tauri dev` may pipe.
            let to_file = cfg!(target_os = "macos") || !cfg!(debug_assertions);
            let run = match app.path().app_log_dir().ok().filter(|_| to_file) {
                None => log_file::RunLog::Off,
                Some(dir) => match log_file::redirect(&dir) {
                    Ok(Some(path)) => {
                        println!("[log] FundaCAD {} started, logs to {}", env!("CARGO_PKG_VERSION"), path.display());
                        // Printed before the log took over, so repeated where a report will find it.
                        if let Some(r) = app.state::<SafeMode>().reason {
                            println!("[safe-mode] starting in safe mode because {}", r.describe());
                        }
                        log_file::RunLog::ToFile(path)
                    }
                    Ok(None) => log_file::RunLog::Terminal,
                    Err(e) => {
                        eprintln!("[log] no log file in {}: {e}", dir.display());
                        log_file::RunLog::Failed(e.to_string())
                    }
                },
            };
            app.manage(run);
            let (reason, dir) = {
                let safe = app.state::<SafeMode>();
                (safe.reason, safe.dir.clone())
            };
            if reason.is_none() {
                if let Err(e) = safe_mode::begin(&dir) {
                    eprintln!("[safe-mode] could not count this start in {}: {e}", dir.display());
                }
            }
            if let (Ok(data), Ok(root)) = (app.path().app_data_dir(), plugins::plugins_root(app.handle())) {
                for kept in settings_files::check_settings(&data, &root, plugins::RECORD) {
                    println!("[settings] a settings file did not read and was kept as {}", kept.display());
                }
            }
            launch::queue_first_launch(app);
            app.manage(engine::Engine::start(app.handle()));
            if reason.is_none() {
                frames::denoiser::load_installed(app.handle());
            }
            // The 3D mouse reader is not started here: the frontend starts it with `spacemouse_start`, see there.
            // Started here rather than before the builder, so the clock runs from the window existing and the work
            // above, which the frontend waits for anyway, does not eat into the timeout.
            app.manage(FrontendReady::default());
            watch_frontend_load(app.handle().clone());
            if let Some(w) = app.get_webview_window("main") {
                drop_paths::install(&w);
            }
            Ok(())
        })
        .build(context())
        .expect("error while building FundaCAD");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = &event {
            launch::queue_opened(app_handle, urls);
        }
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            if let Some(e) = app_handle.try_state::<engine::Engine>() {
                e.stop();
            }
        }
    });
}
