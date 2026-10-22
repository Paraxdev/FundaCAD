use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

// log_file is private to the app and std only, so its file is compiled in here. CI also builds this file alone with
// rustc --test on every platform.
#[allow(dead_code)]
#[path = "../../src/log_file.rs"]
pub(crate) mod log_file;

use log_file::{open, redact_user_paths, rotate_if_over, start, tail, tail_for_run, RunLog, CAP, NAME};

const CHILD: &str = "FUNDACAD_LOG_FILE_CHILD";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-{name}-{}", std::process::id())).join("logs");
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn listing(dir: &Path) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (e.file_name().into_string().unwrap(), fs::read_to_string(e.path()).unwrap())
        })
        .collect();
    files.sort();
    files
}

fn pairs(want: &[(&str, &str)]) -> Vec<(String, String)> {
    want.iter().map(|(n, s)| (n.to_string(), s.to_string())).collect()
}

fn start_run(dir: &Path, cap: u64, line: &str) {
    let (path, mut f) = open(dir, cap).unwrap();
    assert_eq!(path, dir.join(NAME));
    writeln!(f, "{line}").unwrap();
}

/// Runs one test of this binary again in a child, with `CHILD` naming `dir`.
fn in_child(test: &str, dir: &Path) {
    // The harness names a test without the crate: "x" alone, "log_file::x" in tests/unit.
    let name = module_path!().split_once("::").map_or(test.to_string(), |(_, m)| format!("{m}::{test}"));
    // --nocapture, or the harness keeps println from reaching descriptor 1.
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env(CHILD, dir)
        .output()
        .unwrap();
    // A failing child panics into the log it redirected to, so the logs go into the message.
    let logs: String = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| {
            format!("--- {}\n{}", e.file_name().to_string_lossy(), fs::read_to_string(e.path()).unwrap_or_default())
        })
        .collect();
    assert!(
        out.status.success(),
        "{}{}{logs}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The lines this test wrote, without the harness's own lines that followed the redirect.
fn marked(path: &Path) -> Vec<String> {
    fs::read_to_string(path).unwrap().lines().filter(|l| l.starts_with("[t] ")).map(String::from).collect()
}

#[test]
fn each_start_under_the_cap_appends_so_a_crash_loop_keeps_every_run() {
    let dir = scratch("log-loop");
    for run in ["first", "second", "third"] {
        start_run(&dir, CAP, &format!("{run} run"));
    }
    assert_eq!(listing(&dir), pairs(&[(NAME, "first run\nsecond run\nthird run\n")]));
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn four_starts_over_the_cap_keep_the_last_three_runs() {
    let dir = scratch("log-three");
    for run in 1..=4 {
        start_run(&dir, 8, &format!("run {run} past the cap"));
    }
    assert_eq!(
        listing(&dir),
        pairs(&[
            ("fundacad.1.log", "run 3 past the cap\n"),
            ("fundacad.2.log", "run 2 past the cap\n"),
            (NAME, "run 4 past the cap\n"),
        ])
    );
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn a_log_one_byte_under_the_cap_is_appended_to_and_one_at_the_cap_is_rotated() {
    let dir = scratch("log-edge");
    start_run(&dir, 11, "0123456789");
    start_run(&dir, 12, "under");
    assert_eq!(listing(&dir), pairs(&[(NAME, "0123456789\nunder\n")]));
    start_run(&dir, 17, "at");
    assert_eq!(listing(&dir), pairs(&[("fundacad.1.log", "0123456789\nunder\n"), (NAME, "at\n")]));
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn the_old_macos_log_is_kept_as_the_first_rotated_one() {
    let dir = scratch("log-old");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("fundacad.old.log"), "older build\n").unwrap();
    fs::write(dir.join(NAME), "last run\n").unwrap();
    start_run(&dir, CAP, "this run");
    assert_eq!(listing(&dir), pairs(&[("fundacad.1.log", "older build\n"), (NAME, "last run\nthis run\n")]));
    start_run(&dir, 8, "next run");
    assert_eq!(
        listing(&dir),
        pairs(
            &[("fundacad.1.log", "last run\nthis run\n"), ("fundacad.2.log", "older build\n"), (NAME, "next run\n"),]
        )
    );
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[cfg(windows)]
fn crt_lines(text: &str) {
    use std::ffi::{c_void, CString};
    extern "C" {
        fn __acrt_iob_func(i: u32) -> *mut c_void;
        fn fputs(s: *const std::ffi::c_char, stream: *mut c_void) -> i32;
        fn _write(fd: i32, buf: *const u8, n: u32) -> i32;
    }
    for (i, via) in [(1, "stdout"), (2, "stderr")] {
        let line = CString::new(format!("[t] {text} C FILE {via}\n")).unwrap();
        let fd = format!("[t] {text} C fd {i}\n");
        // SAFETY: writes owned buffers through the CRT's own standard streams.
        unsafe {
            assert!(fputs(line.as_ptr(), __acrt_iob_func(i)) >= 0);
            assert_eq!(_write(i as i32, fd.as_ptr(), fd.len() as u32), fd.len() as i32);
        }
    }
}

#[cfg(windows)]
fn crt_want(text: &str) -> Vec<String> {
    ["C FILE stdout", "C fd 1", "C FILE stderr", "C fd 2"].map(|v| format!("[t] {text} {v}")).to_vec()
}

#[cfg(not(windows))]
fn crt_lines(_text: &str) {}

#[cfg(not(windows))]
fn crt_want(_text: &str) -> Vec<String> {
    Vec::new()
}

#[test]
fn start_sends_stdout_and_stderr_to_the_log() {
    if let Some(dir) = std::env::var_os(CHILD) {
        let path = start(Path::new(&dir), CAP).unwrap();
        println!("[t] rust stdout");
        eprintln!("[t] rust stderr");
        crt_lines("after start");
        let _ = writeln!(std::io::stderr(), "[t] path {}", path.display());
        return;
    }
    let dir = scratch("log-redirect");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(NAME), "[t] the run before\n").unwrap();
    in_child("start_sends_stdout_and_stderr_to_the_log", &dir);
    let mut want = vec!["[t] the run before".to_string(), "[t] rust stdout".into(), "[t] rust stderr".into()];
    want.extend(crt_want("after start"));
    want.push(format!("[t] path {}", dir.join(NAME).display()));
    assert_eq!(marked(&dir.join(NAME)), want);
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn a_run_past_the_cap_moves_on_to_a_fresh_log_and_keeps_the_last_three() {
    const CAP_T: u64 = 200;
    if let Some(dir) = std::env::var_os(CHILD) {
        let dir = Path::new(&dir);
        start(dir, CAP_T).unwrap();
        println!("[t] first {}", "x".repeat(50));
        crt_lines("first");
        // The C runtime lines are Windows only, so the pad to one byte under the cap is measured.
        let under = CAP_T - 1 - fs::metadata(dir.join(NAME)).unwrap().len();
        println!("[t] first again {}", "x".repeat(under as usize - "[t] first again \n".len()));
        assert!(!rotate_if_over(dir, CAP_T).unwrap());
        println!();
        assert!(rotate_if_over(dir, CAP_T).unwrap());
        assert!(!rotate_if_over(dir, CAP_T).unwrap());
        println!("[t] second {}", "y".repeat(200));
        assert!(rotate_if_over(dir, CAP_T).unwrap());
        eprintln!("[t] third {}", "z".repeat(200));
        // On Windows the first log is still open through the leaked handle, and is dropped now.
        assert!(rotate_if_over(dir, CAP_T).unwrap());
        eprintln!("[t] fourth");
        crt_lines("fourth");
        return;
    }
    let dir = scratch("log-midrun");
    in_child("a_run_past_the_cap_moves_on_to_a_fresh_log_and_keeps_the_last_three", &dir);
    let mut fourth = vec!["[t] fourth".to_string()];
    fourth.extend(crt_want("fourth"));
    assert_eq!(
        [NAME, "fundacad.1.log", "fundacad.2.log"].map(|n| marked(&dir.join(n))),
        [fourth, vec![format!("[t] third {}", "z".repeat(200))], vec![format!("[t] second {}", "y".repeat(200))]]
    );
    let mut names: Vec<String> =
        fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["fundacad.1.log", "fundacad.2.log", "fundacad.log"]);
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

fn generations(dir: &Path, older: &str, old: &str, current: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("fundacad.2.log"), older).unwrap();
    fs::write(dir.join("fundacad.1.log"), old).unwrap();
    fs::write(dir.join(NAME), current).unwrap();
}

#[test]
fn the_tail_is_none_without_a_log_and_whole_when_it_fits() {
    let dir = scratch("log-tail-fit");
    assert_eq!(tail(&dir, 64), None);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(NAME), "").unwrap();
    assert_eq!(tail(&dir, 64), None);
    fs::write(dir.join(NAME), "one run\n").unwrap();
    assert_eq!(tail(&dir, 64).as_deref(), Some("one run\n"));
    generations(&dir, "oldest a\noldest b\n", "older a\nolder b\n", "one run\n");
    assert_eq!(tail(&dir, 64).as_deref(), Some("oldest a\noldest b\nolder a\nolder b\none run\n"));
    assert_eq!(tail(&dir, 0), None);
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn the_tail_reaching_into_a_rotated_log_starts_on_a_whole_line() {
    let dir = scratch("log-tail-cut");
    generations(&dir, "oldest\n", "older a\nolder b\n", "one run\n");
    let cases = [
        (8, "one run\n"),
        (9, "one run\n"),
        (15, "one run\n"),
        (16, "older b\none run\n"),
        (17, "older b\none run\n"),
        (24, "older a\nolder b\none run\n"),
        (25, "older a\nolder b\none run\n"),
        (31, "oldest\nolder a\nolder b\none run\n"),
    ];
    for (max, want) in cases {
        assert_eq!(tail(&dir, max).as_deref(), Some(want), "max {max}");
    }
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn the_tail_drops_a_character_it_cut_through_and_hides_user_names() {
    let dir = scratch("log-tail-names");
    let current = "logs to C:\\Users\\Jörg Weiß\\AppData\\Local\\dev.fundacad.app\\logs\n[engine] ready\n";
    generations(&dir, "", "müde\n", current);
    let max = current.len() as u64 + 4;
    assert_eq!(
        tail(&dir, max).as_deref(),
        Some("logs to C:\\Users\\[REDACTED]\\AppData\\Local\\dev.fundacad.app\\logs\n[engine] ready\n")
    );
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn user_names_in_paths_are_hidden() {
    let cases = [
        (r"spawn: C:\Users\jrabi\AppData\Local\x.exe", r"spawn: C:\Users\[REDACTED]\AppData\Local\x.exe"),
        (r"\\HOST\Users\someone\share", r"\\HOST\Users\[REDACTED]\share"),
        ("path /home/alice/proj/x.py and /Users/bob/y", "path /home/[REDACTED]/proj/x.py and /Users/[REDACTED]/y"),
        (r#"log at "C:\Users\name" end"#, r#"log at "C:\Users\[REDACTED]" end"#),
        (r"c:\users\John Smith\Documents\bracket.funda", r"c:\users\[REDACTED]\Documents\bracket.funda"),
        (
            "İstanbul C:\\Users\\Ümit\\x and C:/Users/user/y",
            "İstanbul C:\\Users\\[REDACTED]\\x and C:/Users/[REDACTED]/y",
        ),
        ("home C:\\Users\\bob\nnext /home/carol", "home C:\\Users\\[REDACTED]\nnext /home/[REDACTED]"),
        (r"C:\Users\\x and C:\Users\", r"C:\Users\\x and C:\Users\"),
        ("no paths here", "no paths here"),
        ("", ""),
    ];
    for (text, want) in cases {
        assert_eq!(redact_user_paths(text), want, "{text}");
    }
}

#[test]
fn a_run_writing_to_its_log_gets_the_tail_and_any_other_run_says_it_has_none() {
    let dir = scratch("log-tail-run");
    // The case that misled: an old run's log sits in the folder while this run writes to a terminal.
    generations(&dir, "", "", "an older run\n[engine] ready\n");
    let line = |run: &RunLog| tail_for_run(run, 64);
    assert_eq!(line(&RunLog::ToFile(dir.join(NAME))).as_deref(), Some("an older run\n[engine] ready\n"));
    assert_eq!(
        line(&RunLog::Terminal).as_deref(),
        Some("No log file for this run, it writes to the terminal it was started from.")
    );
    assert_eq!(line(&RunLog::Off).as_deref(), Some("No log file for this run, this build does not keep one."));
    let failed = RunLog::Failed("Access is denied. (os error 5) at /home/user/.local/share".to_string());
    assert_eq!(
        line(&failed).as_deref(),
        Some("No log file for this run, it could not be opened: Access is denied. (os error 5) at /home/[REDACTED]/.local/share")
    );
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn a_run_writing_to_a_log_that_is_still_empty_gives_none() {
    let dir = scratch("log-tail-run-empty");
    fs::create_dir_all(&dir).unwrap();
    assert_eq!(tail_for_run(&RunLog::ToFile(dir.join(NAME)), 64), None);
    fs::write(dir.join(NAME), "first line\n").unwrap();
    assert_eq!(tail_for_run(&RunLog::ToFile(dir.join(NAME)), 64).as_deref(), Some("first line\n"));
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}
