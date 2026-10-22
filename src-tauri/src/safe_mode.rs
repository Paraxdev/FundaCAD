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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fundacad-safe-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fresh_start_is_normal() {
        let d = dir("fresh");
        assert_eq!(decide(misses(&d), false, None), None);
        assert_eq!(begin(&d).unwrap(), 0);
        assert_eq!(std::fs::read_to_string(d.join(MARKER)).unwrap(), "1");
    }

    #[test]
    fn one_miss_is_still_normal() {
        let d = dir("one");
        begin(&d).unwrap();
        assert_eq!(decide(misses(&d), false, None), None);
        assert_eq!(begin(&d).unwrap(), 1);
        assert_eq!(misses(&d), 2);
    }

    #[test]
    fn two_misses_start_safe() {
        let d = dir("two");
        begin(&d).unwrap();
        begin(&d).unwrap();
        assert_eq!(decide(misses(&d), false, None), Some(Reason::FailedStarts(2)));
    }

    #[test]
    fn a_mounted_start_resets_the_count() {
        let d = dir("cleared");
        begin(&d).unwrap();
        cleared(&d);
        assert!(!d.join(MARKER).exists());
        assert_eq!(begin(&d).unwrap(), 0);
        cleared(&d);
        cleared(&d);
    }

    #[test]
    fn the_flag_forces_safe_mode() {
        assert_eq!(decide(0, true, None), Some(Reason::Flag));
        assert_eq!(decide(5, true, Some("1")), Some(Reason::Flag));
        let args = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(has_flag(args(&["fundacad", "--safe-mode"])));
        assert!(!has_flag(args(&["--safe-mode"])));
        assert!(!has_flag(args(&["fundacad", "--engine"])));
    }

    #[test]
    fn the_env_forces_safe_mode() {
        for on in ["1", "true", "yes", "ON", " 1 "] {
            assert_eq!(decide(0, false, Some(on)), Some(Reason::Env), "{on:?}");
        }
        for off in ["0", "", "false", "no"] {
            assert_eq!(decide(0, false, Some(off)), None, "{off:?}");
        }
        assert_eq!(decide(0, false, None), None);
    }

    #[test]
    fn a_garbage_marker_counts_as_none_and_is_kept_aside() {
        let d = dir("garbage");
        std::fs::write(d.join(MARKER), "not a number").unwrap();
        assert_eq!(misses(&d), 0);
        assert!(!d.join(MARKER).exists());
        let kept: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().collect();
        assert_eq!(kept.len(), 1);
        assert!(kept[0].file_name().to_string_lossy().starts_with("launch-pending.bad-"));
    }

    #[test]
    fn a_normal_restart_drops_the_switch() {
        let args = ["fundacad", "--safe-mode", "--other"].map(OsString::from).to_vec();
        assert_eq!(restart_args(args), ["fundacad", "--other"].map(OsString::from).to_vec());
    }

    #[test]
    fn the_page_learns_the_reason_before_its_scripts() {
        let s = init_script(Reason::FailedStarts(3));
        assert!(s.starts_with("window.__FUNDACAD_SAFE_MODE__ = { reason: \"failedStarts\", failedStarts: 3 };"));
        assert!(s.contains("localStorage"));
        assert!(init_script(Reason::Env).contains("reason: \"env\", failedStarts: 0"));
    }
}
