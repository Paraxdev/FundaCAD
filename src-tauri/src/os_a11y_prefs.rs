//! Whether the OS asks for high contrast, for the System theme. WebKitGTK reports no prefers-contrast for GNOME High
//! Contrast and WKWebView before Safari 14.1 none for Increase contrast, so the webview also asks here.

use serde::Serialize;

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OsA11yPrefs {
    /// None when the OS could not be asked, so the webview's media queries decide alone.
    pub high_contrast: Option<bool>,
}

pub fn read() -> OsA11yPrefs {
    OsA11yPrefs { high_contrast: high_contrast() }
}

pub const HCF_HIGHCONTRASTON: u32 = 0x1;

pub fn high_contrast_flag(flags: u32) -> bool {
    flags & HCF_HIGHCONTRASTON != 0
}

/// `gdbus call` prints the portal value as `(<uint32 1>,)` from ReadOne, or `(<<uint32 1>>,)` from the older Read.
pub fn parse_portal_contrast(out: &str) -> Option<bool> {
    let rest = out.split("uint32").nth(1)?.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    match digits.parse::<u32>().ok()? {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

pub fn parse_gsettings_bool(out: &str) -> Option<bool> {
    match out.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

pub fn parse_defaults_bool(out: &str) -> Option<bool> {
    match out.trim() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

/// GTK_THEME forces a theme on this app alone, so it can say yes but never no.
pub fn gtk_theme_high_contrast(value: Option<&str>) -> Option<bool> {
    value.filter(|v| v.to_ascii_lowercase().contains("highcontrast")).map(|_| true)
}

/// The first source that answers decides, so a portal no is not overruled by a stale gsettings key.
pub fn linux_high_contrast(
    gtk_theme: Option<&str>,
    portal: impl FnOnce() -> Option<String>,
    gsettings: impl FnOnce() -> Option<String>,
) -> Option<bool> {
    gtk_theme_high_contrast(gtk_theme)
        .or_else(|| portal().as_deref().and_then(parse_portal_contrast))
        .or_else(|| gsettings().as_deref().and_then(parse_gsettings_bool))
}

#[cfg(windows)]
fn high_contrast() -> Option<bool> {
    use std::ffi::c_void;
    #[repr(C)]
    struct HighContrastW {
        cb_size: u32,
        flags: u32,
        _default_scheme: *mut u16,
    }
    #[link(name = "user32")]
    extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, value: *mut c_void, win_ini: u32) -> i32;
    }
    const SPI_GETHIGHCONTRAST: u32 = 0x0042;
    let mut hc = HighContrastW {
        cb_size: std::mem::size_of::<HighContrastW>() as u32,
        flags: 0,
        _default_scheme: std::ptr::null_mut(),
    };
    // SAFETY: a HIGHCONTRASTW with its cbSize set, which the call fills; the scheme name it points at is never read.
    let ok =
        unsafe { SystemParametersInfoW(SPI_GETHIGHCONTRAST, hc.cb_size, (&mut hc as *mut HighContrastW).cast(), 0) };
    (ok != 0).then(|| high_contrast_flag(hc.flags))
}

#[cfg(target_os = "linux")]
fn high_contrast() -> Option<bool> {
    const PORTAL: [&str; 9] = [
        "call",
        "--session",
        "--timeout=2",
        "--dest=org.freedesktop.portal.Desktop",
        "--object-path=/org/freedesktop/portal/desktop",
        "--method",
        "",
        "org.freedesktop.appearance",
        "contrast",
    ];
    let portal = |method: &str| {
        let mut args = PORTAL;
        args[6] = method;
        run("gdbus", &args)
    };
    let gtk_theme = std::env::var("GTK_THEME").ok();
    linux_high_contrast(
        gtk_theme.as_deref(),
        || portal("org.freedesktop.portal.Settings.ReadOne").or_else(|| portal("org.freedesktop.portal.Settings.Read")),
        || run("gsettings", &["get", "org.gnome.desktop.a11y.interface", "high-contrast"]),
    )
}

#[cfg(target_os = "macos")]
fn high_contrast() -> Option<bool> {
    run("defaults", &["read", "com.apple.universalaccess", "increaseContrast"]).as_deref().and_then(parse_defaults_bool)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn high_contrast() -> Option<bool> {
    None
}

/// A missing tool, a failed call or a missing key all give None.
#[cfg(unix)]
fn run(program: &str, args: &[&str]) -> Option<String> {
    use std::process::{Command, Stdio};
    let out = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
#[path = "os_a11y_prefs_tests.rs"]
mod tests;
