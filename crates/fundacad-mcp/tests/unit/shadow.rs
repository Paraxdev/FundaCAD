use std::path::Path;

use fundacad_mcp::shadow::own_folder;

#[test]
fn a_folder_this_account_made_is_its_own() {
    let dir = tempfile::tempdir().unwrap();
    assert!(own_folder(dir.path()));
}

#[test]
fn a_file_or_a_missing_path_is_no_folder_of_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "x").unwrap();
    assert_eq!((own_folder(&file), own_folder(&dir.path().join("missing"))), (false, false));
}

#[cfg(windows)]
#[test]
fn a_system_folder_is_not_this_accounts_own() {
    let windows = std::env::var_os("SystemRoot").expect("SystemRoot");
    assert!(!own_folder(Path::new(&windows)));
}

#[cfg(unix)]
#[test]
fn a_link_to_a_folder_is_not_a_folder_of_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(dir.path(), &link).unwrap();
    assert!(!own_folder(Path::new(&link)));
}
