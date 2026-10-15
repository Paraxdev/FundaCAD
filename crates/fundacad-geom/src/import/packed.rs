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

fn temp_step() -> Result<(Unpacked, File), String> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("fundacad-unpacked-{}-{n}.step", std::process::id()));
    let file = File::create(&path).map_err(|e| format!("couldn't unpack the STEP file into the temp folder ({e})"))?;
    Ok((Unpacked { path }, file))
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
