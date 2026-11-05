use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use fundacad_lib::safe_mode::{
    after_question, begin, cannot_ask, cleared, clears_count, crash_arm, crash_disarm, crashes, decide,
    falls_back_to_x11, has_flag, init_script, misses, restart_args, uncount, Answer, PendingChoice, Reason, Start,
    StartChoice, BACKUP_MAX, CRASH_MARKER, MARKER, NOT_SHOWN, START_CHOICE_SCRIPT,
};
use fundacad_lib::settings_files::write_backup;

fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-safe-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn fresh_start_is_normal() {
    let d = dir("fresh");
    assert_eq!(decide(misses(&d), crashes(&d), false, None), Start::Normal);
    assert_eq!(begin(&d).unwrap(), 0);
    assert_eq!(std::fs::read_to_string(d.join(MARKER)).unwrap(), "1");
}

#[test]
fn one_miss_is_still_normal() {
    let d = dir("one");
    begin(&d).unwrap();
    assert_eq!(decide(misses(&d), 0, false, None), Start::Normal);
    assert_eq!(begin(&d).unwrap(), 1);
    assert_eq!(misses(&d), 2);
}

#[test]
fn two_misses_ask_and_never_start_safe_on_their_own() {
    let d = dir("two");
    begin(&d).unwrap();
    begin(&d).unwrap();
    assert_eq!(decide(misses(&d), 0, false, None), Start::Ask(Reason::FailedStarts(2)));
}

#[test]
fn three_crashes_ask_and_unfinished_starts_are_named_first() {
    assert_eq!(decide(0, 2, false, None), Start::Normal);
    assert_eq!(decide(0, 3, false, None), Start::Ask(Reason::Crashes(3)));
    assert_eq!(decide(0, 7, false, None), Start::Ask(Reason::Crashes(7)));
    assert_eq!(decide(2, 3, false, None), Start::Ask(Reason::FailedStarts(2)));
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
    assert_eq!(decide(0, 0, true, None), Start::Safe(Reason::Flag));
    assert_eq!(decide(5, 4, true, Some("1")), Start::Safe(Reason::Flag));
    let args = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
    assert!(has_flag(args(&["fundacad", "--safe-mode"])));
    assert!(!has_flag(args(&["--safe-mode"])));
    assert!(!has_flag(args(&["fundacad", "--engine"])));
}

