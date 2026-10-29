use fundacad_lib::doc_paths::{
    check_open, check_save, is_remote_or_device, refuse_unvouched, stat_path, DocStat, Provenance, Vouched, MAX_VOUCHED,
};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-doc-paths-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn network_and_device_forms_are_recognised() {
    for raw in [
        r"\\host\share\a.funda",
        "//host/share/a.funda",
        r"\/host\share\a.funda",
        r"\\?\UNC\host\share\a.funda",
        r"\\.\pipe\name",
        r"\\.\C:\a.funda",
        r"\\?\C:\a.funda",
        r"\??\UNC\host\share\a.funda",
        "/??/UNC/host/share/a.funda",
    ] {
        assert!(is_remote_or_device(raw), "{raw} should count as a network or device path");
    }
}

#[test]
fn local_forms_are_not_network_paths() {
    for raw in [r"C:\Users\me\a.funda", "C:/Users/me/a.funda", "/home/me/a.funda", r"docs\a.funda", "a.funda", ""] {
        assert!(!is_remote_or_device(raw), "{raw} is a local path");
    }
}

#[test]
fn an_unvouched_network_path_is_refused_before_any_disk_access() {
    let vouched = Vouched::default();
    let err = refuse_unvouched(r"\\host\share\a.funda", &vouched).unwrap_err();
    assert!(err.contains("network or device"), "{err}");
    assert!(check_open(r"\\host\share\a.funda", &vouched).is_err());
    assert!(check_open(r"\\?\UNC\host\share\a.funda", &vouched).is_err());
    assert!(check_open(r"\\.\pipe\name", &vouched).is_err());
}

#[test]
fn a_vouched_network_path_passes_the_provenance_check() {
    let mut vouched = Vouched::default();
    vouched.vouch(r"\\host\share\a.funda");
    assert!(refuse_unvouched(r"\\host\share\a.funda", &vouched).is_ok());
    assert!(refuse_unvouched(r"\\host\share\b.funda", &vouched).is_err());
    #[cfg(windows)]
    assert!(refuse_unvouched("//HOST/share/A.funda", &vouched).is_ok());
}

#[test]
fn the_vouched_set_keeps_only_the_newest() {
    let mut vouched = Vouched::default();
    for i in 0..MAX_VOUCHED + 10 {
        vouched.vouch(&format!(r"\\host\share\{i}.funda"));
    }
    assert_eq!(vouched.len(), MAX_VOUCHED);
    assert!(!vouched.contains(r"\\host\share\0.funda"));
    assert!(vouched.contains(&format!(r"\\host\share\{}.funda", MAX_VOUCHED + 9)));
    vouched.vouch(&format!(r"\\host\share\{}.funda", MAX_VOUCHED + 9));
    assert_eq!(vouched.len(), MAX_VOUCHED);
}

