//! Readers refuse geometry past their budget before they allocate it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::borrow::Cow;
use std::cell::Cell;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

use fundacad_geom::import::{gltf, mesh, scan, x3d};
use serde_json::json;

#[path = "support/threemf.rs"]
mod threemf;

struct Peak;

static NOW: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);
// The counters are process wide, so one measurement runs at a time and only its thread is counted.
static SERIAL: Mutex<()> = Mutex::new(());

thread_local! {
    static MEASURED: Cell<bool> = const { Cell::new(false) };
}

fn counted() -> bool {
    MEASURED.try_with(Cell::get).unwrap_or(false)
}

fn grew(by: usize) {
    let now = NOW.fetch_add(by as isize, Ordering::Relaxed) + by as isize;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

fn shrank(by: usize) {
    NOW.fetch_sub(by as isize, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() && counted() {
            grew(l.size());
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        if counted() {
            shrank(l.size());
        }
    }

    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, size) };
        if !q.is_null() && counted() {
            grew(size);
            shrank(l.size());
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
    MEASURED.with(|m| m.set(true));
    let out = f();
    MEASURED.with(|m| m.set(false));
    (out, (PEAK.load(Ordering::Relaxed) - base) as usize)
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

fn read_3mf_part(tag: &str, zip: Vec<u8>) -> (Result<usize, String>, usize) {
    let dir = std::env::temp_dir().join(format!("fundacad-3mf-peak-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("part.3mf");
    std::fs::write(&path, zip).unwrap();
    let out = peak_of(|| mesh::read_triangles(&path, "3mf").map(|(_, idx)| idx.len()));
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[test]
fn a_3mf_part_of_many_small_elements_is_read_without_holding_it_whole() {
    let block = "<metadata/>".repeat(1 << 16);
    let (out, peak) = read_3mf_part("tags", threemf::repeated_part(block.as_bytes(), 300));
    assert_eq!(out, Ok(0));
    assert!(peak < 16 << 20, "{peak}");
}

#[test]
fn a_3mf_part_holding_one_long_run_of_text_is_refused_without_holding_it() {
    let (out, peak) = read_3mf_part("text", threemf::repeated_part(&[b' '; 1 << 20], 300));
    assert_eq!(out, Err("could not read the 3MF file: it holds a run of text longer than 16 MiB".to_string()));
    assert!(peak < 64 << 20, "{peak}");
}

#[test]
fn a_gltf_scene_listing_more_roots_than_the_visit_budget_is_refused_before_they_are_queued() {
    let doc = json!({
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": vec![0; 1_000_000]}],
        "nodes": [{}],
    });
    let (out, peak) = peak_of(|| gltf::read_gltf(&doc, &[Cow::Owned(Vec::new())], 1.0).err());
    assert_eq!(out.as_deref(), Some("this glTF places its nodes under too many parents to import"));
    assert!(peak < 16 << 20, "{peak}");
}

#[test]
fn a_reused_x3d_shape_keeps_only_the_points_its_triangles_use() {
    let points = "1 2 3 ".repeat(100_000);
    let xml = format!(
        "<X3D><Scene><Transform><Shape DEF=\"s\"><IndexedFaceSet coordIndex=\"0 1 2 -1\"><Coordinate point=\"{points}\"/></IndexedFaceSet></Shape>{}</Transform></Scene></X3D>",
        "<Shape USE=\"s\"/>".repeat(49)
    );
    let (out, peak) = peak_of(|| x3d::read_x3d(&xml, Some(1.0)).map(|(objs, _)| objs[0].pos.len()));
    assert_eq!(out, Ok(50 * 3 * 3));
    assert!(peak < 40 << 20, "{peak}");
}
