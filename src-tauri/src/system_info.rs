//! The system, webview and accessibility lines of a problem report, which the user agent cannot give: its WebKit
//! token is frozen and it names no Linux distribution, install kind or accessibility bus.

use serde::Serialize;
use std::path::Path;
use std::time::Duration;

#[derive(Serialize)]
pub struct SystemInfo {
    system: String,
    webview: Option<String>,
    accessibility: Option<String>,
}

/// Async so the bus probe never holds the main thread.
#[tauri::command(async)]
pub fn system_info() -> SystemInfo {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let flatpak = in_flatpak();
    let appimage = std::env::var_os("APPIMAGE").is_some();
    let release = if os == "linux" { os_release(Path::new("/"), flatpak) } else { None };
    SystemInfo {
        system: describe(os, arch, release.as_deref(), flatpak, appimage),
        webview: webview(os, tauri::webview_version().ok().as_deref()),
        accessibility: linux_accessibility(),
    }
}

/// Where Orca would find the app. libatspi looks the same way: AT_SPI_BUS_ADDRESS first, which is how a Flatpak
/// hands in its proxied bus, then org.a11y.Bus on the session bus.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Bus {
    Given,
    Session,
    NoSessionBus,
    NoService,
    Unknown,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const BUS_WAIT: Duration = Duration::from_millis(200);

#[cfg(target_os = "linux")]
fn linux_accessibility() -> Option<String> {
    let env = |k: &str| std::env::var(k).ok();
    let bus = match env("AT_SPI_BUS_ADDRESS").filter(|a| !a.is_empty()) {
        Some(_) => Bus::Given,
        None => session_a11y_bus(BUS_WAIT),
    };
    Some(accessibility(bus, &env))
}

#[cfg(not(target_os = "linux"))]
fn linux_accessibility() -> Option<String> {
    None
}

/// Asked only when a report wants it: GetAddress starts at-spi-bus-launcher when it is installed but not running.
#[cfg(target_os = "linux")]
fn session_a11y_bus(wait: Duration) -> Bus {
    use gtk::{gio, glib};
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let Ok(session) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
            let _ = tx.send(Bus::NoSessionBus);
            return;
        };
        let reply = session.call_sync(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            "org.a11y.Bus",
            "GetAddress",
            None,
            glib::VariantTy::new("(s)").ok(),
            gio::DBusCallFlags::NONE,
            i32::try_from(wait.as_millis()).unwrap_or(i32::MAX),
            gio::Cancellable::NONE,
        );
        let up = reply.ok().and_then(|v| v.child_value(0).str().map(|a| !a.is_empty())).unwrap_or(false);
        let _ = tx.send(if up { Bus::Session } else { Bus::NoService });
    });
    rx.recv_timeout(wait).unwrap_or(Bus::Unknown)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn accessibility(bus: Bus, env: &dyn Fn(&str) -> Option<String>) -> String {
    let set = |k: &str| env(k).filter(|v| !v.is_empty());
    let mut parts = vec![match bus {
        Bus::Given => "AT-SPI bus from AT_SPI_BUS_ADDRESS".to_string(),
        Bus::Session => "AT-SPI bus up".to_string(),
        Bus::NoSessionBus => "no AT-SPI bus, no session bus".to_string(),
        Bus::NoService => "no AT-SPI bus on the session bus".to_string(),
        Bus::Unknown => format!("AT-SPI bus did not answer in {} ms", BUS_WAIT.as_millis()),
    }];
    parts.extend(set("NO_AT_BRIDGE").map(|v| format!("NO_AT_BRIDGE={v}")));
    parts.extend(set("GTK_MODULES").map(|v| format!("GTK_MODULES={v}")));
    parts.extend(set("XDG_SESSION_TYPE"));
    parts.extend(set("GDK_BACKEND").map(|v| format!("GDK_BACKEND={v}")));
    parts.join(" · ")
}

pub const BRIDGE_OFF: &str =
    "[a11y] NO_AT_BRIDGE=1 is set, so screen readers such as Orca cannot read FundaCAD. Start it without NO_AT_BRIDGE to use one.";

/// at-spi2-core's own test (atk-adaptor/bridge.c): the bridge stays off when atoi(NO_AT_BRIDGE) == 1.
pub fn bridge_off(value: Option<&str>) -> bool {
    value.is_some_and(|v| atoi(v) == 1)
}

fn atoi(s: &str) -> i64 {
    let s = s.trim_start_matches([' ', '\t', '\n', '\x0b', '\x0c', '\r']);
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let n = digits
        .bytes()
        .take_while(u8::is_ascii_digit)
        .fold(0i64, |n, d| n.saturating_mul(10).saturating_add(i64::from(d - b'0')));
    if neg {
        -n
    } else {
        n
    }
}

pub fn in_flatpak() -> bool {
    cfg!(target_os = "linux") && Path::new("/.flatpak-info").exists()
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
