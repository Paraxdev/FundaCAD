use super::*;

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
