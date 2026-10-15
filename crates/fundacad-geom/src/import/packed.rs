//! STEP files that come gzip (.stpz, .step.gz, what FreeCAD and KiCad write)
//! or zipped, unpacked to a temp file the STEP reader opens.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// An unpacked STEP file, removed when this drops.
pub struct Unpacked {
    path: PathBuf,
}

impl Unpacked {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Unpacked {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

const PREFIX: &str = "fundacad-unpacked-";

/// Unpacked files a killed engine left behind. An hour is far past any read,
/// so a file that old is not one another engine is still reading.
fn sweep_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let hour = std::time::Duration::from_secs(3600);
    for entry in entries.flatten() {
        let stale = entry.file_name().to_string_lossy().starts_with(PREFIX)
            && entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age > hour));
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn temp_step() -> Result<(Unpacked, File), String> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir();
    sweep_stale(&dir);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let failed = |e: std::io::Error| format!("couldn't unpack the STEP file into the temp folder ({e})");
    for tries_left in (0..16).rev() {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("{PREFIX}{}-{nanos:08x}-{n}.step", std::process::id()));
        match File::create_new(&path) {
            Ok(file) => return Ok((Unpacked { path }, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && tries_left > 0 => {}
            Err(e) => return Err(failed(e)),
        }
    }
    unreachable!("the last try returns")
}

fn too_large(cap: u64) -> String {
    format!("the file unpacks past {} MiB, too large to import", cap / (1024 * 1024))
}

fn copy_capped(from: impl Read, cap: u64) -> Result<Unpacked, String> {
    let (unpacked, mut file) = temp_step()?;
    let n = std::io::copy(&mut from.take(cap.saturating_add(1)), &mut file)
        .map_err(|e| format!("couldn't unpack this STEP file ({e})"))?;
    if n > cap {
        return Err(too_large(cap));
    }
    file.flush().map_err(|e| format!("couldn't unpack this STEP file ({e})"))?;
    Ok(unpacked)
}

fn is_step_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".step") || lower.ends_with(".stp")
}

/// The STEP file inside `path` when it is gzip or zip, `None` when it is
/// plain. A zip gives its one STEP entry, or its one file when no name says
/// STEP.
pub fn unpack_step(path: &Path, cap: u64) -> Result<Option<Unpacked>, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 4];
    let got = file.read(&mut magic).map_err(|e| e.to_string())?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    if got >= 2 && magic[..2] == [0x1f, 0x8b] {
        return copy_capped(flate2::read::MultiGzDecoder::new(std::io::BufReader::new(file)), cap).map(Some);
    }
    if got < 4 || magic != *b"PK\x03\x04" {
        return Ok(None);
    }
    let mut z = zip::ZipArchive::new(file).map_err(|e| format!("couldn't open this zip file ({e})"))?;
    let files: Vec<String> = z.file_names().filter(|n| !n.ends_with('/')).map(str::to_string).collect();
    let steps: Vec<&String> = files.iter().filter(|n| is_step_name(n)).collect();
    let name = match (steps.as_slice(), files.as_slice()) {
        ([one], _) => (*one).clone(),
        ([], [only]) => only.clone(),
        ([], _) => return Err("this zip holds no STEP file".into()),
        _ => return Err(format!("this zip holds {} STEP files, unpack it and import one", steps.len())),
    };
    let entry = z.by_name(&name).map_err(|e| format!("couldn't unpack {name} from the zip ({e})"))?;
    copy_capped(entry, cap).map(Some)
}
