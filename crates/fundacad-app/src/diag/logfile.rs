//! The app log, FundaCAD 1's src-tauri/src/log_file.rs: `fundacad.log` in the app's log folder, started fresh once it
//! passes 4 MB, with two older generations kept. Every record also goes to stderr and to the ring the console shows.

#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

pub const NAME: &str = "fundacad.log";
pub const CAP: u64 = 4 << 20;
pub const KEEP: usize = 3;
/// Tests and test runs point this at a temp folder, so they never write the real log.
pub const DIR_ENV: &str = "FUNDA_LOG_DIR";
const RING: usize = 500;
const APP_DIR: &str = "FundaCAD 2";

/// Where FundaCAD 1 kept its log (Tauri's app_log_dir), under FundaCAD 2's own name.
pub fn log_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(DIR_ENV).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    if cfg!(target_os = "macos") {
        return dirs::home_dir().map(|h| h.join("Library/Logs").join(APP_DIR));
    }
    dirs::data_local_dir().map(|d| d.join(APP_DIR).join("logs"))
}

pub fn generation(dir: &Path, n: usize) -> PathBuf {
    match n {
        0 => dir.join(NAME),
        n => dir.join(format!("fundacad.{n}.log")),
    }
}

fn shift(dir: &Path) {
    for n in (1..KEEP).rev() {
        let _ = fs::rename(generation(dir, n - 1), generation(dir, n));
    }
}

pub struct LogFile {
    dir: PathBuf,
    cap: u64,
    file: File,
    len: u64,
}

impl LogFile {
    /// A log already over `cap` from the last run is moved down a generation first.
    pub fn open(dir: &Path, cap: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = generation(dir, 0);
        if fs::metadata(&path).is_ok_and(|m| m.len() >= cap) {
            shift(dir);
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let len = file.metadata().map_or(0, |m| m.len());
        Ok(Self { dir: dir.to_path_buf(), cap, file, len })
    }

    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        if self.len >= self.cap {
            shift(&self.dir);
            self.file = OpenOptions::new().create(true).append(true).open(generation(&self.dir, 0))?;
            self.len = 0;
        }
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.len += line.len() as u64 + 1;
        Ok(())
    }
}

/// The last `max` bytes across the generations, from a line start, with user names hidden.
pub fn tail(dir: &Path, max: u64) -> Option<String> {
    let mut chunks = Vec::new();
    let (mut left, mut cut) = (max, false);
    for n in 0..KEEP {
        let Ok(mut file) = File::open(generation(dir, n)) else { continue };
        let len = file.metadata().map_or(0, |m| m.len());
        let from = len - len.min(left);
        // One byte more than kept, so a cut that falls on a line start keeps that line.
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
        let first_line = bytes.iter().position(|&b| b == b'\n').map_or(bytes.len(), |i| i + 1);
        bytes.drain(..first_line);
    }
    (!bytes.is_empty()).then(|| super::report::redact(&String::from_utf8_lossy(&bytes)))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub level: log::Level,
    pub text: String,
}

struct Logger {
    start: Instant,
    file: Mutex<Option<LogFile>>,
    ring: Mutex<VecDeque<Line>>,
}

/// A panic hook logs from the panicking thread, which may already hold the lock, so it never waits then.
fn guard<T>(m: &Mutex<T>) -> Option<std::sync::MutexGuard<'_, T>> {
    if std::thread::panicking() {
        m.try_lock().ok()
    } else {
        Some(m.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }
}

static LOGGER: OnceLock<Logger> = OnceLock::new();
static WRITTEN: AtomicUsize = AtomicUsize::new(0);

impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }

    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let text = format!("{:>8.3} [{}] {}", self.start.elapsed().as_secs_f64(), r.level(), r.args());
        // Note: a windows_subsystem build has no stderr, writing to it then fails and that is fine.
        let _ = writeln!(io::stderr(), "{text}");
        if let Some(mut file) = guard(&self.file) {
            if let Some(f) = file.as_mut() {
                let _ = f.write_line(&text);
            }
        }
        if let Some(mut ring) = guard(&self.ring) {
            if ring.len() == RING {
                ring.pop_front();
            }
            ring.push_back(Line { level: r.level(), text });
        }
        WRITTEN.fetch_add(1, Ordering::Relaxed);
    }

    fn flush(&self) {}
}

/// Starts the logger, the file when the log folder can be written.
pub fn start() {
    let dir = log_dir();
    let file = dir.as_deref().and_then(|d| LogFile::open(d, CAP).ok());
    let opened = file.is_some();
    let logger = LOGGER.get_or_init(|| Logger {
        start: Instant::now(),
        file: Mutex::new(file),
        ring: Mutex::new(VecDeque::new()),
    });
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    match (dir, opened) {
        (Some(d), true) => log::info!("FundaCAD {} log in {}", env!("CARGO_PKG_VERSION"), d.display()),
        (Some(d), false) => log::warn!("the log file in {} could not be opened", d.display()),
        (None, _) => log::warn!("this system names no folder for the log file"),
    }
}

/// This run's lines, oldest first.
pub fn lines() -> Vec<Line> {
    LOGGER.get().and_then(|l| l.ring.lock().ok().map(|r| r.iter().cloned().collect())).unwrap_or_default()
}

/// How many lines this run wrote, so a view can tell when to redraw.
pub fn written() -> usize {
    WRITTEN.load(Ordering::Relaxed)
}
