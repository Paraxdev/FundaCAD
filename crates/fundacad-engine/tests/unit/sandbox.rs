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

#[test]
fn the_network_stays_untouched_when_the_engine_runs_with_full_rights() {
    for entered in [Outcome::NotAsked, Outcome::TurnedOff, Outcome::Failed("no landlock".into())] {
        let line = close_network_with(&entered, || panic!("closed the network after {entered:?}"));
        assert_eq!(line, None);
    }
}

#[test]
fn a_network_that_will_not_close_logs_one_line_with_the_reason() {
    let line = close_network_with(&Outcome::On { writes: true }, || Err("seccomp said\nEINVAL".into()));
    let line = line.expect("one line");
    assert!(line.contains("network") && line.contains("seccomp said EINVAL"), "{line}");
    assert_eq!(close_network_with(&Outcome::On { writes: false }, || Ok(())), None);
}

#[test]
fn the_writable_folders_exist_before_the_rules_name_them() {
    let root = std::env::temp_dir().join(format!("fundacad-sandbox-prepare-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("a-file");
    std::fs::write(&file, b"x").unwrap();
    let fresh = root.join("blobs").join("deep");

    let kept = prepare(&[root.clone(), fresh.clone(), file.join("under-a-file")]);

    assert_eq!(kept, vec![root.clone(), fresh.clone()]);
    assert!(fresh.is_dir());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_shared_folder_or_one_above_it_is_never_opened_to_the_engine() {
    let root = std::env::temp_dir().join(format!("fundacad-sandbox-shared-{}", std::process::id()));
    let profile = root.join("Users").join("maker");
    let temp = profile.join("AppData").join("Local").join("Temp");
    let own = profile.join("AppData").join("Local").join("fundacad").join("engine-tmp");
    std::fs::create_dir_all(&temp).unwrap();
    std::fs::create_dir_all(&own).unwrap();
    let shared = [profile.clone(), temp.clone(), root.join("Windows")];

    assert!(opens_shared_folder(&temp, &shared));
    assert!(opens_shared_folder(&profile, &shared));
    assert!(opens_shared_folder(&root, &shared));
    assert!(opens_shared_folder(&temp.join("."), &shared));
    assert!(!opens_shared_folder(&own, &shared));
    assert!(!opens_shared_folder(&temp.join("fundacad"), &shared));
    let _ = std::fs::remove_dir_all(&root);
}

fn env_of(cmd: &std::process::Command) -> Vec<(String, Option<String>)> {
    let mut env: Vec<_> = cmd
        .get_envs()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
        .collect();
    env.sort();
    env
}

#[test]
fn the_apps_worker_gets_its_own_temp_folder_and_enters() {
    let mut cmd = std::process::Command::new("fundacad");
    let enters = worker_env(&mut cmd, Some(std::path::Path::new("/cache/engine-tmp")), None);
    let temp = |var: &str| (var.to_string(), Some("/cache/engine-tmp".to_string()));
    assert_eq!((env_of(&cmd), enters), (vec![temp("TEMP"), temp("TMP"), temp("TMPDIR")], true));
}

#[test]
fn the_variable_still_turns_the_apps_worker_off() {
    let mut cmd = std::process::Command::new("fundacad");
    assert!(!worker_env(&mut cmd, Some(std::path::Path::new("/cache/engine-tmp")), Some("0")));
    assert_eq!(env_of(&cmd).len(), 3);
}

#[test]
fn without_a_folder_to_stage_exports_in_the_apps_worker_runs_without_reduced_rights() {
    let mut cmd = std::process::Command::new("fundacad");
    let enters = worker_env(&mut cmd, None, Some("1"));
    assert_eq!((env_of(&cmd), enters), (vec![(ENV.to_string(), Some("0".to_string()))], false));
}
