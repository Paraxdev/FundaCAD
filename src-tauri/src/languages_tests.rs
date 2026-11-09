use super::*;
use tauri::test::MockRuntime;

/// A fresh folder under the system temp folder, removed again when the test ends, passed or not.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(name: &str) -> Scratch {
    let dir = std::env::temp_dir().join(format!("fundacad-languages-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Scratch(dir)
}

fn languages(root: &Scratch) -> PathBuf {
    let dir = root.0.join("languages");
    std::fs::create_dir(&dir).unwrap();
    dir
}

fn put(dir: &Path, name: &str, text: impl AsRef<[u8]>) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

const NONE: [&str; 0] = [];

// Windows makes a symlink only with Developer Mode on, so those cases skip there and run on the unix CI legs.
fn link_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link).is_ok();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, link).is_ok();
    if !made {
        eprintln!("skipped: this system made no link at {}", link.display());
    }
    made
}

// A junction needs no privilege, so the linked folder cases run on every Windows machine.
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link).is_ok();
    #[cfg(windows)]
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .is_ok_and(|out| out.status.success());
    if !made {
        eprintln!("skipped: this system made no link at {}", link.display());
    }
    made
}

#[test]
fn a_code_names_a_language_file() {
    for code in ["pl", "fil", "zh-CN", "zh-Hant", "zh-Hant-TW", "es-419", "sr-Latn", "de-AT"] {
        assert!(is_language_code(code), "{code}");
    }
}

#[test]
fn a_code_with_a_separator_a_dot_or_the_wrong_case_is_refused() {
    let separators = ["pl_PL", "pl.json", "../de", "de/x", "de\\x", "..", "de.", "de json", "de\0", "-de", "de-"];
    let case = ["PL", "zh-cn", "de-at", "zh-hant", "zh-HANT", "zh-Hant-tw", "dé"];
    let lengths = ["", "x", "abcd", "pseudo", "es-41", "es-4190", "de-A", "de-AUT", "zh-Han", "zh-Hanta"];
    let order = ["de-AT-AT", "zh-TW-Hant"];
    for code in separators.into_iter().chain(case).chain(lengths).chain(order) {
        assert!(!is_language_code(code), "{code:?}");
    }
}

#[test]
fn a_missing_or_empty_folder_lists_nothing() {
    let root = scratch("list-empty");
    assert_eq!(list(&root.0.join("languages")), NONE);
    assert_eq!(list(&languages(&root)), NONE);
}

