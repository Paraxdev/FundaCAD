use fundacad_mcp::scope::*;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Not tempfile's default `.tmpXXXX`, whose dot would hide everything below it.
fn dir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("scope-").tempdir().unwrap()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A scope over one temp dir as an app folder, `allowed` as picked
/// folders, and a home of its own so the real one is never judged.
fn scope(app: &[&Path], allowed: &[&Path], home: &Path) -> PathScope {
    let (scope, refused) = PathScope::new(
        app.iter().map(|p| p.to_path_buf()).collect(),
        allowed.iter().map(|p| p.to_path_buf()).collect(),
        Some(home.to_path_buf()),
    );
    assert!(refused.is_empty(), "{refused:?}");
    scope
}

#[test]
fn windows_spellings_that_reach_past_the_filesystem_are_refused() {
    for raw in [
        r"\\server\share\a.funda",
        "//server/share/a.funda",
        r"\\?\C:\a.funda",
        r"\\?\UNC\server\share\a.funda",
        r"\\.\NUL",
        r"\\.\PhysicalDrive0",
        r"\??\C:\a.funda",
        "C:a.funda",
        "C:",
        r"C:\x\a.funda:zone",
        r"C:\x\a.funda::$DATA",
        r"C:\x\NUL.txt",
        r"C:\x\com1",
        r"C:\x\LPT9.stl",
        "COM1",
        "con",
        "aux.funda",
    ] {
        assert!(spelling_refusal(raw).is_some(), "{raw} should be refused");
    }
}

#[test]
fn plain_paths_and_names_that_only_look_like_devices_pass_the_spelling() {
    for raw in [
        r"C:\x\a.funda",
        "C:/x/a.funda",
        "/home/me/part.funda",
        "part.funda",
        "console.funda",
        "com10.stl",
        "lpt.stl",
        "nulled/a.funda",
    ] {
        assert_eq!(spelling_refusal(raw), None, "{raw}");
    }
}

#[test]
fn unix_roots_home_and_what_holds_home_are_never_allowed_folders() {
    let base = dir();
    let home = base.path().join("home").join("me");
    std::fs::create_dir_all(&home).unwrap();
    let (scope, refused) =
        PathScope::new(vec![], vec![PathBuf::from("/"), home.clone(), base.path().join("home")], Some(home.clone()));
    assert!(scope.folders().is_empty(), "{:?}", scope.folders());
    assert_eq!(refused.len(), 3, "{refused:?}");
    assert!(refused[0].contains("root"), "{}", refused[0]);
    assert!(refused[1].contains("home folder itself"), "{}", refused[1]);
    assert!(refused[2].contains("holds the home folder"), "{}", refused[2]);
}

#[cfg(windows)]
#[test]
fn a_drive_root_is_never_an_allowed_folder() {
    let base = dir();
    let (scope, refused) = PathScope::new(vec![], vec![PathBuf::from(r"C:\")], Some(base.path().to_path_buf()));
    assert!(scope.folders().is_empty());
    assert!(refused[0].contains("drive or filesystem root"), "{refused:?}");
}

#[test]
fn home_and_a_drive_root_are_not_adopted_as_the_document_folder() {
    let base = dir();
    let home = base.path().join("me");
    std::fs::create_dir_all(&home).unwrap();
    let scope = scope(&[], &[], &home);
    let in_home = home.join("part.funda");
    let err = scope.check(&s(&in_home), Some(&in_home)).unwrap_err();
    assert!(err.contains("cannot be allowed"), "{err}");
    assert!(err.contains("home folder itself"), "{err}");
    let at_root = if cfg!(windows) { PathBuf::from(r"C:\part.funda") } else { PathBuf::from("/part.funda") };
    assert!(scope.check(&s(&at_root), Some(&at_root)).is_err());
}

#[test]
fn the_document_folder_is_reached_but_not_hidden_names_below_it() {
    let base = dir();
    let docs = base.path().join("work").join("parts");
    std::fs::create_dir_all(docs.join(".git")).unwrap();
    let scope = scope(&[], &[], &base.path().join("me"));
    let doc = docs.join("a.funda");
    assert_eq!(scope.check(&s(&docs.join("b.stl")), Some(&doc)).unwrap(), docs.join("b.stl"));
    let err = scope.check(&s(&docs.join(".git").join("x.funda")), Some(&doc)).unwrap_err();
    assert!(err.contains(".git") && err.contains("hidden"), "{err}");
    assert!(scope.check(&s(&docs.join(".env")), Some(&doc)).is_err());
    assert!(scope.check(&s(&docs.join("b.stl")), None).is_err(), "no document, no folder");
}

#[test]
fn a_document_in_a_hidden_folder_does_not_open_its_folder() {
    let base = dir();
    let dotted = base.path().join("me").join(".config").join("x");
    std::fs::create_dir_all(&dotted).unwrap();
    let scope = scope(&[], &[], &base.path().join("me"));
    let doc = dotted.join("a.funda");
    assert!(scope.check(&s(&dotted.join("b.funda")), Some(&doc)).is_err());
}

#[test]
fn an_app_folder_is_reached_in_full_hidden_names_included() {
    let temp = tempfile::tempdir().unwrap();
    assert!(temp.path().file_name().unwrap().to_string_lossy().starts_with(".tmp"));
    let inner = temp.path().join(".tmpinner").join("a.funda");
    std::fs::create_dir_all(inner.parent().unwrap()).unwrap();
    let scope = scope(&[temp.path()], &[], Path::new("/nonexistent-home"));
    assert_eq!(scope.check(&s(&inner), None).unwrap(), inner);
}

#[test]
fn dot_dot_cannot_climb_out_of_an_allowed_folder() {
    let base = dir();
    let root = base.path().join("allowed");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    let scope = scope(&[], &[&root], &base.path().join("me"));
    let out = format!("{}/sub/../../out.funda", s(&root));
    let err = scope.check(&out, None).unwrap_err();
    assert!(err.contains("outside the folders"), "{err}");
    let inside = format!("{}/sub/../in.funda", s(&root));
    assert_eq!(scope.check(&inside, None).unwrap(), root.join("in.funda"));
}

#[test]
fn a_folder_not_made_yet_is_judged_by_where_it_would_be() {
    let base = dir();
    let root = base.path().join("allowed");
    std::fs::create_dir_all(&root).unwrap();
    let scope = scope(&[], &[&root], &base.path().join("me"));
    assert!(scope.check(&s(&root.join("new").join("a.stl")), None).is_ok());
    assert!(scope.check(&s(&base.path().join("new").join("a.stl")), None).is_err());
}

fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link).is_ok();
    // A junction needs no developer mode, so the test runs on any Windows.
    #[cfg(windows)]
    return std::os::windows::fs::symlink_dir(target, link).is_ok()
        || std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success());
}

