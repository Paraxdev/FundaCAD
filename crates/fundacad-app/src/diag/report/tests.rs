use super::*;

#[test]
fn user_names_in_paths_are_hidden() {
    assert_eq!(redact_user_paths(r"C:\Users\alice\Documents\a.funda"), r"C:\Users\[REDACTED]\Documents\a.funda");
    assert_eq!(redact_user_paths(r"c:\users\Bob Smith\x"), r"c:\users\[REDACTED]\x");
    assert_eq!(redact_user_paths("/home/carol/parts/b.funda"), "/home/[REDACTED]/parts/b.funda");
    assert_eq!(redact_user_paths("open '/Users/dave' failed"), "open '/Users/[REDACTED]' failed");
    assert_eq!(redact_user_paths(r"/home/ and C:\Users\"), r"/home/ and C:\Users\");
    assert_eq!(redact_user_paths("no paths here"), "no paths here");
}

#[test]
fn a_home_folder_elsewhere_shows_as_a_tilde() {
    assert_eq!(redact_home("/root/parts/a.funda and /root", "/root"), "~/parts/a.funda and ~");
    assert_eq!(redact_home(r"d:\profiles\eve\x.funda", r"D:\Profiles\eve\"), r"~\x.funda");
    assert_eq!(redact_home("/rooted/x", "/root"), "/rooted/x");
    assert_eq!(redact_home("/x", ""), "/x");
}

fn input(log: Option<&str>) -> Input {
    Input {
        version: "2.0.0".into(),
        system: "windows x86_64".into(),
        description: "The fillet failed".into(),
        log: log.map(str::to_string),
        ..Default::default()
    }
}

#[test]
fn a_report_holds_the_description_and_the_whole_log() {
    let r = build(&input(Some("one\ntwo\n")), REPORT_CAP);
    assert!(!r.log_cut);
    assert!(r.text.starts_with(
        "FundaCAD problem report (format 2)\nversion: 2.0.0\nsystem: windows x86_64\n\nThe fillet failed"
    ));
    assert!(r.text.ends_with("app log (the end, user names hidden):\none\ntwo"), "{}", r.text);
}

#[test]
fn a_long_log_is_cut_from_its_start_at_a_line() {
    let log: String = (0..100).map(|i| format!("line {i:03}\n")).collect();
    let r = build(&input(Some(&log)), 200);
    assert!(r.log_cut);
    assert!(r.text.len() <= 200, "{}", r.text.len());
    assert!(r.text.ends_with("line 099"));
    let kept = r.text.split("cut to fit):\n").nth(1).unwrap();
    assert!(kept.starts_with("line "), "{kept}");
}

#[test]
fn a_report_with_no_log_has_no_log_section() {
    let r = build(&input(None), REPORT_CAP);
    assert!(!r.text.contains("app log"));
}

#[test]
fn encoding_matches_encode_uri_component() {
    assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
    assert_eq!(encode("-_.!~*'()"), "-_.!~*'()");
}

#[test]
fn the_title_is_the_first_line_cut_to_70_characters() {
    assert_eq!(issue_title("\n  Fillet fails \nmore"), "Problem: Fillet fails");
    assert_eq!(issue_title(&"é".repeat(90)).chars().count(), "Problem: ".len() + 70);
}

fn fields<'a>(description: &'a str, report: &'a str) -> Fields<'a> {
    Fields { description, version: "2.0.0", system: "windows x86_64", report }
}

#[test]
fn a_short_report_goes_in_the_link() {
    let link = issue_url(&fields("It broke", "the report"));
    assert!(link.report_in);
    assert!(link
        .url
        .starts_with("https://github.com/Paraxdev/fundacad/issues/new?template=bug.yml&title=Problem%3A%20It%20broke"));
    assert!(link.url.ends_with("&what=It%20broke&report=the%20report"));
}

#[test]
fn a_long_report_is_left_for_pasting() {
    let report = "x".repeat(5000);
    let link = issue_url(&fields("It broke", &report));
    assert!(!link.report_in);
    assert!(!link.url.contains("&report="));
    assert!(link.url.ends_with("&what=It%20broke"));
}

#[test]
fn a_long_description_is_cut_to_the_url_cap() {
    let description = "ü".repeat(3000);
    let link = issue_url(&fields(&description, "r"));
    assert!(!link.report_in);
    assert!(link.url.len() <= URL_CAP, "{}", link.url.len());
    assert!(link.url.len() > URL_CAP - 20, "{}", link.url.len());
    assert!(link.url.ends_with(&encode(URL_CUT_MARKER)));
}
