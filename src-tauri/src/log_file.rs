//! A Finder launched app's stdout and stderr go nowhere, so on macOS the app
//! writes them to fundacad.log in its log dir (~/Library/Logs/dev.fundacad.app).
//! Each start appends, so a crash loop keeps every run, and a log over
//! `CAP` bytes is moved to fundacad.old.log first.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

pub const NAME: &str = "fundacad.log";
const OLD: &str = "fundacad.old.log";
const CAP: u64 = 4 << 20;

/// The log in `dir` to append to, moved aside first once it reached `cap`.
pub fn open(dir: &Path, cap: u64) -> std::io::Result<(PathBuf, File)> {
    fs::create_dir_all(dir)?;
    let path = dir.join(NAME);
    if fs::metadata(&path).is_ok_and(|m| m.len() >= cap) {
        let _ = fs::rename(&path, dir.join(OLD));
    }
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((path, file))
}

/// Points stdout and stderr at the log, unless stderr is a terminal: then
/// whoever started the app from it reads them there. The engine relay and
/// the [frames] lines are stderr.
#[cfg(target_os = "macos")]
pub fn redirect(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    use std::io::{IsTerminal, Write};
    use std::os::fd::AsRawFd;
    // libSystem's own, so this file builds alone with rustc for the macOS CI job.
    extern "C" {
        fn dup2(src: i32, dst: i32) -> i32;
    }
    if std::io::stderr().is_terminal() {
        return Ok(None);
    }
    let (path, file) = open(dir, CAP)?;
    let _ = std::io::stdout().flush();
    let fd = file.as_raw_fd();
    // SAFETY: dup2 on the process's own standard descriptors, which keep the
    // file open once `file` drops.
    if unsafe { dup2(fd, 1) } < 0 || unsafe { dup2(fd, 2) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn each_start_appends_so_a_crash_loop_keeps_every_run() {
        let dir = std::env::temp_dir().join(format!("fundacad-log-{}", std::process::id())).join("Logs");
        let _ = fs::remove_dir_all(&dir);
        for run in ["first", "second", "third"] {
            let (path, mut f) = open(&dir, CAP).unwrap();
            assert_eq!(path.file_name().unwrap(), NAME);
            writeln!(f, "{run} run").unwrap();
        }
        assert_eq!(fs::read_to_string(dir.join(NAME)).unwrap(), "first run
second run
third run
");
        assert!(!dir.join(OLD).exists());
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_log_over_the_cap_is_kept_as_the_old_one() {
        let dir = std::env::temp_dir().join(format!("fundacad-log-cap-{}", std::process::id())).join("Logs");
        let _ = fs::remove_dir_all(&dir);
        let (_, mut f) = open(&dir, 16).unwrap();
        writeln!(f, "a long first run, past the cap").unwrap();
        drop(f);
        let (_, mut f) = open(&dir, 16).unwrap();
        writeln!(f, "second run").unwrap();
        assert_eq!(fs::read_to_string(dir.join(NAME)).unwrap(), "second run
");
        assert_eq!(fs::read_to_string(dir.join(OLD)).unwrap(), "a long first run, past the cap
");
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn redirect_sends_stdout_and_stderr_to_the_log() {
        const CHILD: &str = "FUNDACAD_LOG_FILE_CHILD";
        if let Some(dir) = std::env::var_os(CHILD) {
            redirect(Path::new(&dir)).unwrap().expect("a piped stderr is not a terminal");
            println!("to stdout");
            eprintln!("to stderr");
            return;
        }
        let dir = std::env::temp_dir().join(format!("fundacad-log-redirect-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // --nocapture, or the harness keeps println from reaching descriptor 1.
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::redirect_sends_stdout_and_stderr_to_the_log", "--nocapture"])
            .env(CHILD, &dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let log = fs::read_to_string(dir.join(NAME)).unwrap();
        assert!(log.contains("to stdout
") && log.contains("to stderr
"), "{log}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
