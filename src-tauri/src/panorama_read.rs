//! A dropped or picked panorama, read by path for the page. On Linux the page gets no File object for a drop, and the
//! fs plugin stays closed to it, so this is the one way those bytes reach it.

use std::io::Read;
use std::path::Path;

use crate::doc_paths::Provenance;

/// Past this an .hdr or .exr is not a panorama a viewport can light with.
pub const MAX_PANORAMA_BYTES: u64 = 512 * 1024 * 1024;

fn is_panorama_name(raw: &str) -> bool {
    Path::new(raw)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("hdr") || e.eq_ignore_ascii_case("exr"))
}

pub fn read_panorama(held: &Provenance, raw: &str, cap: u64) -> Result<Vec<u8>, String> {
    if !is_panorama_name(raw) {
        return Err(format!("{raw} is not an .hdr or .exr panorama, so it was not read."));
    }
    let path = held.check_read_vouched(raw)?;
    let too_big = || format!("{raw} is larger than {} MB, too big to use as an environment.", cap / (1024 * 1024));
    let file = std::fs::File::open(&path).map_err(|e| format!("{raw}: {e}"))?;
    if file.metadata().map_err(|e| format!("{raw}: {e}"))?.len() > cap {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    // One past the cap, so a file that grows after the size check is still refused.
    file.take(cap + 1).read_to_end(&mut bytes).map_err(|e| format!("{raw}: {e}"))?;
    if bytes.len() as u64 > cap {
        return Err(too_big());
    }
    Ok(bytes)
}

/// The bytes of a panorama the person dropped or picked, as the raw IPC body.
#[tauri::command]
pub async fn read_dropped_panorama(
    held: tauri::State<'_, Provenance>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let held = held.inner();
    read_panorama(held, &path, MAX_PANORAMA_BYTES).map(tauri::ipc::Response::new)
}

#[cfg(test)]
#[path = "panorama_read_tests.rs"]
mod tests;