#[test]
fn the_env_forces_safe_mode() {
    for on in ["1", "true", "yes", "ON", " 1 "] {
        assert_eq!(decide(0, 0, false, Some(on)), Start::Safe(Reason::Env), "{on:?}");
        assert_eq!(decide(3, 3, false, Some(on)), Start::Safe(Reason::Env), "{on:?}");
    }
    for off in ["0", "", "false", "no"] {
        assert_eq!(decide(0, 0, false, Some(off)), Start::Normal, "{off:?}");
    }
    assert_eq!(decide(0, 0, false, None), Start::Normal);
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
    let starts =
        |r: Reason, head: &str| init_script(r).starts_with(&format!("window.__FUNDACAD_SAFE_MODE__ = {head};"));
    assert!(starts(Reason::FailedStarts(3), r#"{ reason: "failedStarts", failedStarts: 3, chosen: true }"#));
    assert!(starts(Reason::Crashes(4), r#"{ reason: "crashes", failedStarts: 0, crashes: 4, chosen: true }"#));
    assert!(starts(Reason::Unanswered(2), r#"{ reason: "failedStarts", failedStarts: 2 }"#));
    assert!(starts(Reason::Env, r#"{ reason: "env", failedStarts: 0 }"#));
    assert!(starts(Reason::Flag, r#"{ reason: "flag", failedStarts: 0 }"#));
    assert!(init_script(Reason::Env).contains("localStorage"));
    assert_eq!(START_CHOICE_SCRIPT, "window.__FUNDACAD_START_CHOICE__ = { reset: true };");
}

/// Word for word `safeModeWhy` in src/ui/safeMode.ts, so the log and the banner say the same.
#[test]
fn the_log_gives_the_reason_as_the_banner_does() {
    assert_eq!(Reason::FailedStarts(2).describe(), "you chose it after the last 2 starts did not finish");
    assert_eq!(
        Reason::Crashes(3).describe(),
        "you chose it after FundaCAD closed unexpectedly 3 times soon after starting"
    );
    assert_eq!(Reason::Unanswered(2).describe(), "the last 2 starts did not finish");
    assert_eq!(Reason::Flag.describe(), "it was started with --safe-mode");
    assert_eq!(Reason::Env.describe(), "FUNDACAD_SAFE_MODE is set");
    assert_eq!(Reason::Crashes(3).key(), "crashes");
    assert_eq!(Reason::FailedStarts(2).question(), "FundaCAD did not start properly the last 2 times.");
    for r in [Reason::FailedStarts(2), Reason::Crashes(5)] {
        assert_eq!(Reason::counted(r.key(), r.count()), Some(r));
    }
    assert_eq!(Reason::counted("flag", 0), None);
    assert_eq!(Reason::Unanswered(2).key(), "failedStarts");
}

#[test]
fn a_crash_marker_counts_one_more_crash_at_the_next_start() {
    let d = dir("crash");
    assert_eq!(crashes(&d), 0);
    // Three runs in a row close within the window after mounting, each arming with the count it started with.
    for want in 1..=3 {
        let now = crashes(&d);
        crash_arm(&d, now).unwrap();
        assert_eq!(crashes(&d), want);
    }
    assert_eq!(decide(0, crashes(&d), false, None), Start::Ask(Reason::Crashes(3)));
}

#[test]
fn a_run_that_outlives_the_window_or_exits_cleanly_resets_the_crash_count() {
    let d = dir("survive");
    crash_arm(&d, 2).unwrap();
    assert_eq!(crashes(&d), 3);
    let now = crashes(&d);
    crash_arm(&d, now).unwrap();
    crash_disarm(&d);
    assert!(!d.join(CRASH_MARKER).exists());
    assert_eq!(crashes(&d), 0);
    crash_disarm(&d);
}

/// A start that never mounts, or a safe session, leaves the marker as it is: the next start finds the same count.
#[test]
fn a_run_that_never_arms_leaves_the_crash_count_as_it_found_it() {
    let d = dir("unarmed");
    crash_arm(&d, 2).unwrap();
    assert_eq!(crashes(&d), 3);
    assert_eq!(crashes(&d), 3);
}

#[test]
fn a_garbage_crash_marker_counts_as_none_and_is_kept_aside() {
    let d = dir("crash-garbage");
    std::fs::write(d.join(CRASH_MARKER), "?").unwrap();
    assert_eq!(crashes(&d), 0);
    assert!(!d.join(CRASH_MARKER).exists());
}

#[test]
fn the_answer_comes_back_as_an_exit_code_and_anything_else_is_no_answer() {
    for a in [Answer::Normal, Answer::Safe, Answer::Reset { plugins: false }, Answer::Reset { plugins: true }] {
        assert_eq!(Answer::from_exit(Some(a.code())), Ok(a));
    }
    assert_eq!(Answer::Normal.code(), 0);
    assert_eq!(Answer::from_exit(Some(NOT_SHOWN)), Err("its window did not show".to_string()));
    assert_eq!(Answer::from_exit(Some(101)), Err("it ended with exit code 101".to_string()));
    for other in [None, Some(1), Some(-1073741819)] {
        assert!(Answer::from_exit(other).is_err(), "{other:?}");
    }
}

#[test]
fn an_answer_is_followed_whatever_the_reason() {
    for r in [Reason::FailedStarts(2), Reason::Crashes(3)] {
        let a = after_question(r, Ok(Answer::Safe));
        assert_eq!((a.safe, a.reset), (Some(r), None));
        let a = after_question(r, Ok(Answer::Normal));
        assert_eq!((a.safe, a.reset), (None, None));
        assert!(a.line.ends_with("Asked how to start: start normally."), "{}", a.line);
        let a = after_question(r, Ok(Answer::Reset { plugins: true }));
        assert_eq!((a.safe, a.reset), (None, Some(StartChoice { reset: true, plugins: true })));
    }
    let a = after_question(Reason::FailedStarts(2), Ok(Answer::Safe));
    assert_eq!(
        a.line,
        "[safe-mode] FundaCAD did not start properly the last 2 times. Asked how to start: start in safe mode."
    );
}

#[test]
fn unfinished_starts_that_cannot_ask_go_into_safe_mode_as_before() {
    for why in ["there is no display", "its window did not show", "it ended with exit code 101"] {
        let a = after_question(Reason::FailedStarts(2), Err(why.to_string()));
        assert_eq!((a.safe, a.reset), (Some(Reason::Unanswered(2)), None));
        assert_eq!(
            a.line,
            format!(
                "[safe-mode] FundaCAD did not start properly the last 2 times. Could not ask how to start, as {why}, \
                 so starting in safe mode."
            )
        );
    }
    assert!(!clears_count(Some(Reason::Unanswered(2))));
}

#[test]
fn a_crash_loop_that_cannot_ask_starts_normally() {
    let a = after_question(Reason::Crashes(3), Err("its window did not show".to_string()));
    assert_eq!((a.safe, a.reset), (None, None));
    assert!(
        a.line.ends_with("Could not ask how to start, as its window did not show, so starting normally."),
        "{}",
        a.line
    );
}

#[test]
fn the_question_page_form_reads_as_an_answer() {
    assert_eq!(Answer::from_form([("c", "safe")]), Some(Answer::Safe));
    assert_eq!(Answer::from_form([("c", "safe"), ("plugins", "1")]), Some(Answer::Safe));
    assert_eq!(Answer::from_form([("c", "reset")]), Some(Answer::Reset { plugins: false }));
    assert_eq!(Answer::from_form([("plugins", "1"), ("c", "reset")]), Some(Answer::Reset { plugins: true }));
    assert_eq!(Answer::from_form([("c", "normal")]), Some(Answer::Normal));
    assert_eq!(Answer::from_form([("c", "other")]), None);
    assert_eq!(Answer::from_form([("plugins", "1")]), None);
}

#[test]
fn a_linux_session_with_no_display_is_never_asked() {
    let os = |v: &'static str| Some(OsStr::new(v));
    assert!(cannot_ask(true, None, None).is_some());
    assert!(cannot_ask(true, os(""), os("")).is_some());
    assert!(cannot_ask(true, os("wayland-0"), None).is_none());
    assert!(cannot_ask(true, None, os(":0")).is_none());
    assert!(cannot_ask(false, None, None).is_none());
}

#[test]
fn the_reset_choice_is_handed_out_once() {
    let choice = StartChoice { reset: true, plugins: true };
    let pending = PendingChoice::new(Some(choice));
    assert_eq!(pending.take(), Some(choice));
    assert_eq!(pending.take(), None);
    assert_eq!(serde_json::to_string(&choice).unwrap(), r#"{"reset":true,"plugins":true}"#);
    assert_eq!(PendingChoice::new(None).take(), None);
}

#[test]
fn a_settings_backup_needs_a_taken_reset_and_is_written_once() {
    let pending = PendingChoice::new(Some(StartChoice { reset: true, plugins: false }));
    assert!(pending.claim_backup(10).is_err(), "before the page took the reset");
    pending.take();
    assert!(pending.claim_backup(BACKUP_MAX + 1).is_err(), "over the cap");
    assert!(pending.claim_backup(10).is_ok());
    assert!(pending.claim_backup(10).is_err(), "a second backup");
    pending.release_backup();
    assert!(pending.claim_backup(10).is_ok(), "again after a failed write");

    let never = PendingChoice::new(None);
    never.take();
    assert!(never.claim_backup(10).is_err());
}

#[test]
fn settings_backups_get_their_own_names_and_the_newest_ten_are_kept() {
    let d = dir("backups").join("settings-backups");
    let a = write_backup(&d, 100, r#"{"a":1}"#, 10).unwrap();
    let b = write_backup(&d, 100, r#"{"b":2}"#, 10).unwrap();
    assert_eq!(a.file_name().unwrap(), "settings-100.json");
    assert_eq!(b.file_name().unwrap(), "settings-100-1.json");
    assert!(a.is_absolute());
    assert_eq!(std::fs::read_to_string(&a).unwrap(), r#"{"a":1}"#);
    std::fs::write(d.join("notes.txt"), "kept").unwrap();
    for secs in 101..=111 {
        write_backup(&d, secs, "{}", 10).unwrap();
    }
    let mut left: Vec<String> =
        std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    left.sort();
    let mut want: Vec<String> = (102..=111).map(|s| format!("settings-{s}.json")).collect();
    want.push("notes.txt".into());
    want.sort();
    assert_eq!(left, want);
}

/// Both the mount and a stall restart go through this, so a safe session comes back safe either way.
#[test]
fn only_a_normal_session_clears_the_count() {
    assert!(clears_count(None));
    for r in [Reason::FailedStarts(2), Reason::Crashes(3), Reason::Flag, Reason::Env] {
        assert!(!clears_count(Some(r)), "{r:?}");
    }
}

#[test]
fn a_stall_restart_takes_back_only_its_own_start() {
    let d = dir("stall");
    let prev = begin(&d).unwrap();
    uncount(&d, prev);
    assert_eq!(misses(&d), 0);
    assert!(!d.join(MARKER).exists());

    // A start that stalled under both renderers stays counted, the next one's restart keeps it.
    begin(&d).unwrap();
    let prev = begin(&d).unwrap();
    uncount(&d, prev);
    assert_eq!(misses(&d), 1);
    begin(&d).unwrap();
    assert_eq!(decide(misses(&d), 0, false, None), Start::Ask(Reason::FailedStarts(2)));
}

/// The AppImage and the Flatpak no longer force X11, so a Wayland stack that cannot show the window gets XWayland back
/// in safe mode. A Flatpak on Wayland has no DISPLAY (fallback-x11), and a GDK_BACKEND someone set is theirs.
#[test]
fn safe_mode_on_wayland_falls_back_to_x11_when_there_is_one() {
    let os = |v: &'static str| Some(OsStr::new(v));
    let cases = [
        (true, None, os("wayland-0"), os(":0")),
        (false, None, os("wayland-0"), os(":0")),
        (true, os("wayland"), os("wayland-0"), os(":0")),
        (true, None, None, os(":0")),
        (true, None, os("wayland-0"), None),
        (true, None, os("wayland-0"), os("")),
        (true, None, os(""), os(":0")),
    ];
    let got: Vec<bool> = cases.iter().map(|&(safe, gdk, wl, x)| falls_back_to_x11(safe, gdk, wl, x)).collect();
    assert_eq!(got, [true, false, false, false, false, false, false]);
}
