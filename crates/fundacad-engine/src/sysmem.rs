//! Available physical memory, replaces the Python engine's `sysmem.py`.
//!
//! Every probe answers None rather than guessing: an unknown figure must leave
//! the caller free to proceed, since refusing an import on a probe that failed
//! is worse than the out of memory kill it was meant to prevent.

use sysinfo::{MemoryRefreshKind, RefreshKind, System};

/// Memory that can plausibly be allocated right now, in bytes. sysinfo reads
/// MemAvailable on Linux (not MemFree, which leaves out reclaimable page
/// cache), free plus reclaimable pages on macOS and `ullAvailPhys` on Windows,
/// the same sources sysmem.py reads.
pub fn available_bytes() -> Option<u64> {
    let sys = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn this_machine_reports_some_memory() {
        let got = available_bytes().expect("a probe on a supported platform");
        assert!(got > 16 * MIB, "{got}");
    }

    #[test]
    fn describe_matches_sysmem_py() {
        assert_eq!(describe(512), "512 B");
        assert_eq!(describe(2048), "2 KiB");
        assert_eq!(describe(5 * MIB), "5 MiB");
        assert_eq!(describe(1932735283), "1.8 GiB");
    }

    #[test]
    fn an_import_that_fits_proceeds_and_one_that_does_not_is_named() {
        assert!(refuse_if_memory_is_short(100 * MIB, Some(64 * 1024 * MIB)).is_ok());
        let err = refuse_if_memory_is_short(356 * MIB, Some(2 * 1024 * MIB)).unwrap_err();
        assert!(err.starts_with("not enough memory to import this file"), "{err}");
        assert!(err.contains("3.5 GiB") && err.contains("2.0 GiB"), "{err}");
    }

    #[test]
    fn the_headroom_is_part_of_the_refusal() {
        let size = 100 * MIB;
        let need = size * IMPORT_RSS_PER_FILE_BYTE;
        assert!(refuse_if_memory_is_short(size, Some(need)).is_err());
        assert!(refuse_if_memory_is_short(size, Some(need + need / 4)).is_ok());
    }

    #[test]
    fn an_empty_file_is_never_refused() {
        assert!(refuse_if_memory_is_short(0, Some(0)).is_ok());
    }
}
