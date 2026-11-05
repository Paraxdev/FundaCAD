//! The start question of safe_mode.rs, a small window in a process of its own (`fundacad --start-question <key> <n>`).
//! The app asks before it builds anything, as the answer decides its environment and its webview, and a start that
//! never mounts could not show a dialog in the page. The answer comes back as the exit code.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::safe_mode::{self, Answer, Reason, NOT_SHOWN};

pub const ARG: &str = "--start-question";
const SCHEME: &str = "fundacad-ask";
const LABEL: &str = "start-question";
const PAGE: &str = include_str!("start_question.html");
const CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/// Asks in a child process and waits for the answer, or says why there is none (`safe_mode::after_question`).
pub fn ask(reason: Reason) -> Result<Answer, String> {
    let wayland = std::env::var_os("WAYLAND_DISPLAY");
    let display = std::env::var_os("DISPLAY");
    if let Some(why) = safe_mode::cannot_ask(cfg!(target_os = "linux"), wayland.as_deref(), display.as_deref()) {
        return Err(why.into());
    }
    let exe = std::env::current_exe().map_err(|e| format!("its executable was not found ({e})"))?;
    let mut cmd = Command::new(exe);
    cmd.arg(ARG).arg(reason.key()).arg(reason.count().to_string()).stdin(Stdio::null());
    // The safe session's WebKit settings, so the question shows on the machines whose starts are failing.
    if cfg!(target_os = "linux") {
        if std::env::var_os(safe_mode::COMPOSITING).is_none() {
            cmd.env(safe_mode::COMPOSITING, "1");
        }
        let gdk = std::env::var_os(safe_mode::GDK_BACKEND);
        if safe_mode::falls_back_to_x11(true, gdk.as_deref(), wayland.as_deref(), display.as_deref()) {
            cmd.env(safe_mode::GDK_BACKEND, "x11");
        }
    }
    let status = cmd.status().map_err(|e| format!("it would not start ({e})"))?;
    Answer::from_exit(status.code())
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The question process: shows the window and returns the exit code of the answer. Closing the window is
/// Start normally, every failure is `NOT_SHOWN`.
pub fn run(args: &[String]) -> i32 {
    let reason = match (args.first(), args.get(1).and_then(|n| n.parse::<u32>().ok())) {
        (Some(key), Some(n)) => Reason::counted(key, n),
        _ => None,
    };
    let Some(reason) = reason else {
        eprintln!("[safe-mode] the start question was not told why it asks");
        return NOT_SHOWN;
    };
    #[cfg(target_os = "linux")]
    let _ = crate::webkit::apply_gpu_workarounds(&fundacad_mcp::app_session::app_data_dir());

    let page = PAGE.replace("{{QUESTION}}", &escape(&reason.question()));
    let answer: Arc<Mutex<Option<Answer>>> = Arc::default();
    let held = answer.clone();
    let mut context = crate::context();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol(SCHEME, move |_ctx, request| {
            let found = request.uri().path() == "/";
            tauri::http::Response::builder()
                .status(if found { 200u16 } else { 404u16 })
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Content-Security-Policy", CSP)
                .body(if found { page.clone().into_bytes() } else { Vec::new() })
                .unwrap_or_default()
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let url: tauri::Url = format!("{SCHEME}://localhost/").parse()?;
            // The form submits to /choice, which never loads: on Windows the page's origin is
            // http://fundacad-ask.localhost, elsewhere fundacad-ask://localhost, so only the path is checked.
            let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::CustomProtocol(url))
                .title("FundaCAD")
                .inner_size(420.0, 350.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .center()
                .focused(true)
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(27, 24, 38, 255))
                .on_navigation(move |url| {
                    if url.path() != "/choice" {
                        return true;
                    }
                    let pairs: Vec<(String, String)> =
                        url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                    let picked = Answer::from_form(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
                    *held.lock().unwrap_or_else(|p| p.into_inner()) = Some(picked.unwrap_or(Answer::Normal));
                    handle.exit(0);
                    false
                });
            // Its own profile, so the app's webview never meets one still closing with other options.
            if let Ok(dir) = app.path().app_local_data_dir() {
                builder = builder.data_directory(dir.join(LABEL));
            }
            if let Err(e) = builder.build() {
                // With no window the event loop would never end, and the app would wait on it forever.
                eprintln!("[safe-mode] the start question window would not open: {e}");
                std::process::exit(NOT_SHOWN);
            }
            Ok(())
        })
        .build(context);
    match app {
        Ok(app) => {
            app.run_return(|_, _| {});
        }
        Err(e) => {
            eprintln!("[safe-mode] the start question could not start: {e}");
            return NOT_SHOWN;
        }
    }
    let picked = answer.lock().unwrap_or_else(|p| p.into_inner()).take();
    picked.unwrap_or(Answer::Normal).code()
}
