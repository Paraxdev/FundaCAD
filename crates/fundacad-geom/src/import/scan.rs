//! Dense meshes kept as read-only reference scans: one face that holds only
//! the file's triangles, never sewn, never in a boolean.

use std::collections::HashMap;

use opencascade::mesh_import as occ;
use opencascade::primitives::Shape;
use serde_json::{json, Map};

use super::mesh::{MeshObject, MAX_IMPORT_TRIANGLES};
use crate::export::pyfmt::thousands;

pub const MAX_SCAN_TRIANGLES: u64 = 10_000_000;

/// Peak bytes a scan import holds per triangle: the parsed f64 soup, the weld
/// map, the triangulation and its BinTools copy.
pub const SCAN_BYTES_PER_TRIANGLE: u64 = 160;

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Editable,
    Scan,
    Refused(String),
}

pub fn route(ntri: u64) -> Route {
    if ntri <= MAX_IMPORT_TRIANGLES {
        Route::Editable
    } else if ntri <= MAX_SCAN_TRIANGLES {
        Route::Scan
    } else {
        Route::Refused(too_dense_for_a_scan(ntri))
    }
}

pub fn too_dense_for_a_scan(ntri: u64) -> String {
    format!(
        "This mesh has ~{} triangles, more than a reference scan can hold (limit ~{}). Decimate it first, then import.",
        thousands(ntri as usize),
        thousands(MAX_SCAN_TRIANGLES as usize)
    )
}

/// The refusal past the scan limit, and the memory check for one below it.
pub fn admit(ntri: u64) -> Result<(), String> {
    if let Route::Refused(why) = route(ntri) {
        return Err(why);
    }
    fundacad_engine::sysmem::refuse_if_memory_is_short(ntri.saturating_mul(SCAN_BYTES_PER_TRIANGLE) / 4, None)
}

/// Shared corners merged on their f32 bits, so a soup of loose triangles
/// shades smooth, and triangles that lose a corner to the merge dropped.
pub fn weld(pos: &[f64], idx: &[u32]) -> (Vec<f64>, Vec<u32>) {
    let mut seen: HashMap<[u32; 3], u32> = HashMap::with_capacity(idx.len() / 2);
    let mut out_pos = Vec::with_capacity(idx.len());
    let mut out_idx = Vec::with_capacity(idx.len());
    let mut remap: HashMap<u32, u32> = HashMap::new();
    let soup = idx.len() == pos.len() / 3 && idx.iter().enumerate().all(|(i, &v)| v as usize == i);
    let mut key_of = |v: u32| -> Option<u32> {
        if !soup {
            if let Some(&k) = remap.get(&v) {
                return Some(k);
            }
        }
        let i = v as usize * 3;
        let p = pos.get(i..i + 3)?;
        let key = [p[0] as f32, p[1] as f32, p[2] as f32].map(|c| if c == 0.0 { 0 } else { c.to_bits() });
        let next = seen.len() as u32;
        let k = *seen.entry(key).or_insert_with(|| {
            out_pos.extend_from_slice(p);
            next
        });
        if !soup {
            remap.insert(v, k);
        }
        Some(k)
    };
    for t in idx.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (key_of(t[0]), key_of(t[1]), key_of(t[2])) else {
            continue;
        };
        if a != b && b != c && a != c {
            out_idx.extend_from_slice(&[a, b, c]);
        }
    }
    (out_pos, out_idx)
}

pub fn scan_shape(pos: &[f64], idx: &[u32]) -> Result<Shape, String> {
    let (pos, idx) = weld(pos, idx);
    if idx.is_empty() {
        return Err("no geometry found in the mesh file".into());
    }
    occ::triangulation_face(&pos, &idx).map_err(|e| format!("could not keep the mesh as a scan ({e:?})"))
}

/// Every object of a scene file in one scan, with the colour most of its triangles carry.
pub fn scan_objects(objs: Vec<MeshObject>) -> Result<super::Imported, String> {
    let color = super::mesh::dominant_color(objs.iter().flat_map(|o| std::iter::repeat_n(o.color, o.idx.len() / 3)));
    let mut pos = Vec::new();
    let mut idx = Vec::new();
    for o in objs {
        let base = (pos.len() / 3) as u32;
        let n = (o.pos.len() / 3) as u32;
        idx.extend(o.idx[..o.idx.len() / 3 * 3].iter().map(|&i| if i < n { base + i } else { u32::MAX }));
        pos.extend(o.pos);
    }
    let mut imported = scan_imported(&pos, &idx)?;
    if let Some(c) = color {
        imported.fields.insert("color".into(), json!(super::hex(c)));
    }
    Ok(imported)
}

pub fn scan_imported(pos: &[f64], idx: &[u32]) -> Result<super::Imported, String> {
    let shape = scan_shape(pos, idx)?;
    let mut fields = Map::new();
    fields.insert("scan".into(), json!(true));
    fields.insert("triangles".into(), json!(idx.len() / 3));
    Ok(super::Imported { shape, fields })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_is_decided_by_the_triangle_count() {
        assert_eq!(route(MAX_IMPORT_TRIANGLES), Route::Editable);
        assert_eq!(route(MAX_IMPORT_TRIANGLES + 1), Route::Scan);
        assert_eq!(route(MAX_SCAN_TRIANGLES), Route::Scan);
        match route(MAX_SCAN_TRIANGLES + 1) {
            Route::Refused(why) => assert!(why.contains("10,000,000"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn weld_merges_shared_corners_and_drops_collapsed_triangles() {
        let pos = [
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
        ];
        let idx: Vec<u32> = (0..9).collect();
        let (p, i) = weld(&pos, &idx);
        assert_eq!(p.len() / 3, 4);
        assert_eq!(i.len() / 3, 2);
    }
}
