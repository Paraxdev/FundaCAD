use super::*;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-app-test-{}-log-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_full_log_starts_a_new_generation_and_keeps_two_old_ones() {
    let dir = temp("rotate");
    let mut log = LogFile::open(&dir, 20).unwrap();
    for i in 0..8 {
        log.write_line(&format!("line {i} of the run")).unwrap();
    }
    let read = |n| fs::read_to_string(generation(&dir, n)).unwrap_or_default();
    assert_eq!(read(0), "line 6 of the run\nline 7 of the run\n");
    assert_eq!(read(1), "line 4 of the run\nline 5 of the run\n");
    assert_eq!(read(2), "line 2 of the run\nline 3 of the run\n");
    assert!(!dir.join("fundacad.3.log").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_log_over_the_cap_from_the_last_run_moves_down_at_open() {
    let dir = temp("open");
    fs::create_dir_all(&dir).unwrap();
    fs::write(generation(&dir, 0), "x".repeat(30)).unwrap();
    let mut log = LogFile::open(&dir, 20).unwrap();
    log.write_line("fresh").unwrap();
    assert_eq!(fs::read_to_string(generation(&dir, 0)).unwrap(), "fresh\n");
    assert_eq!(fs::read_to_string(generation(&dir, 1)).unwrap().len(), 30);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_tail_reads_across_generations_from_a_line_start() {
    let dir = temp("tail");
    fs::create_dir_all(&dir).unwrap();
    fs::write(generation(&dir, 1), "old one\nold two\n").unwrap();
    fs::write(generation(&dir, 0), "new one\nnew two\n").unwrap();
    assert_eq!(tail(&dir, 1000).unwrap(), "old one\nold two\nnew one\nnew two\n");
    assert_eq!(tail(&dir, 24).unwrap(), "old two\nnew one\nnew two\n");
    assert_eq!(tail(&dir, 20).unwrap(), "new one\nnew two\n");
    assert_eq!(tail(&dir, 3).unwrap_or_default(), "");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_tail_hides_user_names() {
    let dir = temp("redact");
    fs::create_dir_all(&dir).unwrap();
    fs::write(generation(&dir, 0), "opened C:\\Users\\alice\\part.funda\n").unwrap();
    assert_eq!(tail(&dir, 1000).unwrap(), "opened C:\\Users\\[REDACTED]\\part.funda\n");
    let _ = fs::remove_dir_all(&dir);
}
