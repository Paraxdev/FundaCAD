use std::path::{Path, PathBuf};

use fundacad_lib::webkit::{
    apply_gpu_workarounds, decide, machine_under, nvidia_driver_present_under, record_stall, stall_fallback_applies,
    steam_deck_under, Decision, Machine, DMABUF, OPT_OUT, OPT_OUT_LEGACY, SKIP_ALREADY_SET, SKIP_NO_MATCH,
    SKIP_OPT_OUT, STALL_MARKER, WHY_NVIDIA, WHY_STALLED, WHY_STEAM_DECK,
};

fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-webkit-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn dmi(root: &Path, vendor: &str, board: &str) {
    let id = root.join("sys/devices/virtual/dmi/id");
    std::fs::create_dir_all(&id).unwrap();
    std::fs::write(id.join("board_vendor"), format!("{vendor}\n")).unwrap();
    std::fs::write(id.join("board_name"), format!("{board}\n")).unwrap();
}

const NVIDIA: Machine = Machine { nvidia: true, steam_deck: false, stalled_before: false };
const DECK: Machine = Machine { nvidia: false, steam_deck: true, stalled_before: false };
const STALLED: Machine = Machine { nvidia: false, steam_deck: false, stalled_before: true };

#[test]
fn each_known_bad_machine_disables_the_dmabuf_renderer() {
    assert_eq!(decide(NVIDIA, false, false), Decision::Disable(WHY_NVIDIA));
    assert_eq!(decide(DECK, false, false), Decision::Disable(WHY_STEAM_DECK));
    assert_eq!(decide(STALLED, false, false), Decision::Disable(WHY_STALLED));
}

/// A blanket disable would cost every Linux user the per frame copy for a fault on a few GPUs.
#[test]
fn other_machines_are_untouched() {
    assert_eq!(decide(Machine::default(), false, false), Decision::Skip(SKIP_NO_MATCH));
}

#[test]
fn an_existing_setting_is_never_overridden() {
    assert_eq!(decide(NVIDIA, true, false), Decision::Skip(SKIP_ALREADY_SET));
    assert_eq!(decide(DECK, true, false), Decision::Skip(SKIP_ALREADY_SET));
    assert_eq!(decide(Machine::default(), true, false), Decision::Skip(SKIP_ALREADY_SET));
}

#[test]
fn the_opt_out_is_preferred_over_detection_and_an_existing_setting() {
    for m in [NVIDIA, DECK, STALLED] {
        assert_eq!(decide(m, false, true), Decision::Skip(SKIP_OPT_OUT));
        assert_eq!(decide(m, true, true), Decision::Skip(SKIP_OPT_OUT));
    }
}

/// A bare `/sys/module/nvidia` directory (nvidia_drm can appear on hybrid systems) is not enough, the probe looks for
/// the version files the real driver writes.
#[test]
fn the_nvidia_probe_matches_the_paths_the_driver_writes() {
    let root = dir("nvidia");
    std::fs::create_dir_all(root.join("sys/module/nvidia")).unwrap();
    assert!(!nvidia_driver_present_under(&root));
    std::fs::create_dir_all(root.join("proc/driver/nvidia")).unwrap();
    std::fs::write(root.join("proc/driver/nvidia/version"), "NVRM version").unwrap();
    assert!(nvidia_driver_present_under(&root));
}

/// Values as read on a Steam Deck OLED (SteamOS 3.9.5), with the trailing newline sysfs gives.
#[test]
fn the_deck_probe_knows_both_decks_and_nothing_else() {
    for (vendor, board, deck) in [
        ("Valve", "Galileo", true),
        ("Valve", "Jupiter", true),
        ("Valve", "Fremont", false),
        ("LENOVO", "Galileo", false),
    ] {
        let root = dir(&format!("deck-{vendor}-{board}"));
        dmi(&root, vendor, board);
        assert_eq!(steam_deck_under(&root), deck, "{vendor} {board}");
    }
    assert!(!steam_deck_under(&dir("deck-none")), "a machine without DMI is not a Deck");
}

#[test]
fn a_recorded_stall_is_read_back_on_the_next_start() {
    let root = dir("stall-root");
    let data = dir("stall-data");
    assert!(!machine_under(&root, &data).stalled_before);
    record_stall(&data).unwrap();
    assert!(data.join(STALL_MARKER).exists());
    assert!(machine_under(&root, &data).stalled_before);
}

/// A start that stalls with DMA-BUF already off must not restart again, or a machine with another fault loops forever.
#[test]
fn a_stall_only_restarts_when_that_would_change_the_renderer() {
    assert!(stall_fallback_applies(false, false));
    assert!(!stall_fallback_applies(true, false));
    assert!(!stall_fallback_applies(false, true));
}

/// Through the real entry point: either opt out spelling leaves the environment untouched on any machine. One test,
/// as these are process wide variables a parallel test would race, and it restores what it found.
#[test]
fn the_applier_reads_the_variables_it_documents() {
    let restore = std::env::var_os(DMABUF);
    let data = dir("applier");
    record_stall(&data).unwrap();
    for name in [OPT_OUT, OPT_OUT_LEGACY] {
        std::env::remove_var(DMABUF);
        std::env::set_var(name, "1");
        assert_eq!(apply_gpu_workarounds(&data), Decision::Skip(SKIP_OPT_OUT));
        assert!(std::env::var_os(DMABUF).is_none(), "{name} must stop the applier setting {DMABUF}");
        std::env::remove_var(name);
    }
    std::env::remove_var(DMABUF);
    assert_eq!(apply_gpu_workarounds(&data), Decision::Disable(WHY_STALLED));
    assert_eq!(std::env::var_os(DMABUF).as_deref(), Some(std::ffi::OsStr::new("1")));
    match restore {
        Some(v) => std::env::set_var(DMABUF, v),
        None => std::env::remove_var(DMABUF),
    }
}
