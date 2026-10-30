//! Readers refuse geometry past their budget before they allocate it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::borrow::Cow;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use fundacad_geom::import::{gltf, scan, x3d};
use serde_json::json;

struct Peak;

static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
// The counters are process wide, so one measurement runs at a time.
static SERIAL: Mutex<()> = Mutex::new(());

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
    let _one = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
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

#[test]
fn a_gltf_node_listing_more_children_than_the_visit_budget_is_refused_before_they_are_queued() {
    let doc = json!({
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"children": vec![1; 1_000_000]}, {}],
    });
    let (out, peak) = peak_of(|| gltf::read_gltf(&doc, &[Cow::Owned(Vec::new())], 1.0).err());
    assert_eq!(out.as_deref(), Some("this glTF places its nodes under too many parents to import"));
    assert!(peak < 1 << 20, "{peak}");
}
