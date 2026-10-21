//! The paths of files dropped on the window, on Windows and Linux.
//!
//! `dragDropEnabled` stays false in tauri.conf.json: turning it on makes wry
//! replace the webview's own drop handling with its own, and every in-page
//! HTML5 drag dies. On Windows the page gets the drop as File objects, which
//! carry no path, so it hands them back through
//! `chrome.webview.postMessageWithAdditionalObjects` and WebView2 says here
//! where each one lives. WebKitGTK gives the page no files at all
//! (webkit.org/b/271957), only an empty text/uri-list, so on Linux the uri
//! list is read from GTK as the drag enters and the page asks for it with
//! `drop_paths_take`. Either way the reply goes out as the `files-dropped`
//! event.

#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

use std::sync::Mutex;

use tauri::{Emitter, Runtime, WebviewWindow};

/// What the page's message starts with, followed by its request id.
const TAG: &str = "fundacad-drop:";

#[derive(Clone, serde::Serialize)]
struct Dropped {
    id: String,
    paths: Vec<Option<String>>,
}

/// The local paths of the last file drag from outside the window, until the
/// page takes them.
#[derive(Default)]
pub struct Held(Mutex<Vec<String>>);

#[tauri::command]
pub fn drop_paths_take(app: tauri::AppHandle, held: tauri::State<'_, Held>, id: String) {
    let paths = std::mem::take(&mut *held.0.lock().unwrap_or_else(|e| e.into_inner()));
    let _ = app.emit("files-dropped", Dropped { id, paths: paths.into_iter().map(Some).collect() });
}

#[cfg(windows)]
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2ObjectCollectionView,
        ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::{Interface, PWSTR};

    unsafe fn file_paths(list: &ICoreWebView2ObjectCollectionView) -> Vec<Option<String>> {
        let mut n = 0u32;
        if list.Count(&mut n).is_err() {
            return Vec::new();
        }
        (0..n)
            .map(|i| {
                let file = list.GetValueAtIndex(i).ok()?.cast::<ICoreWebView2File>().ok()?;
                let mut path = PWSTR::null();
                file.Path(&mut path).ok()?;
                Some(take_pwstr(path))
            })
            .collect()
    }

    let emitter = window.clone();
    let _ = window.with_webview(move |w| unsafe {
        let Ok(core) = w.controller().CoreWebView2() else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut text = PWSTR::null();
            // Not a string message, so not ours: Tauri's IPC reads those.
            if args.TryGetWebMessageAsString(&mut text).is_err() {
                return Ok(());
            }
            let text = take_pwstr(text);
            let Some(id) = text.strip_prefix(TAG) else { return Ok(()) };
            let paths = args
                .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                .ok()
                .and_then(|a| a.AdditionalObjects().ok())
                .map(|list| file_paths(&list))
                .unwrap_or_default();
            let _ = emitter.emit("files-dropped", Dropped { id: id.to_string(), paths });
            Ok(())
        }));
        // The handler lives as long as the webview, so its token is never needed.
        let mut token = 0i64;
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    });
}

#[cfg(target_os = "linux")]
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    use gtk::prelude::*;
    use tauri::Manager;

    let app = window.app_handle().clone();
    let _ = window.with_webview(move |w| {
        // WebKit connects its own handler after this one and preloads every
        // target before the page sees dragenter, so the paths are held before
        // the page can ask, and in-page drags carry on untouched.
        w.inner().connect_drag_data_received(move |_, ctx, _, _, data, _, _| {
            if data.target().name() != "text/uri-list" || ctx.drag_get_source_widget().is_some() {
                return;
            }
            let paths = crate::launch_args::uri_list_paths(&data.uris());
            *app.state::<Held>().0.lock().unwrap_or_else(|e| e.into_inner()) = paths;
        });
    });
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn install<R: Runtime>(_window: &WebviewWindow<R>) {}
