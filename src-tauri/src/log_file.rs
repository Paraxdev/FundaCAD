//! A Finder launched app's stdout and stderr go nowhere, so on macOS the app
//! writes them to fundacad.log in its log dir (~/Library/Logs/dev.fundacad.app),
//! with the run before kept as fundacad.old.log.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

pub const NAME: &str = "fundacad.log";
const OLD: &str = "fundacad.old.log";

/// A fresh log in `dir`, the last run's moved aside.
pub fn open(dir: &Path) -> std::io::Result<(PathBuf, File)> {
    fs::create_dir_all(dir)?;
    let path = dir.join(NAME);
    if path.exists() {
        let _ = fs::rename(&path, dir.join(OLD));
    }
    let file = OpenOptions::new().create(true).write(true).truncate(true).open(&path)?;
    Ok((path, file))
}

/// Points stdout and stderr at the log, unless stderr is a terminal: then
/// whoever started the app from it reads them there. The engine relay and
/// the [frames] lines are stderr.
#[cfg(target_os = "macos")]
pub fn redirect(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    use std::io::Write;
    use std::os::fd::AsRawFd;
    // SAFETY: isatty and dup2 on the process's own standard descriptors.
    if unsafe { libc::isatty(2) } == 1 {
        return Ok(None);
    }
    let (path, file) = open(dir)?;
    let _ = std::io::stdout().flush();
    let fd = file.as_raw_fd();
    // SAFETY: as above; descriptors 1 and 2 keep the file open once `file` drops.
    if unsafe { libc::dup2(fd, 1) } < 0 || unsafe { libc::dup2(fd, 2) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn each_start_writes_a_fresh_log_and_keeps_the_last_one() {
        let dir = std::env::temp_dir().join(format!("fundacad-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (path, mut f) = open(&dir.join("Logs")).unwrap();
        writeln!(f, "first run").unwrap();
        drop(f);
        let (again, mut f) = open(&dir.join("Logs")).unwrap();
        writeln!(f, "second run").unwrap();
        drop(f);
        assert_eq!(path, again);
        assert_eq!(path.file_name().unwrap(), NAME);
        assert_eq!(fs::read_to_string(&path).unwrap(), "second run\n");
        assert_eq!(fs::read_to_string(dir.join("Logs").join(OLD)).unwrap(), "first run\n");
        fs::remove_dir_all(&dir).unwrap();
    }
}
