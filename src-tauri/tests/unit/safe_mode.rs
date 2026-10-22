use std::ffi::OsString;
use std::path::PathBuf;

use fundacad_lib::safe_mode::{begin, cleared, decide, has_flag, init_script, misses, restart_args, Reason, MARKER};

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
