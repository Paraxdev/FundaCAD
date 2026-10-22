//! A release app's stdout and stderr reach no one (a GUI subsystem process has no std handles), so they go to
//! fundacad.log. Each start appends, and at `CAP` it rotates to fundacad.1.log and on, keeping at most `KEEP` files.

use std::fs::{self, File, OpenOptions};
use std::io::{self, IsTerminal, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const NAME: &str = "fundacad.log";
pub const CAP: u64 = 4 << 20;
const KEEP: usize = 3;
// The one older log macOS builds kept before the rotation.
const OLD: &str = "fundacad.old.log";
// A run that writes past CAP rotates within this long, so one chatty run stays bounded too.
const WATCH: Duration = Duration::from_secs(60);

fn generation(dir: &Path, n: usize) -> PathBuf {
    match n {
        0 => dir.join(NAME),
        n => dir.join(format!("fundacad.{n}.log")),
    }
}

/// The log in `dir` to append to, after moving it and the older ones down once it reached `cap`.
pub fn open(dir: &Path, cap: u64) -> io::Result<(PathBuf, File)> {
    fs::create_dir_all(dir)?;
    if !generation(dir, 1).exists() {
        let _ = fs::rename(dir.join(OLD), generation(dir, 1));
    }
    let path = generation(dir, 0);
    if fs::metadata(&path).is_ok_and(|m| m.len() >= cap) {
        for n in (1..KEEP).rev() {
            let _ = fs::rename(generation(dir, n - 1), generation(dir, n));
        }
    }
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((path, file))
}

/// Unless stderr is a terminal, where whoever started the app reads it. The engine relay and [frames] lines are stderr.
pub fn redirect(dir: &Path) -> io::Result<Option<PathBuf>> {
    if io::stderr().is_terminal() {
        return Ok(None);
    }
    let path = start(dir, CAP)?;
    let dir = dir.to_path_buf();
    let _ = std::thread::Builder::new().name("log-rotate".into()).spawn(move || loop {
        std::thread::sleep(WATCH);
        if let Err(e) = rotate_if_over(&dir, CAP) {
            eprintln!("[log] could not start a fresh log in {}: {e}", dir.display());
        }
    });
    Ok(Some(path))
}

pub fn start(dir: &Path, cap: u64) -> io::Result<PathBuf> {
    let (path, file) = open(dir, cap)?;
    point_std_at(&path, file)?;
    Ok(path)
}

pub fn rotate_if_over(dir: &Path, cap: u64) -> io::Result<bool> {
    if !fs::metadata(generation(dir, 0)).is_ok_and(|m| m.len() >= cap) {
        return Ok(false);
    }
    start(dir, cap).map(|_| true)
}

/// The last `max` bytes of the log, reaching back into the rotated ones, from
/// a line start and with user names hidden. None while there is no log.
pub fn tail(dir: &Path, max: u64) -> Option<String> {
    let mut chunks = Vec::new();
    let (mut left, mut cut) = (max, false);
    for n in 0..KEEP {
        let Ok(mut file) = File::open(generation(dir, n)) else { continue };
        let len = file.metadata().map_or(0, |m| m.len());
        let from = len - len.min(left);
        // One byte before the cut tells whether it falls on a line start.
        let back = u64::from(from > 0);
        let mut buf = Vec::new();
        if file.seek(SeekFrom::Start(from - back)).is_err()
            || file.take(len - from + back).read_to_end(&mut buf).is_err()
        {
            continue;
        }
        left -= len - from;
        cut = from > 0;
        chunks.push(buf);
        if left == 0 {
            break;
        }
    }
    let mut bytes: Vec<u8> = chunks.into_iter().rev().flatten().collect();
    if cut {
        let first_line = bytes.iter().position(|&b| b == b'\n').map_or(0, |i| i + 1);
        bytes.drain(..first_line);
    }
    (!bytes.is_empty()).then(|| redact_user_paths(&String::from_utf8_lossy(&bytes)))
}

/// Where this run's output went, kept at setup so a report never passes off the last run's log as this one's.
pub enum RunLog {
    ToFile(PathBuf),
    Terminal,
    Off,
    Failed(String),
}

pub fn tail_for_run(run: &RunLog, max: u64) -> Option<String> {
    let line = match run {
        RunLog::ToFile(path) => return tail(path.parent()?, max),
        RunLog::Terminal => "No log file for this run, it writes to the terminal it was started from.".to_string(),
        RunLog::Off => "No log file for this run, this build does not keep one.".to_string(),
        RunLog::Failed(e) => redact_user_paths(&format!("No log file for this run, it could not be opened: {e}")),
    };
    Some(line)
}

/// Hides the name in `\Users\<name>`, `/Users/<name>` and `/home/<name>`, from
/// any machine, since a log can carry a path someone else pasted.
pub fn redact_user_paths(text: &str) -> String {
    let unix_end = |c: char| matches!(c, '/' | '\\' | '"' | '\'') || c.is_whitespace();
    // A Windows profile folder may hold spaces, a Unix user name does not.
    let s = redact_after(text, r"\users\", |c| matches!(c, '/' | '\\' | '"' | '\'' | '\n' | '\r'));
    let s = redact_after(&s, "/home/", unix_end);
    redact_after(&s, "/users/", unix_end)
}

