//! After `THRESHOLD` starts in a row that never mount the interface, or `CRASH_THRESHOLD` runs in a row that closed
//! soon after mounting, the next start asks whether to come up with defaults (issues #3 and #6). The count file is
//! written after the single instance check and removed on mount, so a leftover is an unfinished start.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub const MARKER: &str = "launch-pending";
pub const THRESHOLD: u32 = 2;
/// Written on mount with the crash count so far, removed once the run outlives `CRASH_WINDOW` or exits cleanly.
pub const CRASH_MARKER: &str = "early-exit";
pub const CRASH_THRESHOLD: u32 = 3;
pub const CRASH_WINDOW: std::time::Duration = std::time::Duration::from_secs(120);
pub const FLAG: &str = "--safe-mode";
pub const ENV: &str = "FUNDACAD_SAFE_MODE";
pub const COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
pub const GDK_BACKEND: &str = "GDK_BACKEND";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Only ever chosen from the start question, as is `Crashes`.
    FailedStarts(u32),
    Crashes(u32),
    /// Unfinished starts whose question was not answered: safe mode on its own, as before the question.
    Unanswered(u32),
    Flag,
    Env,
}

impl Reason {
    pub fn key(self) -> &'static str {
        match self {
            Reason::FailedStarts(_) | Reason::Unanswered(_) => "failedStarts",
            Reason::Crashes(_) => "crashes",
            Reason::Flag => "flag",
            Reason::Env => "env",
        }
    }

    /// The counted reasons by `key`, as the start question process is handed them.
    pub fn counted(key: &str, n: u32) -> Option<Reason> {
        match key {
            "failedStarts" => Some(Reason::FailedStarts(n)),
            "crashes" => Some(Reason::Crashes(n)),
            _ => None,
        }
    }

    pub fn count(self) -> u32 {
        match self {
            Reason::FailedStarts(n) | Reason::Crashes(n) | Reason::Unanswered(n) => n,
            Reason::Flag | Reason::Env => 0,
        }
    }

    /// Kept in step with `safeModeWhy` in src/ui/safeMode.ts.
    pub fn describe(self) -> String {
        match self {
            Reason::FailedStarts(n) => format!("you chose it after the last {n} starts did not finish"),
            Reason::Crashes(n) => {
                format!("you chose it after FundaCAD closed unexpectedly {n} times soon after starting")
            }
            Reason::Unanswered(n) => format!("the last {n} starts did not finish"),
            Reason::Flag => format!("it was started with {FLAG}"),
            Reason::Env => format!("{ENV} is set"),
        }
    }

    /// The start question's heading.
    pub fn question(self) -> String {
        match self {
            Reason::Crashes(n) => format!("FundaCAD closed unexpectedly the last {n} times, soon after it started."),
            _ => format!("FundaCAD did not start properly the last {} times.", self.count()),
        }
    }
}

