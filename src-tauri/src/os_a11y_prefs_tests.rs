use super::*;
use std::process::Command;
use std::time::{Duration, Instant};

fn never() -> Option<String> {
    panic!("an earlier source already answered")
}

#[test]
fn windows_reads_the_high_contrast_on_bit_alone() {
    assert!(high_contrast_flag(HCF_HIGHCONTRASTON));
    assert!(high_contrast_flag(0x1 | 0x4 | 0x1000));
    assert!(!high_contrast_flag(0x2 | 0x4));
    assert!(!high_contrast_flag(0));
}

#[test]
fn the_portal_answer_reads_from_read_one_and_the_older_read() {
    assert_eq!(parse_portal_contrast("(<uint32 1>,)\n"), Some(true));
    assert_eq!(parse_portal_contrast("(<<uint32 1>>,)\n"), Some(true));
    assert_eq!(parse_portal_contrast("(<uint32 0>,)\n"), Some(false));
    assert_eq!(parse_portal_contrast("(<uint32 7>,)"), None);
    assert_eq!(parse_portal_contrast("(<'prefer-dark'>,)"), None);
    assert_eq!(parse_portal_contrast(""), None);
}

#[test]
fn gsettings_and_defaults_answer_only_a_plain_boolean() {
    assert_eq!(parse_gsettings_bool("true\n"), Some(true));
    assert_eq!(parse_gsettings_bool("false\n"), Some(false));
    assert_eq!(parse_gsettings_bool("No such key\n"), None);
    assert_eq!(parse_defaults_bool("1\n"), Some(true));
    assert_eq!(parse_defaults_bool("0\n"), Some(false));
    assert_eq!(parse_defaults_bool(""), None);
}

#[test]
fn a_high_contrast_gtk_theme_says_yes_and_any_other_says_nothing() {
    assert_eq!(gtk_theme_high_contrast(Some("HighContrast")), Some(true));
    assert_eq!(gtk_theme_high_contrast(Some("HighContrastInverse")), Some(true));
    assert_eq!(gtk_theme_high_contrast(Some("Adwaita:dark")), None);
    assert_eq!(gtk_theme_high_contrast(None), None);
}

#[test]
fn on_linux_the_first_source_that_answers_decides() {
    assert_eq!(linux_high_contrast(Some("HighContrast"), never, never), Some(true));
    assert_eq!(linux_high_contrast(None, || Some("(<uint32 0>,)".into()), never), Some(false));
    assert_eq!(linux_high_contrast(Some("Adwaita"), || None, || Some("true\n".into())), Some(true));
    assert_eq!(linux_high_contrast(None, || Some("(<uint32 9>,)".into()), || Some("false".into())), Some(false));
    assert_eq!(linux_high_contrast(None, || None, || None), None);
}

#[test]
fn the_answer_reaches_the_webview_in_camel_case() {
    let json = |v| serde_json::to_string(&OsA11yPrefs { high_contrast: v }).unwrap();
    assert_eq!(json(Some(true)), r#"{"highContrast":true}"#);
    assert_eq!(json(None), r#"{"highContrast":null}"#);
}

#[test]
fn reading_the_os_never_panics() {
    let _ = read();
}

fn hangs() -> Command {
    let mut cmd = Command::new(if cfg!(windows) { "ping" } else { "sleep" });
    if cfg!(windows) {
        cmd.args(["-n", "6", "127.0.0.1"]);
    } else {
        cmd.arg("5");
    }
    cmd
}

fn shell(script: &str) -> Command {
    let (sh, flag) = if cfg!(windows) { ("cmd", "/C") } else { ("sh", "-c") };
    let mut cmd = Command::new(sh);
    cmd.args([flag, script]);
    cmd
}

#[test]
fn a_tool_that_hangs_is_given_up_on_at_the_limit() {
    let started = Instant::now();
    assert_eq!(run_within(hangs(), Duration::from_millis(300)), None);
    assert!(started.elapsed() < Duration::from_secs(3), "waited {:?}", started.elapsed());
}

#[test]
fn a_tool_that_answers_in_time_gives_its_whole_output() {
    let newline = if cfg!(windows) { "\r\n" } else { "\n" };
    assert_eq!(run_within(shell("echo true"), Duration::from_secs(10)), Some(format!("true{newline}")));
}

#[test]
fn a_tool_that_fails_or_is_missing_gives_nothing() {
    assert_eq!(run_within(shell("exit 1"), Duration::from_secs(10)), None);
    assert_eq!(run_within(Command::new("fundacad-no-such-tool"), Duration::from_secs(10)), None);
}