#[test]
fn one_file_lists_its_code() {
    let root = scratch("list-one");
    let dir = languages(&root);
    put(&dir, "pl.json", r#"{"menu.file":"Plik"}"#);
    assert_eq!(list(&dir), ["pl"]);
}

#[test]
fn many_files_list_sorted() {
    let root = scratch("list-many");
    let dir = languages(&root);
    for code in ["zh-CN", "fil", "es-419", "de", "sr-Latn", "pl"] {
        put(&dir, &format!("{code}.json"), "{}");
    }
    assert_eq!(list(&dir), ["de", "es-419", "fil", "pl", "sr-Latn", "zh-CN"]);
}

#[test]
fn only_plain_files_named_by_a_code_are_listed() {
    let root = scratch("list-ignored");
    let dir = languages(&root);
    put(&dir, "de.json", "{}");
    for name in ["notes.txt", "PL.json", "a.json", "it.JSON", "pt.json.bak", ".json", "pseudo.json", "nl"] {
        put(&dir, name, "{}");
    }
    std::fs::create_dir(dir.join("fr.json")).unwrap();
    let outside = put(&root.0, "es.json", "{}");
    link_file(&outside, &dir.join("es.json"));
    assert_eq!(list(&dir), ["de"]);
}

#[test]
fn at_most_a_hundred_codes_are_listed() {
    let root = scratch("list-cap");
    let dir = languages(&root);
    let mut codes: Vec<String> =
        (b'a'..=b'z').flat_map(|a| (b'a'..=b'z').map(move |b| String::from_utf8(vec![a, b]).unwrap())).collect();
    codes.truncate(100);
    for code in &codes {
        put(&dir, &format!("{code}.json"), "{}");
    }
    assert_eq!(list(&dir), codes);

    put(&dir, "aaa.json", "{}");
    codes.insert(1, "aaa".into());
    codes.pop();
    assert_eq!(list(&dir), codes);
}

#[test]
fn a_languages_folder_that_is_a_link_lists_and_reads_nothing() {
    let root = scratch("list-linked");
    let real = root.0.join("elsewhere");
    std::fs::create_dir(&real).unwrap();
    put(&real, "de.json", r#"{"menu.file":"Datei"}"#);
    assert_eq!(list(&real), ["de"]);
    let dir = root.0.join("languages");
    if !link_dir(&real, &dir) {
        return;
    }
    assert_eq!(list(&dir), NONE);
    assert_eq!(read(&dir, "de"), Ok(None));
}

#[test]
fn read_of_a_missing_file_or_folder_is_none() {
    let root = scratch("read-missing");
    assert_eq!(read(&root.0.join("languages"), "de"), Ok(None));
    let dir = languages(&root);
    put(&dir, "fr.json", "{}");
    assert_eq!(read(&dir, "de"), Ok(None));
}

#[test]
fn read_gives_each_file_its_own_text() {
    let root = scratch("read-text");
    let dir = languages(&root);
    let de = r#"{"menu.file":"Datei","panel.size":"Größe"}"#;
    let ja = r#"{"menu.file":"ファイル"}"#;
    put(&dir, "de.json", de);
    put(&dir, "ja.json", ja);
    assert_eq!(read(&dir, "de"), Ok(Some(de.to_owned())));
    assert_eq!(read(&dir, "ja"), Ok(Some(ja.to_owned())));
}

#[test]
fn read_takes_256_kib_of_bytes_and_refuses_one_more() {
    let root = scratch("read-size");
    let dir = languages(&root);
    let full = "é".repeat(131_072);
    assert_eq!(full.len() as u64, MAX_BYTES);
    put(&dir, "de.json", &full);
    put(&dir, "fr.json", format!("{full}x"));
    assert_eq!(read(&dir, "de"), Ok(Some(full)));
    let refused = read(&dir, "fr").unwrap_err();
    assert!(refused.contains("fr.json"), "{refused}");
}

#[test]
fn read_refuses_text_that_is_not_utf8() {
    let root = scratch("read-utf8");
    let dir = languages(&root);
    put(&dir, "de.json", b"{\"menu.file\":\"Dat\xe9i\"}");
    put(&dir, "fr.json", "{\"menu.file\":\"Fichier\"}");
    let refused = read(&dir, "de").unwrap_err();
    assert!(refused.contains("de.json"), "{refused}");
    assert_eq!(read(&dir, "fr"), Ok(Some("{\"menu.file\":\"Fichier\"}".to_owned())));
}

#[test]
fn read_refuses_a_code_with_a_path_in_it_before_touching_the_disk() {
    let root = scratch("read-path");
    let dir = languages(&root);
    let outside = put(&root.0, "x.json", "{}");
    let absolute = outside.with_extension("").to_string_lossy().into_owned();
    for code in ["../x", "..\\x", "de/../../x", absolute.as_str(), "X"] {
        assert!(read(&dir, code).is_err(), "{code:?}");
        assert!(read(&root.0.join("missing"), code).is_err(), "{code:?}");
    }
}

#[test]
fn read_refuses_a_link_even_to_a_good_file() {
    let root = scratch("read-link");
    let dir = languages(&root);
    let outside = put(&root.0, "de.json", r#"{"menu.file":"Datei"}"#);
    assert!(read(&root.0, "de").unwrap().is_some());
    if !link_file(&outside, &dir.join("de.json")) {
        return;
    }
    let refused = read(&dir, "de").unwrap_err();
    assert!(refused.contains("de.json"), "{refused}");
}

#[test]
fn read_refuses_a_folder_named_like_a_language_file() {
    let root = scratch("read-folder");
    let dir = languages(&root);
    std::fs::create_dir(dir.join("de.json")).unwrap();
    let refused = read(&dir, "de").unwrap_err();
    assert!(refused.contains("de.json"), "{refused}");
}

#[cfg(unix)]
#[test]
fn a_fifo_named_like_a_language_file_is_refused_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let root = scratch("read-fifo");
    let dir = languages(&root);
    let path = std::ffi::CString::new(dir.join("de.json").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    assert_eq!(list(&dir), NONE);
    let refused = read(&dir, "de").unwrap_err();
    assert!(refused.contains("de.json"), "{refused}");
}

#[test]
fn folder_creates_a_missing_languages_folder_and_keeps_one_there() {
    let root = scratch("folder-make");
    let dir = root.0.join("data").join("languages");
    assert_eq!(folder(&dir), Ok(()));
    assert!(std::fs::symlink_metadata(&dir).unwrap().is_dir());
    put(&dir, "pl.json", "{}");
    assert_eq!(folder(&dir), Ok(()));
    assert_eq!(list(&dir), ["pl"]);
}

#[test]
fn folder_refuses_a_file_or_a_link_in_its_place() {
    let root = scratch("folder-refuse");
    let file = put(&root.0, "languages", "{}");
    assert!(folder(&file).is_err());
    assert!(std::fs::symlink_metadata(&file).unwrap().is_file());

    let real = root.0.join("elsewhere");
    std::fs::create_dir(&real).unwrap();
    let linked = root.0.join("linked");
    if !link_dir(&real, &linked) {
        return;
    }
    assert!(folder(&linked).is_err());
}

fn app(safe: bool) -> tauri::App<MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(crate::SafeMode {
        reason: safe.then_some(crate::safe_mode::Reason::Crashes(3)),
        dir: std::env::temp_dir().join("fundacad-languages-never-written"),
        set_compositing: false,
        counted: std::sync::OnceLock::new(),
        set_x11: false,
        crashes: 3,
        crash_armed: std::sync::atomic::AtomicBool::new(false),
        reset: None,
        asked: None,
    });
    app
}

// A bad code is refused before the disk is touched, so these never reach the real app data folder.
#[test]
fn safe_mode_reads_no_language_file() {
    let read_bad =
        |safe: bool| futures_executor::block_on(language_file_read(app(safe).handle().clone(), "../x".into()));
    assert!(read_bad(false).is_err());
    assert_eq!(read_bad(true), Ok(None));
    let safe = app(true);
    assert_eq!(futures_executor::block_on(language_files_list(safe.handle().clone())), Ok(Vec::new()));
    assert_eq!(futures_executor::block_on(language_folder_open(safe.handle().clone())), Ok(()));
}
