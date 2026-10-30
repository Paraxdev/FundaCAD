//! Reduced rights for the engine: it may write only to its own folders, and on Linux it cannot open new sockets.
//! A memory bug in the geometry kernel then cannot act as the user. Entered at start, before any request is read.

use std::path::PathBuf;

/// `0`, `off`, `false` or `no` turns the sandbox off for debugging; `1`, `on`, `true` or `yes` turns it on for a tool.
pub const ENV: &str = "FUNDACAD_ENGINE_SANDBOX";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// The app's own worker: on unless turned off.
    Worker,
    /// The command line engine (`--stdio`, `golden-check`): off unless turned on.
    Tool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Enter,
    NotAsked,
    TurnedOff,
}

pub fn decide(env: Option<&str>, policy: Policy) -> Decision {
    let value = env.map(|v| v.trim().to_ascii_lowercase()).unwrap_or_default();
    match value.as_str() {
        "0" | "off" | "false" | "no" => Decision::TurnedOff,
        "1" | "on" | "true" | "yes" => Decision::Enter,
        _ => match policy {
            Policy::Worker => Decision::Enter,
            Policy::Tool => Decision::NotAsked,
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Every restriction this system offers is in force. `writes` is false on a kernel that cannot limit writes,
    /// which is not worth a line.
    On {
        writes: bool,
    },
    NotAsked,
    TurnedOff,
    /// Setting up failed, so the engine runs with the user's full rights.
    Failed(String),
}

impl Outcome {
    pub fn is_on(&self) -> bool {
        matches!(self, Outcome::On { .. })
    }

    /// At most one line for stderr, only when the engine runs without the restriction it should have.
    pub fn line(&self) -> Option<String> {
        match self {
            Outcome::On { .. } | Outcome::NotAsked => None,
            Outcome::TurnedOff => Some(format!("engine: runs without reduced rights, since {ENV} turns them off")),
            Outcome::Failed(why) => {
                let why = why.split_whitespace().collect::<Vec<_>>().join(" ");
                Some(format!("engine: runs without reduced rights, {why}"))
            }
        }
    }

    pub fn report(&self) {
        if let Some(line) = self.line() {
            eprintln!("{line}");
        }
    }
}

/// Enters the sandbox when [`ENV`] and the policy ask for it, and logs the one line when it runs without.
/// Call it before any thread starts: on Linux the write rules bind only the calling thread and the ones it starts later.
pub fn enter(policy: Policy, writable: &[PathBuf]) -> Outcome {
    let outcome = enter_with(std::env::var(ENV).ok().as_deref(), policy, writable);
    outcome.report();
    outcome
}

pub fn enter_with(env: Option<&str>, policy: Policy, writable: &[PathBuf]) -> Outcome {
    match decide(env, policy) {
        Decision::Enter => platform_enter(&prepare(writable)),
        Decision::NotAsked => Outcome::NotAsked,
        Decision::TurnedOff => Outcome::TurnedOff,
    }
}

/// Creates the writable folders and keeps those that exist: a rule cannot name a missing folder, which would then stay
/// read only.
pub fn prepare(writable: &[PathBuf]) -> Vec<PathBuf> {
    writable.iter().filter(|dir| std::fs::create_dir_all(dir).is_ok()).cloned().collect()
}

/// Refuses new sockets in every thread from here on. Call it once the live door listens: accepting on it needs none.
pub fn close_network(entered: &Outcome) {
    if let Some(line) = close_network_with(entered, platform_close_network) {
        eprintln!("{line}");
    }
}

/// Closes the network only after [`enter`] put the engine into its reduced rights, and gives the one line on failure.
pub fn close_network_with(entered: &Outcome, close: impl FnOnce() -> Result<(), String>) -> Option<String> {
    if !entered.is_on() {
        return None;
    }
    let why = close().err()?;
    let why = why.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!("engine: runs with the network open, {why}"))
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::{close_network as platform_close_network, enter as platform_enter};

#[cfg(not(target_os = "linux"))]
fn platform_enter(_writable: &[PathBuf]) -> Outcome {
    Outcome::Failed("reduced rights are not available on this platform yet".into())
}

#[cfg(not(target_os = "linux"))]
fn platform_close_network() -> Result<(), String> {
    Ok(())
}
