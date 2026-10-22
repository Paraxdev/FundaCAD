use super::*;
use std::io::Write;
use std::process::Command;

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
    // The harness names a test without the crate: "tests::x" alone, "log_file::tests::x" in the app.
    let module = module_path!().split_once("::").unwrap().1;
    // --nocapture, or the harness keeps println from reaching descriptor 1.
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("{module}::{test}"), "--nocapture"])
        .env(CHILD, dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
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
    assert_eq!(
        listing(&dir),
        pairs(&[("fundacad.1.log", "older build\n"), (NAME, "last run\nthis run\n")])
    );
    start_run(&dir, 8, "next run");
    assert_eq!(
        listing(&dir),
        pairs(&[
            ("fundacad.1.log", "last run\nthis run\n"),
            ("fundacad.2.log", "older build\n"),
            (NAME, "next run\n"),
        ])
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
        println!("[t] first {}", "x".repeat(150));
        assert!(!rotate_if_over(dir, CAP_T).unwrap());
        println!("[t] first again");
        crt_lines("first");
        assert!(rotate_if_over(dir, CAP_T).unwrap());
        assert!(!rotate_if_over(dir, CAP_T).unwrap());
        println!("[t] second {}", "y".repeat(200));
        assert!(rotate_if_over(dir, CAP_T).unwrap());
        eprintln!("[t] third {}", "z".repeat(200));
        // The first log is still open through the leaked handle, and is dropped now.
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
    let mut names: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["fundacad.1.log", "fundacad.2.log", "fundacad.log"]);
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}
