//! After `THRESHOLD` starts in a row that never mount the interface, the app comes up with defaults (issues #3 and #6).
//! The count file is written after the single instance check and removed on mount, so a leftover is an unfinished
//! start.

use std::ffi::OsString;
use std::path::Path;

pub const MARKER: &str = "launch-pending";
pub const THRESHOLD: u32 = 2;
pub const FLAG: &str = "--safe-mode";
pub const ENV: &str = "FUNDACAD_SAFE_MODE";
pub const COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    FailedStarts(u32),
    Flag,
    Env,
}

impl Reason {
    pub fn key(self) -> &'static str {
        match self {
            Reason::FailedStarts(_) => "failedStarts",
            Reason::Flag => "flag",
            Reason::Env => "env",
        }
    }

    pub fn describe(self) -> String {
        match self {
            Reason::FailedStarts(n) => format!("the last {n} starts did not finish"),
            Reason::Flag => format!("{FLAG} was given"),
            Reason::Env => format!("{ENV} is set"),
        }
    }
}

pub fn env_on(value: Option<&str>) -> bool {
    matches!(value.map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("1" | "true" | "yes" | "on"))
}

/// An explicit request is preferred over the count, so the banner names what
/// the person can actually undo.
pub fn decide(prev_misses: u32, flag: bool, env: Option<&str>) -> Option<Reason> {
    if flag {
        Some(Reason::Flag)
    } else if env_on(env) {
        Some(Reason::Env)
    } else if prev_misses >= THRESHOLD {
        Some(Reason::FailedStarts(prev_misses))
    } else {
        None
    }
}

pub fn has_flag<I: IntoIterator<Item = OsString>>(args: I) -> bool {
    args.into_iter().skip(1).any(|a| a == FLAG)
}

/// How many starts in a row did not finish. A marker that does not hold a
/// number is moved aside and counts as none.
pub fn misses(dir: &Path) -> u32 {
    let path = dir.join(MARKER);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return 0;
    };
    match text.trim().parse::<u32>() {
        Ok(n) => n,
        Err(_) => {
            let _ = crate::settings_files::back_up(&path);
            0
        }
    }
}

/// Count this start as pending and return how many were pending before it.
pub fn begin(dir: &Path) -> std::io::Result<u32> {
    let prev = misses(dir);
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(MARKER), prev.saturating_add(1).to_string())?;
    Ok(prev)
}

pub fn cleared(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MARKER));
}

/// The arguments a normal restart is given: these, without the switch.
pub fn restart_args(args: Vec<OsString>) -> Vec<OsString> {
    args.into_iter().filter(|a| a != FLAG).collect()
}

/// Runs before any page script: tells the page why it is in safe mode, and
/// gives it an in memory `localStorage`, so it reads default preferences and
/// nothing it writes reaches the saved ones.
pub fn init_script(reason: Reason) -> String {
    let n = match reason {
        Reason::FailedStarts(n) => n,
        _ => 0,
    };
    format!(
        "window.__FUNDACAD_SAFE_MODE__ = {{ reason: \"{}\", failedStarts: {n} }};\n{}",
        reason.key(),
        include_str!("safe_mode_storage.js")
    )
}