fn redact_after(text: &str, needle: &str, ends: impl Fn(char) -> bool) -> String {
    // ASCII lowering keeps every byte where it was, so its offsets index `text`.
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(at) = lower[i..].find(needle) {
        let name = i + at + needle.len();
        out.push_str(&text[i..name]);
        let len = text[name..].find(&ends).unwrap_or(text.len() - name);
        if len > 0 {
            out.push_str("[REDACTED]");
        }
        i = name + len;
    }
    out.push_str(&text[i..]);
    out
}

#[cfg(unix)]
fn point_std_at(_path: &Path, file: File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // libc's own, so this file builds alone with rustc for the CI step.
    extern "C" {
        fn dup2(src: i32, dst: i32) -> i32;
    }
    let _ = io::stdout().flush();
    let fd = file.as_raw_fd();
    // SAFETY: dup2 on the process's own standard descriptors, which keep the
    // file open once `file` drops.
    if unsafe { dup2(fd, 1) } < 0 || unsafe { dup2(fd, 2) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Rust reads the std handles on every write, the C runtime keeps its own
/// streams and descriptors, so both are pointed at the log.
#[cfg(windows)]
fn point_std_at(path: &Path, file: File) -> io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::IntoRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetStdHandle(id: u32, handle: *mut c_void) -> i32;
    }
    extern "C" {
        fn __acrt_iob_func(index: u32) -> *mut c_void;
        fn _wfreopen(path: *const u16, mode: *const u16, stream: *mut c_void) -> *mut c_void;
        fn setvbuf(stream: *mut c_void, buf: *mut u8, mode: i32, size: usize) -> i32;
        fn _fileno(stream: *mut c_void) -> i32;
        fn _open_osfhandle(handle: isize, flags: i32) -> i32;
        fn _dup2(src: i32, dst: i32) -> i32;
        fn _close(fd: i32) -> i32;
    }
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const O_APPEND_BINARY: i32 = 0x0008 | 0x8000;
    const IONBF: i32 = 4;
    let _ = io::stdout().flush();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mode: Vec<u16> = "ab".encode_utf16().chain([0]).collect();
    let crt = OpenOptions::new().append(true).open(path)?.into_raw_handle();
    // SAFETY: the CRT's own standard streams and descriptors. The Rust side handle is leaked on purpose, as a writer
    // may still hold it from GetStdHandle when the next rotation replaces it.
    unsafe {
        let fd = _open_osfhandle(crt as isize, O_APPEND_BINARY);
        if fd < 0 {
            return Err(io::Error::other("the C runtime took no descriptor for the log"));
        }
        for index in [1, 2] {
            let stream = __acrt_iob_func(index);
            // Measured in a GUI subsystem build: these streams start on descriptor -2, which
            // no _dup2 reaches, so they are reopened once to get a real one.
            if _fileno(stream) < 0 && _wfreopen(wide.as_ptr(), mode.as_ptr(), stream).is_null() {
                return Err(io::Error::last_os_error());
            }
            setvbuf(stream, std::ptr::null_mut(), IONBF, 0);
            // _wfreopen's own handle denies the rename a rotation needs, so it is replaced too.
            if _dup2(fd, _fileno(stream)) < 0 || _dup2(fd, index as i32) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        _close(fd);
        let handle = file.into_raw_handle();
        if SetStdHandle(STD_OUTPUT_HANDLE, handle) == 0 || SetStdHandle(STD_ERROR_HANDLE, handle) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "log_file_tests.rs"]
mod tests;
