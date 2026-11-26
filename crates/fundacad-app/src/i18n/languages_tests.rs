use super::languages::*;

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-i18n-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_language_code_names_only_a_file_in_the_folder() {
    for ok in ["en", "pl", "zh-CN", "zh-Hant", "zh-Hant-TW", "es-419", "fil"] {
        assert!(is_language_code(ok), "{ok}");
    }
    for bad in ["", "EN", "e", "engl", "en_US", "en-us", "../en", "en.json", "con", "nul", "zh-hant", "en-US-x"] {
        assert!(!is_language_code(bad), "{bad}");
    }
}

#[test]
fn system_matching_never_gives_traditional_chinese_simplified() {
    let tags = |t: &[&str]| t.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let offered = ["en", "de", "zh-CN"];
    assert_eq!(match_system_language(&tags(&["de-AT"]), &offered), "de");
    assert_eq!(match_system_language(&tags(&["zh-TW", "de"]), &offered), "en");
    assert_eq!(match_system_language(&tags(&["zh-Hans-SG"]), &offered), "zh-CN");
    assert_eq!(match_system_language(&tags(&["pt-BR"]), &offered), "en");
    assert_eq!(match_system_language(&tags(&["fr", "de"]), &offered), "de");
}

#[test]
fn own_files_list_and_read_from_the_folder() {
    let dir = temp("list");
    std::fs::write(dir.join("pl.json"), "{}").unwrap();
    std::fs::write(dir.join("nl.json.TXT"), "{\"a\": \"b\"}").unwrap();
    std::fs::write(dir.join("notes.txt"), "x").unwrap();
    std::fs::write(dir.join("con.json"), "{}").unwrap();
    std::fs::create_dir(dir.join("de.json")).unwrap();
    assert_eq!(list(&dir), ["nl", "pl"]);
    assert_eq!(read(&dir, "pl"), Ok(Some("{}".into())));
    assert_eq!(read(&dir, "nl"), Ok(Some("{\"a\": \"b\"}".into())));
    assert_eq!(read(&dir, "fr"), Ok(None));
    assert!(read(&dir, "../pl").is_err());
    assert!(matches!(read(&dir, "de"), Err(ReadError::Other(_))));
    std::fs::write(dir.join("ru.json"), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
    assert_eq!(read(&dir, "ru"), Err(ReadError::TooLarge));
    std::fs::write(dir.join("uk.json"), [0xff, 0xfe]).unwrap();
    assert_eq!(read(&dir, "uk"), Err(ReadError::NotUtf8));
    let _ = std::fs::remove_dir_all(&dir);
}