pub fn env_on(value: Option<&str>) -> bool {
    matches!(value.map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("1" | "true" | "yes" | "on"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    Normal,
    Safe(Reason),
    /// Ask first, with the reason safe mode gets if the person picks it.
    Ask(Reason),
}

/// An explicit request is preferred over the counts, so the banner names what the person can actually undo. A count
/// only ever asks.
pub fn decide(prev_misses: u32, crashes: u32, flag: bool, env: Option<&str>) -> Start {
    if flag {
        Start::Safe(Reason::Flag)
    } else if env_on(env) {
        Start::Safe(Reason::Env)
    } else if prev_misses >= THRESHOLD {
        Start::Ask(Reason::FailedStarts(prev_misses))
    } else if crashes >= CRASH_THRESHOLD {
        Start::Ask(Reason::Crashes(crashes))
    } else {
        Start::Normal
    }
}

/// What the start question answered. It comes back as the exit code of the question process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Normal,
    Safe,
    Reset { plugins: bool },
}

impl Answer {
    pub fn code(self) -> i32 {
        match self {
            Answer::Normal => 0,
            Answer::Safe => 20,
            Answer::Reset { plugins: false } => 21,
            Answer::Reset { plugins: true } => 22,
        }
    }

    /// 0 is a button or a closed window. Any other code is no answer, and says why.
    pub fn from_exit(code: Option<i32>) -> Result<Answer, String> {
        match code {
            Some(0) => Ok(Answer::Normal),
            Some(20) => Ok(Answer::Safe),
            Some(21) => Ok(Answer::Reset { plugins: false }),
            Some(22) => Ok(Answer::Reset { plugins: true }),
            Some(NOT_SHOWN) => Err("its window did not show".into()),
            Some(c) => Err(format!("it ended with exit code {c}")),
            None => Err("it was stopped by a signal".into()),
        }
    }

    /// The question page's form fields: `c` names the button, `plugins` is the box.
    pub fn from_form<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Option<Answer> {
        let (mut choice, mut plugins) = (None, false);
        for (key, value) in pairs {
            match key {
                "c" => choice = Some(value),
                "plugins" => plugins = value == "1",
                _ => {}
            }
        }
        match choice? {
            "safe" => Some(Answer::Safe),
            "reset" => Some(Answer::Reset { plugins }),
            "normal" => Some(Answer::Normal),
            _ => None,
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            Answer::Normal => "start normally",
            Answer::Safe => "start in safe mode",
            Answer::Reset { plugins: false } => "reset settings",
            Answer::Reset { plugins: true } => "reset settings and turn off plugins",
        }
    }
}

/// The exit code of a question process whose window did not open or show.
pub const NOT_SHOWN: i32 = 23;

/// How an asked start goes on, and its log line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asked {
    pub safe: Option<Reason>,
    pub reset: Option<StartChoice>,
    pub line: String,
}

/// `asked` is the answer or why there is none. Unanswered, unfinished starts go into safe mode as they did before the
/// question, so a machine whose webview cannot come up never loops. A crash loop never had that, so it starts normally.
pub fn after_question(reason: Reason, asked: Result<Answer, String>) -> Asked {
    let q = reason.question();
    match asked {
        Ok(answer) => Asked {
            safe: (answer == Answer::Safe).then_some(reason),
            reset: match answer {
                Answer::Reset { plugins } => Some(StartChoice { reset: true, plugins }),
                _ => None,
            },
            line: format!("[safe-mode] {q} Asked how to start: {}.", answer.describe()),
        },
        Err(why) => {
            let safe = match reason {
                Reason::FailedStarts(n) => Some(Reason::Unanswered(n)),
                _ => None,
            };
            let then = if safe.is_some() { "starting in safe mode" } else { "starting normally" };
            Asked {
                safe,
                reset: None,
                line: format!("[safe-mode] {q} Could not ask how to start, as {why}, so {then}."),
            }
        }
    }
}

/// Why the question cannot be shown, if it cannot: a Linux session with no display to open it on.
pub fn cannot_ask(linux: bool, wayland_display: Option<&OsStr>, display: Option<&OsStr>) -> Option<&'static str> {
    let set = |v: Option<&OsStr>| v.is_some_and(|v| !v.is_empty());
    (linux && !set(wayland_display) && !set(display)).then_some("there is no display")
}

/// A safe session on Wayland opens through XWayland where there is one. A Flatpak on Wayland gets no DISPLAY.
pub fn falls_back_to_x11(
    safe: bool,
    gdk_backend: Option<&OsStr>,
    wayland_display: Option<&OsStr>,
    display: Option<&OsStr>,
) -> bool {
    let set = |v: Option<&OsStr>| v.is_some_and(|v| !v.is_empty());
    safe && gdk_backend.is_none() && set(wayland_display) && set(display)
}

pub fn has_flag<I: IntoIterator<Item = OsString>>(args: I) -> bool {
    args.into_iter().skip(1).any(|a| a == FLAG)
}

/// A count file that does not hold a number is moved aside and reads as `None`.
fn read_count(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    match text.trim().parse::<u32>() {
        Ok(n) => Some(n),
        Err(_) => {
            let _ = crate::settings_files::back_up(path);
            None
        }
    }
}

/// How many starts in a row did not finish.
pub fn misses(dir: &Path) -> u32 {
    read_count(&dir.join(MARKER)).unwrap_or(0)
}

/// Count this start as pending and return how many were pending before it.
pub fn begin(dir: &Path) -> std::io::Result<u32> {
    let prev = misses(dir);
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(MARKER), prev.saturating_add(1).to_string())?;
    Ok(prev)
}

