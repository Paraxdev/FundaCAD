//! The system and webview lines of a problem report, which the user agent cannot give: its WebKit token is frozen and
//! it names no Linux distribution or install kind.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct SystemInfo {
    system: String,
    webview: Option<String>,
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let flatpak = Path::new("/.flatpak-info").exists();
    let appimage = std::env::var_os("APPIMAGE").is_some();
    let release = if os == "linux" { os_release(Path::new("/"), flatpak) } else { None };
    SystemInfo {
        system: describe(os, arch, release.as_deref(), flatpak, appimage),
        webview: webview(os, tauri::webview_version().ok().as_deref()),
    }
}

/// Inside a Flatpak /etc/os-release is the runtime's, so only the host's copy under /run/host counts.
pub fn os_release(root: &Path, flatpak: bool) -> Option<String> {
    let file = if flatpak { "run/host/os-release" } else { "etc/os-release" };
    std::fs::read_to_string(root.join(file)).ok()
}

fn pretty_name(os_release: &str) -> Option<&str> {
    os_release
        .lines()
        .find_map(|l| l.trim().strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim().trim_matches(['"', '\'']).trim())
        .filter(|v| !v.is_empty())
}

pub fn describe(os: &str, arch: &str, os_release: Option<&str>, flatpak: bool, appimage: bool) -> String {
    let mut parts = vec![format!("{os} {arch}")];
    if os != "linux" {
        return parts.remove(0);
    }
    match os_release.and_then(pretty_name) {
        Some(name) => parts.push(name.to_string()),
        None if flatpak => parts.push("host unknown".to_string()),
        None => {}
    }
    if flatpak {
        parts.push("Flatpak".to_string());
    }
    if appimage {
        parts.push("AppImage".to_string());
    }
    parts.join(" · ")
}

pub fn webview(os: &str, version: Option<&str>) -> Option<String> {
    let engine = match os {
        "linux" => "WebKitGTK",
        "windows" => "WebView2",
        "macos" => "WebKit",
        _ => return None,
    };
    version.filter(|v| !v.is_empty()).map(|v| format!("{engine} {v}"))
}

#[cfg(test)]
#[path = "system_info_tests.rs"]
mod tests;
