use super::*;

#[test]
fn stamps_read_as_utc_dates() {
    assert_eq!(utc_stamp(0), "1970-01-01 00:00:00 UTC");
    assert_eq!(utc_stamp(951_782_400), "2000-02-29 00:00:00 UTC");
    assert_eq!(utc_stamp(1_795_718_527), "2026-11-26 18:42:07 UTC");
}

#[test]
fn a_crash_is_offered_once() {
    let dir = std::env::temp_dir().join(format!("fundacad-app-test-{}-crash", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(NAME), crash_text("now", "main", "boom", "src/a.rs:1", "trace")).unwrap();
    let text = take_pending(&dir).unwrap();
    assert!(text.contains("thread 'main' panicked at src/a.rs:1:\nboom"), "{text}");
    assert!(take_pending(&dir).is_none());
    assert!(dir.join(OLD).exists());
    let _ = std::fs::remove_dir_all(&dir);
}
