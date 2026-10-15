//! The paths of files dropped on the window, on Windows.
//!
//! `dragDropEnabled` stays false in tauri.conf.json: turning it on makes wry
//! replace WebView2's own drop target with its own, and every in-page HTML5
//! drag dies. The page still gets the drop as File objects, which carry no
//! path, so it hands them back through
//! `chrome.webview.postMessageWithAdditionalObjects` and WebView2 says here
//! where each one lives. The reply goes out as the `files-dropped` event.

#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

use tauri::{Emitter, Runtime, WebviewWindow};

/// What the page's message starts with, followed by its request id.
const TAG: &str = "fundacad-drop:";

#[derive(Clone, serde::Serialize)]
struct Dropped {
    id: String,
    paths: Vec<Option<String>>,
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

#[cfg(not(windows))]
pub fn install<R: Runtime>(_window: &WebviewWindow<R>) {}
