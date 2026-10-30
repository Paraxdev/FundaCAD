use fundacad_engine::sandbox::*;

#[test]
fn the_apps_worker_enters_by_default_and_a_tool_does_not() {
    assert_eq!(decide(None, Policy::Worker), Decision::Enter);
    assert_eq!(decide(Some(""), Policy::Worker), Decision::Enter);
    assert_eq!(decide(None, Policy::Tool), Decision::NotAsked);
    assert_eq!(decide(Some(""), Policy::Tool), Decision::NotAsked);
}

#[test]
fn the_variable_turns_it_off_for_either_policy() {
    for value in ["0", "off", "false", "no", " OFF ", "False"] {
        for policy in [Policy::Worker, Policy::Tool] {
            assert_eq!(decide(Some(value), policy), Decision::TurnedOff, "{value:?} {policy:?}");
        }
    }
}

#[test]
fn the_variable_turns_it_on_for_a_tool() {
    for value in ["1", "on", "true", "yes", " On "] {
        assert_eq!(decide(Some(value), Policy::Tool), Decision::Enter, "{value:?}");
        assert_eq!(decide(Some(value), Policy::Worker), Decision::Enter, "{value:?}");
    }
}

#[test]
fn an_unknown_value_keeps_the_policy_default() {
    assert_eq!(decide(Some("maybe"), Policy::Worker), Decision::Enter);
    assert_eq!(decide(Some("maybe"), Policy::Tool), Decision::NotAsked);
}

#[test]
fn turned_off_says_so_in_one_line_naming_the_variable() {
    let line = Outcome::TurnedOff.line().expect("a line");
    assert!(line.contains(ENV), "{line}");
    assert!(line.contains("without reduced rights"), "{line}");
    assert!(!line.contains('\n'), "{line}");
}

#[test]
fn a_failed_setup_says_why_in_one_line() {
    let line = Outcome::Failed("landlock refused the rules: invalid argument".into()).line().expect("a line");
    assert!(line.contains("without reduced rights"), "{line}");
    assert!(line.contains("landlock refused the rules: invalid argument"), "{line}");
    assert!(!line.contains('\n'), "{line}");
}

#[test]
fn a_reason_over_several_lines_still_logs_one() {
    let line = Outcome::Failed("first\nsecond".into()).line().expect("a line");
    assert!(!line.contains('\n'), "{line}");
    assert!(line.contains("first") && line.contains("second"), "{line}");
}

#[test]
fn quiet_when_on_not_asked_or_the_kernel_cannot_limit_writes() {
    assert_eq!(Outcome::On { writes: true }.line(), None);
    assert_eq!(Outcome::On { writes: false }.line(), None);
    assert_eq!(Outcome::NotAsked.line(), None);
}

#[test]
fn only_an_entered_sandbox_counts_as_on() {
    assert!(Outcome::On { writes: false }.is_on());
    assert!(!Outcome::NotAsked.is_on());
    assert!(!Outcome::TurnedOff.is_on());
    assert!(!Outcome::Failed("x".into()).is_on());
}

#[test]
fn a_tool_left_alone_does_not_touch_the_process() {
    assert_eq!(enter_with(None, Policy::Tool, &[]), Outcome::NotAsked);
    assert_eq!(enter_with(Some("0"), Policy::Worker, &[]), Outcome::TurnedOff);
}
