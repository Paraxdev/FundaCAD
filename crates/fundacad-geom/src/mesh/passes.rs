//! Plugin mesh passes at tessellation time, the engine half of
//! `plugin_geometry.resolve` and `displace`.
//!
//! A pass owns whole faces of the FINAL shape: it gets one face's triangles
//! and hands back its own, which take that face's place in the payload. The
//! replacement triangles keep the face id they replace, so picking, face
//! colours and face bands go on meaning the same thing.

use std::collections::HashMap;

use super::tessellate::Tessellation;

/// One face's triangles, unwelded, with its normals when the display
/// tessellation produced them.
pub struct FaceMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub normals: Vec<f32>,
}

/// The triangles of one face, indices rebased on the face's own vertices.
pub fn face_mesh(tess: &Tessellation, face: u32) -> Option<FaceMesh> {
    let mut map: HashMap<u32, u32> = HashMap::new();
    let mut out = FaceMesh {
        positions: Vec::new(),
        indices: Vec::new(),
        normals: Vec::new(),
    };
    for (t, &fid) in tess.face_ids.iter().enumerate() {
        if fid != face {
            continue;
        }
        for k in 0..3 {
            let old = tess.indices[t * 3 + k];
            let next = u32::try_from(out.positions.len() / 3).ok()?;
            let new = *map.entry(old).or_insert_with(|| {
                let o = old as usize * 3;
                out.positions.extend_from_slice(&tess.positions[o..o + 3]);
                if let Some(n) = &tess.normals {
                    out.normals.extend(n[o..o + 3].iter().map(|&v| v as f32));
                }
                next
            });
            out.indices.push(new);
        }
    }
    (!out.indices.is_empty()).then_some(out)
}

/// The tessellation with every displaced face's triangles swapped in.
pub fn apply(tess: Tessellation, displaced: &HashMap<usize, FaceMesh>) -> Tessellation {
    if displaced.is_empty() {
        return tess;
    }
    let want_normals = tess.normals.is_some();
    let mut out = Tessellation {
        positions: Vec::with_capacity(tess.positions.len()),
        indices: Vec::with_capacity(tess.indices.len()),
        face_ids: Vec::with_capacity(tess.face_ids.len()),
        normals: want_normals.then(Vec::new),
    };
    let mut carry: HashMap<u32, u32> = HashMap::new();
    for (t, &fid) in tess.face_ids.iter().enumerate() {
        if displaced.contains_key(&(fid as usize)) {
            continue;
        }
        for k in 0..3 {
            let old = tess.indices[t * 3 + k];
            let new = *carry.entry(old).or_insert_with(|| {
                let o = old as usize * 3;
                let next = (out.positions.len() / 3) as u32;
                out.positions.extend_from_slice(&tess.positions[o..o + 3]);
                if let (Some(dst), Some(src)) = (out.normals.as_mut(), tess.normals.as_ref()) {
                    dst.extend_from_slice(&src[o..o + 3]);
                }
                next
            });
            out.indices.push(new);
        }
        out.face_ids.push(fid);
    }
    let mut faces: Vec<&usize> = displaced.keys().collect();
    faces.sort_unstable();
    for face in faces {
        let m = &displaced[face];
        let base = (out.positions.len() / 3) as u32;
        out.positions.extend_from_slice(&m.positions);
        if let Some(dst) = out.normals.as_mut() {
            let n = m.positions.len();
            if m.normals.len() == n {
                dst.extend(m.normals.iter().map(|&v| f64::from(v)));
            } else {
                dst.extend(std::iter::repeat(0.0).take(n));
            }
        }
        for tri in m.indices.chunks_exact(3) {
            for &i in tri {
                out.indices.push(base + i);
            }
            out.face_ids.push(*face as u32);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_faces() -> Tessellation {
        Tessellation {
            positions: vec![
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, // face 0
                0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0, // face 1
            ],
            indices: vec![0, 1, 2, 3, 4, 5],
            face_ids: vec![0, 1],
            normals: None,
        }
    }

    #[test]
    fn one_face_comes_out_rebased() {
        let m = face_mesh(&two_faces(), 1).expect("face 1 has triangles");
        assert_eq!(m.indices, vec![0, 1, 2]);
        assert_eq!(m.positions, vec![0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0]);
        assert!(face_mesh(&two_faces(), 7).is_none());
    }

    #[test]
    fn a_displaced_face_replaces_its_triangles_and_keeps_its_id() {
        let mut displaced = HashMap::new();
        displaced.insert(
            1,
            FaceMesh {
                positions: vec![0.0, 0.0, 2.0, 1.0, 0.0, 2.0, 0.0, 1.0, 2.0, 1.0, 1.0, 2.0],
                indices: vec![0, 1, 2, 1, 3, 2],
                normals: Vec::new(),
            },
        );
        let out = apply(two_faces(), &displaced);
        assert_eq!(out.face_ids, vec![0, 1, 1]);
        assert_eq!(out.positions.len() / 3, 3 + 4);
        assert_eq!(out.indices, vec![0, 1, 2, 3, 4, 5, 4, 6, 5]);
        assert!(out.indices.iter().all(|&i| (i as usize) < out.positions.len() / 3));
    }
}
