use fundacad_lib::doc_paths::{
    check_open, check_save, is_remote_or_device, refuse_unvouched, Provenance, Vouched, MAX_VOUCHED,
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