/// How many runs in a row closed within `CRASH_WINDOW` of mounting: the count the last one left, plus that one. A
/// start that never mounts leaves the marker as it found it, so it neither adds nor breaks the row.
pub fn crashes(dir: &Path) -> u32 {
    read_count(&dir.join(CRASH_MARKER)).map_or(0, |n| n.saturating_add(1))
}

/// On mount: if this run ends before `crash_disarm`, the next start counts one more crash than `count`.
pub fn crash_arm(dir: &Path, count: u32) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(CRASH_MARKER), count.to_string())
}

pub fn crash_disarm(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(CRASH_MARKER));
}

/// A safe session keeps both counts, so closing it and starting again asks again instead of failing twice more.
pub fn clears_count(reason: Option<Reason>) -> bool {
    reason.is_none()
}

pub fn cleared(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MARKER));
}

/// Takes back one start's count: `prev` is what its `begin` returned, so earlier unfinished starts still count.
pub fn uncount(dir: &Path, prev: u32) {
    if prev == 0 {
        cleared(dir);
    } else {
        let _ = std::fs::write(dir.join(MARKER), prev.to_string());
    }
}

/// The arguments a normal restart is given: these, without the switch.
pub fn restart_args(args: Vec<OsString>) -> Vec<OsString> {
    args.into_iter().filter(|a| a != FLAG).collect()
}

/// Runs before any page script: tells the page why it is in safe mode, and
/// gives it an in memory `localStorage`, so it reads default preferences and
/// nothing it writes reaches the saved ones.
pub fn init_script(reason: Reason) -> String {
    let info = match reason {
        Reason::FailedStarts(n) => format!("failedStarts: {n}, chosen: true"),
        Reason::Unanswered(n) => format!("failedStarts: {n}"),
        Reason::Crashes(n) => format!("failedStarts: 0, crashes: {n}, chosen: true"),
        Reason::Flag | Reason::Env => "failedStarts: 0".to_string(),
    };
    format!(
        "window.__FUNDACAD_SAFE_MODE__ = {{ reason: \"{}\", {info} }};\n{}",
        reason.key(),
        include_str!("safe_mode_storage.js")
    )
}

/// The hint of a Reset settings start for src/app/startChoice.ts, never together with `init_script`.
pub const START_CHOICE_SCRIPT: &str = "window.__FUNDACAD_START_CHOICE__ = { reset: true };";

/// What `start_choice_take` hands the page, JSON `{ "reset": true, "plugins": false }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct StartChoice {
    pub reset: bool,
    pub plugins: bool,
}

pub const BACKUP_MAX: usize = 32 << 20;

/// The Reset settings choice, handed out once, and the one settings backup it allows.
#[derive(Default)]
pub struct PendingChoice {
    choice: Mutex<Option<StartChoice>>,
    reset_taken: AtomicBool,
    backup_claimed: AtomicBool,
}

impl PendingChoice {
    pub fn new(choice: Option<StartChoice>) -> PendingChoice {
        PendingChoice { choice: Mutex::new(choice), ..Default::default() }
    }

    pub fn take(&self) -> Option<StartChoice> {
        let taken = self.choice.lock().unwrap_or_else(|p| p.into_inner()).take();
        if taken.is_some_and(|c| c.reset) {
            self.reset_taken.store(true, Ordering::SeqCst);
        }
        taken
    }

    /// One backup per process, and only once the reset was taken. A failed write gives the claim back with
    /// `release_backup`.
    pub fn claim_backup(&self, len: usize) -> Result<(), String> {
        if !self.reset_taken.load(Ordering::SeqCst) {
            return Err("no settings reset was chosen for this start".into());
        }
        if len > BACKUP_MAX {
            return Err(format!("the settings are {len} bytes, more than a backup takes ({BACKUP_MAX})"));
        }
        if self.backup_claimed.swap(true, Ordering::SeqCst) {
            return Err("the settings were already backed up for this start".into());
        }
        Ok(())
    }

    pub fn release_backup(&self) {
        self.backup_claimed.store(false, Ordering::SeqCst);
    }
}
