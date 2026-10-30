//! Readers refuse geometry past their budget before they allocate it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use fundacad_geom::import::{scan, x3d};

struct Peak;

static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(by: usize) {
    let now = NOW.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            grew(l.size());
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        NOW.fetch_sub(l.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, size) };
        if !q.is_null() {
            grew(size);
            NOW.fetch_sub(l.size(), Ordering::Relaxed);
        }
        q
    }
}

#[global_allocator]
static ALLOC: Peak = Peak;

/// The most `f` held allocated at once beyond what was live before it.
fn peak_of<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let base = NOW.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let out = f();
    (out, PEAK.load(Ordering::Relaxed) - base)
}

#[test]
fn an_x3d_face_past_the_triangle_budget_is_refused_before_its_fan_is_built() {
    let corners = 10_100_000;
    let xml = format!(
        "<X3D><Scene><Shape><IndexedFaceSet coordIndex=\"{}\"><Coordinate point=\"0 0 0\"/></IndexedFaceSet></Shape></Scene></X3D>",
        "0 ".repeat(corners)
    );
    let (out, peak) = peak_of(|| x3d::read_x3d(&xml, Some(1.0)).err());
    assert_eq!(out, Some(scan::too_dense_for_a_scan(corners as u64 - 2)));
    assert!(peak < 56 * corners, "{peak}");
}