#[test]
fn a_directory_is_refused() {
    let dir = temp_dir("dir");
    let err = check_open(dir.to_str().unwrap(), &Vouched::default()).unwrap_err();
    assert!(err.contains("not a file"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_file_is_refused() {
    let dir = temp_dir("missing");
    assert!(check_open(dir.join("gone.funda").to_str().unwrap(), &Vouched::default()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_plain_file_passes() {
    let dir = temp_dir("file");
    let file = dir.join("a.funda");
    std::fs::write(&file, "{}").unwrap();
    assert_eq!(check_open(file.to_str().unwrap(), &Vouched::default()).unwrap(), file);
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_device_node_is_refused() {
    assert!(check_open("/dev/zero", &Vouched::default()).is_err());
}

#[test]
fn the_app_state_opens_only_what_was_handed_over() {
    let held = Provenance::default();
    let dropped = String::from("//host/share/dropped.funda");
    assert!(held.refuse_unvouched(&dropped).is_err());
    held.vouch_all([dropped.as_str(), "C:/local/a.funda"]);
    assert!(held.refuse_unvouched(&dropped).is_ok());
    assert!(held.refuse_unvouched("//host/share/other.funda").is_err());
    assert!(held.check_open("//host/share/other.funda").unwrap_err().contains("network or device"));
}

#[test]
fn the_app_state_still_requires_a_file() {
    let dir = temp_dir("state");
    let held = Provenance::default();
    assert!(held.check_open(dir.to_str().unwrap()).unwrap_err().contains("not a file"));
    let file = dir.join("a.funda");
    std::fs::write(&file, "{}").unwrap();
    assert_eq!(held.check_open(file.to_str().unwrap()).unwrap(), file);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_stat_gives_size_and_modified_time_of_a_file() {
    let dir = temp_dir("stat");
    let file = dir.join("linked.funda");
    std::fs::write(&file, "{\"a\":1}").unwrap();
    let raw = file.to_str().unwrap();
    let got = stat_path(raw).unwrap().expect("the file is there");
    assert_eq!(got.size, 7);
    assert!(got.mtime_ms > 1_600_000_000_000, "{got:?}");
    std::fs::write(&file, "{\"a\":12}").unwrap();
    assert_eq!(stat_path(raw).unwrap().unwrap().size, 8);
    assert_eq!(Provenance::default().stat(raw).unwrap().unwrap().size, 8);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_stat_of_nothing_is_none_and_of_a_folder_is_refused() {
    let dir = temp_dir("stat-none");
    assert_eq!(stat_path(dir.join("gone.funda").to_str().unwrap()).unwrap(), None);
    assert!(stat_path(dir.to_str().unwrap()).unwrap_err().contains("not a file"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_stat_of_an_unvouched_network_path_is_refused() {
    let held = Provenance::default();
    for raw in [r"\\host\share\linked.funda", "//host/share/linked.funda", r"\\?\UNC\host\share\linked.funda"] {
        assert!(held.stat(raw).unwrap_err().contains("network or device"), "{raw}");
    }
}

#[test]
fn a_stat_serializes_for_the_window() {
    let got = serde_json::to_value(DocStat { size: 3, mtime_ms: 4 }).unwrap();
    assert_eq!(got, serde_json::json!({ "size": 3, "mtimeMs": 4 }));
}

#[test]
fn a_save_to_a_relative_path_is_refused() {
    for raw in ["a.funda", "parts/a.funda", "./a.fundab"] {
        assert!(check_save(raw).is_err(), "{raw} should be refused");
    }
}

#[test]
fn a_save_under_another_extension_is_refused() {
    let dir = std::env::temp_dir();
    for name in ["x.cmd", "x.ps1", "x.json", "x.bat", "x", "x.funda.cmd", "x.funda.", "x.funda "] {
        let raw = dir.join(name);
        let raw = raw.to_str().unwrap();
        let err = check_save(raw).expect_err(raw);
        assert!(err.contains(".funda"), "{err}");
    }
}

#[test]
fn a_save_to_an_absolute_document_path_passes() {
    let dir = std::env::temp_dir();
    for name in ["x.funda", "X.FUNDA", "x.fundab", "x.neocad", "x.Sindri"] {
        let raw = dir.join(name);
        assert_eq!(check_save(raw.to_str().unwrap()).unwrap(), raw);
    }
}

#[test]
fn a_save_to_a_network_path_needs_it_handed_over() {
    let raw = "//host/share/a.funda";
    let held = Provenance::default();
    assert_eq!(held.check_save(raw), Err(refuse_unvouched(raw, &Vouched::default()).unwrap_err()));
    held.vouch_all([raw]);
    assert_eq!(held.check_save(raw), Ok(std::path::PathBuf::from(raw)));
}

#[cfg(windows)]
#[test]
fn a_save_to_a_windows_device_name_or_a_file_stream_is_refused() {
    for raw in [
        r"C:\docs\NUL.funda",
        r"C:\docs\con.fundab",
        r"C:\docs\Aux.neocad",
        r"C:\docs\prn.sindri",
        r"C:\docs\COM1.funda",
        r"C:\docs\lpt9.funda",
        r"C:\docs\COM¹.funda",
        r"C:\docs\nul .funda",
        r"C:\docs\nul.txt.funda",
        r"C:\docs\CONIN$.funda",
        r"C:\docs\a.cmd:x.funda",
        r"C:\docs:x\a.funda",
    ] {
        assert_eq!(
            check_save(raw),
            Err(format!("{raw} names a Windows device or a file stream, so it was not saved."))
        );
    }
    for raw in [r"C:\docs\console.funda", r"C:\docs\nullable.funda", r"C:\docs\COM10.funda", r"C:\con\a.funda"] {
        assert_eq!(check_save(raw), Ok(std::path::PathBuf::from(raw)), "{raw}");
    }
}

fn refusal(raw: &str) -> Result<(), String> {
    Err(refuse_unvouched(raw, &Vouched::default()).unwrap_err())
}

#[test]
fn home_reopens_a_network_path_only_if_it_was_once_handed_over() {
    let dir = temp_dir("kept");
    let file = dir.join("vouched-paths.json");
    let raw = "//host/share/a.funda";
    let first = Provenance::default();
    first.keep_in(file.clone());
    assert_eq!(first.note_recent(raw), refusal(raw));
    assert_eq!(first.refuse_unvouched(raw), refusal(raw));
    first.vouch_all([raw, "C:/local/b.funda"]);
    let kept: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(kept, vec![if cfg!(windows) { raw.replace('/', "\\") } else { raw.to_string() }]);

    let next = Provenance::default();
    next.keep_in(file);
    assert_eq!(next.refuse_unvouched(raw), refusal(raw));
    assert_eq!(next.refuse_unknown(raw), Ok(()));
    assert_eq!(next.note_recent(raw), Ok(()));
    assert_eq!(next.refuse_unvouched(raw), Ok(()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn home_reads_under_a_network_folder_only_once_it_was_handed_over() {
    let held = Provenance::default();
    let inside = "//host/share/parts/sub/a.funda";
    assert_eq!(held.refuse_unknown(inside), refusal(inside));
    held.vouch_all(["//host/share/parts"]);
    assert_eq!(held.refuse_unknown("//host/share/parts"), Ok(()));
    assert_eq!(held.refuse_unknown(inside), Ok(()));
    assert_eq!(held.refuse_unvouched(inside), refusal(inside));
    for outside in [
        "//host/share/parts/../secret.funda",
        "//host/share/parts/./../x.funda",
        "//host/share/parts/.. /x.funda",
        "//host/share/parts//a.funda",
        "//host/share/partsx/a.funda",
        "//host/share/parts\u{15c}a.funda",
        "//host/share/parts\u{12f}a.funda",
        "//other/share/parts/a.funda",
    ] {
        assert_eq!(held.refuse_unknown(outside), refusal(outside), "{outside}");
    }
    assert_eq!(held.refuse_unknown("C:/local/a.funda"), Ok(()));
    assert_eq!(held.note_recent(inside), Ok(()));
    assert_eq!(held.refuse_unvouched(inside), Ok(()));
}

#[test]
fn home_reads_a_summary_only_from_a_file_it_may_reach() {
    let dir = temp_dir("home_file");
    let held = Provenance::default();
    let raw = dir.to_string_lossy().into_owned();
    assert_eq!(held.check_home(&raw), Err(format!("{raw} is not a file")));
    assert_eq!(held.check_home("//host/share/a.funda").map(|_| ()), refusal("//host/share/a.funda"));
    let file = dir.join("a.funda");
    std::fs::write(&file, "{}").unwrap();
    assert_eq!(held.check_home(file.to_str().unwrap()), Ok(file));
    let _ = std::fs::remove_dir_all(&dir);
}
