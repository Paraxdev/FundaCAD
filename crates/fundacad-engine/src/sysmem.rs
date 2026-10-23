//! Available physical memory. Every probe answers None rather than guessing: refusing an import on a failed probe is
//! worse than the out of memory kill the refusal is meant to prevent.

use sysinfo::{MemoryRefreshKind, RefreshKind, System};

/// Memory that can plausibly be allocated now, in bytes: MemAvailable on Linux (MemFree leaves out reclaimable page
/// cache), free plus reclaimable pages on macOS, `ullAvailPhys` on Windows.
pub fn available_bytes() -> Option<u64> {
    let sys = System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()));
    if sys.total_memory() == 0 {
        return None;
    }
    Some(sys.available_memory())
}

/// A human size for an error message, "1.8 GiB", `sysmem.describe`.
pub fn describe(nbytes: u64) -> String {
    let mut n = nbytes as f64;
    for unit in ["B", "KiB", "MiB"] {
        if n < 1024.0 {
            return format!("{n:.0} {unit}");
        }
        n /= 1024.0;
    }
    format!("{n:.1} GiB")
}

/// `mesh_import.IMPORT_RSS_PER_FILE_BYTE`: peak resident bytes per file byte
/// while a large import is read and canonicalised.
pub const IMPORT_RSS_PER_FILE_BYTE: u64 = 10;
const MEMORY_HEADROOM: f64 = 1.25;

/// `mesh_import._refuse_if_memory_is_short`: the refusal for an import that
/// plainly will not fit, before the kernel starts on it. `available` None means
/// probe now.
pub fn refuse_if_memory_is_short(size: u64, available: Option<u64>) -> Result<(), String> {
    if size == 0 {
        return Ok(());
    }
    let Some(available) = available.or_else(available_bytes) else {
        return Ok(());
    };
    let need = size.saturating_mul(IMPORT_RSS_PER_FILE_BYTE);
    if need as f64 * MEMORY_HEADROOM <= available as f64 {
        return Ok(());
    }
    Err(format!(
        "not enough memory to import this file, it needs about {} and only {} is free. \
         Close some applications and try again, or import a smaller file.",
        describe(need),
        describe(available)
    ))
}
