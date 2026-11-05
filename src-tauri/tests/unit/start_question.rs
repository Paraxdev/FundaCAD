use fundacad_lib::safe_mode::{Answer, NOT_SHOWN};
use fundacad_lib::start_question::{exit_code, navigation, Nav};

#[test]
fn a_window_that_never_showed_is_no_answer() {
    assert_eq!(exit_code(None, false), NOT_SHOWN);
    assert_eq!(Answer::from_exit(Some(exit_code(None, false))), Err("its window did not show".to_string()));
}

#[test]
fn a_window_closed_after_it_showed_is_start_normally() {
    assert_eq!(Answer::from_exit(Some(exit_code(None, true))), Ok(Answer::Normal));
}

#[test]
fn a_choice_is_its_own_code() {
    for a in [Answer::Normal, Answer::Safe, Answer::Reset { plugins: false }, Answer::Reset { plugins: true }] {
        assert_eq!(Answer::from_exit(Some(exit_code(Some(a), true))), Ok(a));
    }
}

fn nav(url: &str, windows: bool) -> Nav {
    navigation(&url.parse().unwrap(), windows)
}

#[test]
fn only_the_page_itself_loads() {
    assert_eq!(nav("fundacad-ask://localhost/", false), Nav::Page);
    assert_eq!(nav("http://fundacad-ask.localhost/", true), Nav::Page);
    for (url, windows) in [
        ("http://fundacad-ask.localhost/", false),
        ("fundacad-ask://localhost/", true),
        ("https://fundacad-ask.localhost/", true),
        ("http://fundacad-ask.localhost:8080/", true),
        ("http://user@fundacad-ask.localhost/", true),
        ("http://evil.localhost/", true),
        ("http://fundacad-ask.localhost.evil.com/", true),
        ("fundacad-ask://evil/", false),
        ("https://example.com/", false),
        ("https://example.com/choice?c=safe", false),
        ("about:blank", false),
        ("data:text/html,hi", false),
        ("file:///etc/passwd", false),
        ("fundacad-ask://localhost/other", false),
        ("fundacad-ask://localhost/?x=1", false),
        ("tauri://localhost/", false),
    ] {
        assert_eq!(nav(url, windows), Nav::Deny, "{url} on windows {windows}");
    }
}

#[test]
fn the_page_reports_it_shows_and_its_choice() {
    assert_eq!(nav("fundacad-ask://localhost/shown", false), Nav::Shown);
    assert_eq!(nav("http://fundacad-ask.localhost/shown", true), Nav::Shown);
    assert_eq!(nav("fundacad-ask://localhost/choice?c=safe", false), Nav::Choice(Answer::Safe));
    assert_eq!(
        nav("http://fundacad-ask.localhost/choice?c=reset&plugins=1", true),
        Nav::Choice(Answer::Reset { plugins: true })
    );
    assert_eq!(nav("fundacad-ask://localhost/choice?c=other", false), Nav::Choice(Answer::Normal));
}
