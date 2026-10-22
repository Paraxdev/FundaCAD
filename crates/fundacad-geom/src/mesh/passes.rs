//! Plugin mesh passes at tessellation time. A pass replaces whole faces of the final shape in face order,
//! keeping each face id so picking, face colours and face bands mean the same thing.

use serde_json::Value;

use super::tessellate::Tessellation;

/// One face's triangles, with one normal per vertex or none.
pub struct FaceMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub normals: Vec<f32>,
}

/// A displaced face's triangles appended to `out` under face id `fid`. With
/// `display` its normals go along, zeros for a pass that gave none.
pub fn append(out: &mut Tessellation, fid: u32, m: &FaceMesh, display: bool) {
    let base = (out.positions.len() / 3) as u32;
    out.positions.extend_from_slice(&m.positions);
    if display {
        let dst = out.normals.get_or_insert_with(Vec::new);
        if m.normals.len() == m.positions.len() {
            dst.extend(m.normals.iter().map(|&v| f64::from(v)));
        } else {
            dst.extend(std::iter::repeat(0.0).take(m.positions.len()));
        }
    }
    out.indices.extend(m.indices.iter().map(|i| base + i));
    out.face_ids.extend(std::iter::repeat(fid).take(m.indices.len() / 3));
}

/// The `colorSlot` of the spec that claimed each face, `None` when no claimed face carries one.
pub fn face_color_slots<'a>(face_count: usize, spec_of: impl Fn(usize) -> Option<&'a Value>) -> Option<Vec<Value>> {
    let slots: Vec<Value> =
        (0..face_count).map(|k| spec_of(k).and_then(|s| s.get("colorSlot")).cloned().unwrap_or(Value::Null)).collect();
    slots.iter().any(|v| !v.is_null()).then_some(slots)
}
