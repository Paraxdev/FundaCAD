//! The app's export folder, the one place its engine may write while it runs with reduced rights. An export attached to
//! the app is written into a folder of its own there and copied to the user's path.

use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A fresh folder in `root` for one export. The app numbers its own, so a name with a prefix never meets them.
pub fn make(root: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    let dir = root.join(format!("mcp-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    // Left by an earlier process with this pid; nobody else's.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir(&dir)?;
    Ok(dir)
}

/// Whether `path` lies below `stage`, so a name in the engine's answer cannot reach a file of the user's.
pub fn inside(path: &Path, stage: &Path) -> bool {
    path.strip_prefix(stage).is_ok_and(|rest| {
        rest.components().next().is_some() && rest.components().all(|c| matches!(c, Component::Normal(_)))
    })
}

/// Moves a file the engine wrote to `to`. Out of the app's folder it is a copy to a part file renamed over `to`: a moved
/// file would keep that folder's low integrity label on Windows, and the folder may sit on another volume.
pub fn put(from: &Path, to: &Path, copy: bool) -> io::Result<()> {
    if !copy {
        return std::fs::rename(from, to);
    }
    let mut source = open_no_link(from)?;
    if !source.metadata()?.is_file() {
        return Err(io::Error::other(format!("{} is not a file", from.display())));
    }
    let name = to.file_name().ok_or_else(|| io::Error::other("the path names no file"))?.to_string_lossy();
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let part = to.with_file_name(format!(".{name}.{}.{n}.part", std::process::id()));
    let copied = File::create(&part)
        .and_then(|mut out| io::copy(&mut source, &mut out))
        .and_then(|_| std::fs::rename(&part, to));
    if copied.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    copied
}

/// A link the engine planted in its folder opens as itself, never as the file it points to.
fn open_no_link(path: &Path) -> io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    // FILE_FLAG_OPEN_REPARSE_POINT
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(&mut options, 0x0020_0000);
    options.open(path)
}
