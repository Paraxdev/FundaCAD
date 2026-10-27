//! WebKitGTK GPU workarounds, applied before the webview starts (Linux only, the other engines read none of this).
//! `decide` is pure so the decision is testable without the affected hardware.

use std::path::Path;

/// Our own opt out, since `WEBKIT_DISABLE_DMABUF_RENDERER=0` does not work: WebKit's checks are presence based in
/// places, so "0" can read as disable.
pub const OPT_OUT: &str = "FUNDACAD_NO_GPU_WORKAROUND";

/// The name before the rename, still honoured: it lives in shell profiles and .desktop files no rename reaches.
pub const OPT_OUT_LEGACY: &str = "SINDRICAD_NO_GPU_WORKAROUND";

/// Not `WEBKIT_DISABLE_COMPOSITING_MODE`, which turns off accelerated compositing in a WebGL app (and saw pointer
/// capture stick in issue #6). This only disables the DMA-BUF path, so GTK3 paints each frame through the CPU, a
/// smoothness cost. WebKit calls it a transitional escape hatch, so revisit this module when it goes.
pub const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Left in the app data dir by a start whose page ran but never painted, so later starts skip DMA-BUF on that machine.
pub const STALL_MARKER: &str = "webkit-stalled";

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Disable(&'static str),
    Skip(&'static str),
}

pub const WHY_NVIDIA: &str = "Nvidia driver detected (issue #6)";
pub const WHY_STEAM_DECK: &str = "Steam Deck detected, its WebKit compositor spins and never paints";
pub const WHY_STALLED: &str = "an earlier start on this machine never painted";
pub const SKIP_OPT_OUT: &str = "opted out via FUNDACAD_NO_GPU_WORKAROUND";
pub const SKIP_ALREADY_SET: &str = "WEBKIT_DISABLE_DMABUF_RENDERER already set by the environment";
pub const SKIP_NO_MATCH: &str = "no known bad GPU";

#[derive(Debug, Default, Clone, Copy)]
pub struct Machine {
    pub nvidia: bool,
    pub steam_deck: bool,
    pub stalled_before: bool,
}

/// Nvidia, issue #6 (Nobara, RTX 5080, Wayland): `WebKitWebProcess` segfaults in `libnvidia-eglcore` on launch.
/// Steam Deck (SteamOS 3.9, Van Gogh, WebKitGTK 2.50 in GNOME 50 and 51): the ThreadedCompositor thread spins at
/// 100% and grows about 100 MB/s, under X11 and Wayland alike.
pub fn decide(machine: Machine, dmabuf_already_set: bool, opted_out: bool) -> Decision {
    // An explicit human wins over our guess both ways: someone with the variable already set is mid workaround and must
    // not have it changed under them.
    if opted_out {
        return Decision::Skip(SKIP_OPT_OUT);
    }
    if dmabuf_already_set {
        return Decision::Skip(SKIP_ALREADY_SET);
    }
    if machine.nvidia {
        Decision::Disable(WHY_NVIDIA)
    } else if machine.steam_deck {
        Decision::Disable(WHY_STEAM_DECK)
    } else if machine.stalled_before {
        Decision::Disable(WHY_STALLED)
    } else {
        Decision::Skip(SKIP_NO_MATCH)
    }
}

/// `/proc/driver/nvidia/version` marks the loaded Nvidia module, proprietary or open, which both ship the crashing
/// `libnvidia-eglcore`; Nouveau creates neither path.
pub fn nvidia_driver_present_under(root: &Path) -> bool {
    root.join("proc/driver/nvidia/version").exists() || root.join("sys/module/nvidia/version").exists()
}

/// Jupiter is the LCD Deck, Galileo the OLED. Other Valve hardware is left to the stall fallback until seen.
pub fn steam_deck_under(root: &Path) -> bool {
    let read = |f: &str| std::fs::read_to_string(root.join("sys/devices/virtual/dmi/id").join(f)).unwrap_or_default();
    read("board_vendor").trim() == "Valve" && matches!(read("board_name").trim(), "Jupiter" | "Galileo")
}

pub fn machine_under(root: &Path, data_dir: &Path) -> Machine {
    Machine {
        nvidia: nvidia_driver_present_under(root),
        steam_deck: steam_deck_under(root),
        stalled_before: data_dir.join(STALL_MARKER).exists(),
    }
}

pub fn opted_out() -> bool {
    std::env::var_os(OPT_OUT).is_some() || std::env::var_os(OPT_OUT_LEGACY).is_some()
}

/// What the `[gpu]` log line says about a decision. A remembered stall may be a false one (a throttled window), so its
/// line names the file that undoes it.
pub fn notice(decision: &Decision, data_dir: &Path) -> Option<String> {
    match *decision {
        Decision::Disable(why) => {
            let undo = if why == WHY_STALLED {
                format!(", or delete {} to try it again", data_dir.join(STALL_MARKER).display())
            } else {
                String::new()
            };
            Some(format!("[gpu] {why}, disabling the WebKitGTK DMABUF renderer. Set {OPT_OUT}=1 to keep it{undo}."))
        }
        Decision::Skip(SKIP_NO_MATCH) => None,
        Decision::Skip(reason) => Some(format!("[gpu] leaving the WebKitGTK renderer alone: {reason}")),
    }
}

/// Must run before the webview is created: WebKit's web process inherits the environment as it stood when spawned.
pub fn apply_gpu_workarounds(data_dir: &Path) -> Decision {
    let decision = decide(machine_under(Path::new("/"), data_dir), std::env::var_os(DMABUF).is_some(), opted_out());
    if let Decision::Disable(_) = decision {
        std::env::set_var(DMABUF, "1");
    }
    if let Some(line) = notice(&decision, data_dir) {
        println!("{line}");
    }
    decision
}

#[derive(Debug, PartialEq, Eq)]
pub enum StallAction {
    /// Remember the stall for this machine and start again with DMA-BUF off.
    Restart,
    /// DMA-BUF was already off, so it was not the cause and a remembered stall is dropped.
    Forget,
    GiveUp,
}

/// No restart when DMA-BUF already was off, or a machine with another fault would loop.
pub fn on_stall(dmabuf_set: bool, opted_out: bool) -> StallAction {
    if opted_out {
        StallAction::GiveUp
    } else if dmabuf_set {
        StallAction::Forget
    } else {
        StallAction::Restart
    }
}

pub fn record_stall(data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(data_dir.join(STALL_MARKER), "1")
}

pub fn forget_stall(data_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(data_dir.join(STALL_MARKER)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