#[test]
fn a_link_inside_an_allowed_folder_cannot_lead_out_of_it() {
    let base = dir();
    let root = base.path().join("allowed");
    let away = base.path().join("away");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&away).unwrap();
    if !link_dir(&away, &root.join("door")) {
        eprintln!("symlinks need developer mode here, skipped");
        return;
    }
    let scope = scope(&[], &[&root], &base.path().join("me"));
    let err = scope.check(&s(&root.join("door").join("a.funda")), None).unwrap_err();
    assert!(err.contains("outside the folders"), "{err}");
    if link_dir(&base.path().join("gone"), &root.join("dangling")) {
        assert!(scope.check(&s(&root.join("dangling")), None).is_err());
    }
}

#[test]
fn the_refusal_names_the_folder_that_would_be_allowed_and_how() {
    let base = dir();
    let root = base.path().join("allowed");
    let other = base.path().join("other");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let scope = scope(&[], &[&root], &base.path().join("me"));
    let err = scope.check(&s(&other.join("a.funda")), None).unwrap_err();
    let other_c = canonical(&other).unwrap();
    assert!(err.contains(&format!("Allowing {} would", other_c.display())), "{err}");
    assert!(err.contains("--mcp --allow-path") && err.contains(ALLOW_ENV), "{err}");
    assert!(err.contains(&root.display().to_string()), "{err}");
    assert!(!err.contains("copy the file"), "{err}");
}

fn open(app: &[&Path], home: &Path) -> PathScope {
    let (scope, refused) = PathScope::open(app.iter().map(|p| p.to_path_buf()).collect(), Some(home.to_path_buf()));
    assert!(refused.is_empty(), "{refused:?}");
    scope
}

#[test]
fn by_default_a_folder_a_person_uses_is_reached() {
    let base = dir();
    let me = base.path().join("me");
    for sub in ["Documents", "Downloads", "work/deep"] {
        std::fs::create_dir_all(me.join(sub)).unwrap();
    }
    std::fs::create_dir_all(base.path().join("proj")).unwrap();
    let scope = open(&[], &me);
    for p in [
        base.path().join("proj").join("a.funda"),
        me.join("Documents").join("a.funda"),
        me.join("Downloads").join("a.step"),
        me.join("work").join("deep").join("a.stl"),
        me.join("new").join("x.funda"),
    ] {
        assert_eq!(scope.check(&s(&p), None), Ok(p.clone()), "{}", p.display());
    }
}

#[test]
fn by_default_a_relative_path_resolves_in_the_working_folder_and_is_reached() {
    let cwd = std::env::current_dir().unwrap();
    let (scope, _) = PathScope::open(vec![], None);
    assert_eq!(scope.check("x.funda", None).unwrap(), cwd.join("x.funda"));
}

