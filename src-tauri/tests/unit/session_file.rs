use fundacad_lib::session_file::{remove_from, to_json, write_into, SessionInfo, FILE_NAME};

#[test]
fn the_json_is_what_the_reader_parses() {
    let info = SessionInfo { port: 8765, token: "abc123".into(), pid: 42 };
    assert_eq!(to_json(&info), "{\"port\":8765,\"token\":\"abc123\",\"pid\":42}\n");
}

/// An unescaped quote would end the string early, and every client would be refused by a file that looks fine.
#[test]
fn a_token_with_json_syntax_in_it_survives_the_round_trip() {
    let nasty = "a\"b\\c\nd";
    let json = to_json(&SessionInfo { port: 1, token: nasty.into(), pid: 2 });
    assert!(json.contains(r#""token":"a\"b\\c\nd""#), "{json}");
    // and the control character is not left raw, which would be invalid JSON
    assert!(!json.contains('\n') || json.ends_with('\n'));
    assert_eq!(json.matches('\n').count(), 1, "only the trailing newline: {json:?}");
}

#[test]
fn writing_then_removing_leaves_nothing_behind() {
    let dir = std::env::temp_dir().join(format!("fundacad-session-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    let info = SessionInfo { port: 9000, token: "tok".into(), pid: 7 };
    let path = write_into(&dir, &info).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), to_json(&info));

    // the temporary must not survive: a reader globbing the directory, or a
    // human, should see exactly one file
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers, vec![FILE_NAME.to_string()], "a temporary file survived");

    remove_from(&dir);
    assert!(!path.exists(), "the session file outlived the app");
    // ...and removing what is not there is not an error, because that is the
    // ordinary case on a second exit path
    remove_from(&dir);

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn the_token_is_not_readable_by_other_accounts() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("fundacad-session-perm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = write_into(&dir, &SessionInfo { port: 1, token: "t".into(), pid: 1 }).unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "the session file is group/world readable");
    let _ = std::fs::remove_dir_all(&dir);
}
