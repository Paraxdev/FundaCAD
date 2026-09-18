//! Plugin mesh passes at tessellation time, the engine half of
//! `plugin_geometry.resolve` and `displace`.
//!
//! A pass owns whole faces of the FINAL shape: it reads one face's stored
//! triangulation and hands back its own, which takes that face's place in the
//! body mesh, in face order, as `tessellate.py` appends it. The replacement
//! triangles keep the face id they replace, so picking, face colours and face
//! bands go on meaning the same thing.

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
    out.face_ids
        .extend(std::iter::repeat(fid).take(m.indices.len() / 3));
}

/// `faceColorSlots`: the `colorSlot` of the spec that claimed each face, in
/// face order, `None` when no claimed face carries one.
pub fn face_color_slots<'a>(
    face_count: usize,
    spec_of: impl Fn(usize) -> Option<&'a Value>,
) -> Option<Vec<Value>> {
    let slots: Vec<Value> = (0..face_count)
        .map(|k| {
            spec_of(k)
                .and_then(|s| s.get("colorSlot"))
                .cloned()
                .unwrap_or(Value::Null)
        })
        .collect();
    slots.iter().any(|v| !v.is_null()).then_some(slots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_displaced_face_lands_in_order_under_its_own_id() {
        let mut out = Tessellation {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            indices: vec![0, 1, 2],
            face_ids: vec![0],
            normals: Some(vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
        };
        let m = FaceMesh {
            positions: vec![0.0, 0.0, 2.0, 1.0, 0.0, 2.0, 0.0, 1.0, 2.0, 1.0, 1.0, 2.0],
            indices: vec![0, 1, 2, 1, 3, 2],
            normals: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        };
        append(&mut out, 1, &m, true);
        assert_eq!(out.face_ids, vec![0, 1, 1]);
        assert_eq!(out.indices, vec![0, 1, 2, 3, 4, 5, 4, 6, 5]);
        assert_eq!(out.normals.as_ref().map(Vec::len), Some(out.positions.len()));
    }

    #[test]
    fn color_slots_only_when_a_face_carries_one() {
        let a = json!({"pass": "p"});
        let b = json!({"pass": "p", "colorSlot": 2});
        assert_eq!(face_color_slots(3, |k| (k == 1).then_some(&a)), None);
        assert_eq!(
            face_color_slots(3, |k| (k == 2).then_some(&b)),
            Some(vec![Value::Null, Value::Null, json!(2)])
        );
    }
}