#[test]
fn by_default_home_a_root_dot_folders_and_odd_spellings_are_refused() {
    let base = dir();
    let me = base.path().join("me");
    let proj = base.path().join("proj");
    std::fs::create_dir_all(me.join(".ssh")).unwrap();
    std::fs::create_dir_all(proj.join(".git")).unwrap();
    let scope = open(&[], &me);
    let root = if cfg!(windows) { "C:/a.funda" } else { "/a.funda" };
    for (raw, why) in [
        (s(&me.join("a.funda")), "home folder itself"),
        (root.to_string(), "root"),
        (s(&base.path().join("x.funda")), "holds the home folder"),
        (s(&me.join(".ssh").join("a.funda")), "hidden"),
        (s(&proj.join(".git").join("x")), "hidden"),
        (s(&proj.join(".bashrc")), "hidden"),
        (s(&me.join(".config").join("new").join("a.funda")), "hidden"),
        ("//srv/share/a.funda".to_string(), "network"),
        (s(&proj.join("NUL")), "device"),
        (format!("{}:ads", s(&proj.join("a.funda"))), "alternate data stream"),
    ] {
        let err = scope.check(&raw, None).unwrap_err();
        assert!(err.contains(why), "{raw}: {err}");
    }
}

#[test]
fn by_default_dot_dot_and_links_cannot_reach_a_refused_place() {
    let base = dir();
    let me = base.path().join("me");
    let proj = base.path().join("proj");
    std::fs::create_dir_all(me.join(".ssh")).unwrap();
    std::fs::create_dir_all(&proj).unwrap();
    let scope = open(&[], &me);
    let climb = format!("{}/../me/.ssh/k", s(&proj));
    assert!(scope.check(&climb, None).unwrap_err().contains("hidden"), "{climb}");
    let climb = format!("{}/sub/../../me/a.funda", s(&proj));
    assert!(scope.check(&climb, None).unwrap_err().contains("home folder itself"), "{climb}");
    if !link_dir(&me.join(".ssh"), &proj.join("innocent")) {
        eprintln!("symlinks need developer mode here, skipped");
        return;
    }
    let err = scope.check(&s(&proj.join("innocent").join("a.funda")), None).unwrap_err();
    assert!(err.contains("hidden"), "{err}");
    if link_dir(&me, &proj.join("h")) {
        let err = scope.check(&s(&proj.join("h").join("a.funda")), None).unwrap_err();
        assert!(err.contains("home folder itself"), "{err}");
    }
}

#[test]
fn by_default_the_apps_own_dot_folders_are_reached() {
    let temp = tempfile::tempdir().unwrap();
    assert!(temp.path().file_name().unwrap().to_string_lossy().starts_with(".tmp"));
    let inner = temp.path().join(".tmpinner").join("a.funda");
    std::fs::create_dir_all(inner.parent().unwrap()).unwrap();
    let scope = open(&[temp.path()], Path::new("/nonexistent-home"));
    assert_eq!(scope.check(&s(&inner), None).unwrap(), inner);
}

#[test]
fn strict_mode_is_a_given_folder_or_the_strict_env() {
    let one = [PathBuf::from("D:/parts")];
    assert!(strict(&one, None));
    assert!(strict(&[], Some("1".into())));
    assert!(strict(&[], Some(" true ".into())));
    assert!(!strict(&[], None));
    assert!(!strict(&[], Some("0".into())));
    assert!(!strict(&[], Some(String::new())));
}

#[test]
fn a_dropped_allow_path_is_named_in_the_refusal() {
    let base = dir();
    let home = base.path().join("me");
    let other = base.path().join("other");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let (scope, refused) = PathScope::new(vec![], vec![home.clone()], Some(home.clone()));
    assert_eq!(refused.len(), 1, "{refused:?}");
    let err = scope.check(&s(&other.join("a.funda")), None).unwrap_err();
    assert!(err.contains(&home.display().to_string()) && err.contains("ignored"), "{err}");
    assert!(err.contains("home folder itself"), "{err}");
    assert!(err.contains("--mcp --allow-path"), "{err}");
    assert!(!err.contains("copy the file"), "{err}");
}

#[test]
fn allow_path_is_read_repeated_after_mcp_and_from_the_env_list() {
    let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
    let got = allowed_paths(os(&["fundacad-mcp", "--allow-path", "A", "--allow-path=B", "--other"]), None);
    assert_eq!(got, vec![PathBuf::from("A"), PathBuf::from("B")]);
    let got = allowed_paths(os(&["fundacad", "--allow-path", "X", "--mcp", "--allow-path", "C"]), None);
    assert_eq!(got, vec![PathBuf::from("C")], "only what follows --mcp");
    let env = std::env::join_paths(["D", "E"]).unwrap();
    let got = allowed_paths(os(&["fundacad-mcp"]), Some(env));
    assert_eq!(got, vec![PathBuf::from("D"), PathBuf::from("E")]);
    assert!(allowed_paths(os(&["fundacad-mcp", "--allow-path"]), None).is_empty());
}

#[test]
fn a_relative_path_resolves_against_the_working_folder_before_it_is_judged() {
    let cwd = std::env::current_dir().unwrap();
    let (scope, _) = PathScope::new(vec![], vec![cwd.clone()], None);
    assert_eq!(scope.check("x.funda", None).unwrap(), cwd.join("x.funda"));
}
