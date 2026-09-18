//! Face triangulations into one body mesh, replaces `tessellate`,
//! `_display_face` and `mesh_bbox` of the Python engine's `tessellate.py`.
//!
//! Mesh passes (plugin displacement) are not here, they wait for the plugin
//! host.

use opencascade::mesh_access::{self, MeshAccess};
use opencascade::primitives::Shape;
use std::collections::HashMap;

/// One body's triangles. `face_ids` holds one face index per triangle, the
/// index of the face in `MeshAccess` order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tessellation {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub face_ids: Vec<u32>,
    /// Present for the display tessellation that produced at least one face.
    pub normals: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Copy)]
pub struct MeshParams {
    pub linear: f64,
    pub angular: f64,
    pub relative: bool,
    /// True surface normals and the seam weld, the viewport payload. Export
    /// leaves them off so an exported mesh is exactly the kernel's.
    pub display: bool,
    /// Drop a stored triangulation first. BRepMesh keeps a finer stored mesh
    /// for a coarser request, so a tolerance backoff needs this to coarsen.
    pub force_remesh: bool,
}

/// Mesh `shape` in parallel and read every face back, skipping a face with no
/// triangulation. A reversed face has its winding flipped so facet normals
/// point outward.
pub fn tessellate(shape: &Shape, access: &MeshAccess, params: MeshParams) -> Tessellation {
    tessellate_with(shape, access, params, None)
}

/// A mesh pass's triangles for face `fid`, or `None` to mesh it plainly.
pub type Displacer<'a> = &'a dyn Fn(usize) -> Option<super::passes::FaceMesh>;

/// `tessellate`, with every face `displace` answers for replaced in place by
/// its displaced triangles.
pub fn tessellate_with(
    shape: &Shape,
    access: &MeshAccess,
    params: MeshParams,
    displace: Option<Displacer<'_>>,
) -> Tessellation {
    crate::bench::phase("brep_mesh", || {
        mesh_access::mesh(
            shape,
            params.linear,
            params.relative,
            params.angular,
            params.force_remesh,
        )
    });
    let mut out = Tessellation::default();
    let mut normals: Option<Vec<f64>> = None;
    for fid in 0..access.face_count() {
        let Some(tri) = access.face_triangulation(fid, params.display) else {
            continue;
        };
        if let Some(m) = displace.and_then(|d| d(fid)) {
            out.normals = normals.take();
            super::passes::append(&mut out, fid as u32, &m, params.display);
            normals = out.normals.take();
            continue;
        }
        let flip = access.face_reversed(fid);
        let mut t: Vec<u32> = tri.triangles.iter().map(|&i| i.max(0) as u32).collect();
        if flip {
            for c in t.chunks_exact_mut(3) {
                c.swap(1, 2);
            }
        }
        let base = (out.positions.len() / 3) as u32;
        let ntri = t.len() / 3;
        let (pos, t) = if params.display {
            let is_plane = access.face_plane_normal(fid).is_some();
            let face = crate::bench::phase("display_face", || {
                display_face(tri.nodes, t, &tri.normals, flip, is_plane)
            });
            normals
                .get_or_insert_with(Vec::new)
                .extend_from_slice(&face.normals);
            (face.positions, face.triangles)
        } else {
            (tri.nodes, t)
        };
        out.positions.extend_from_slice(&pos);
        out.indices.extend(t.iter().map(|i| i + base));
        out.face_ids
            .extend(std::iter::repeat(fid as u32).take(ntri));
    }
    out.normals = normals;
    out
}

struct DisplayFace {
    positions: Vec<f64>,
    triangles: Vec<u32>,
    normals: Vec<f64>,
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

/// One face of the display tessellation with true surface normals and its
/// seam duplicates welded.
///
/// OCCT's computed normals follow the surface and ignore a REVERSED face, so
/// they are flipped with the winding and then checked against the winding's own
/// area weighted facet normals; a node whose normal is unsound keeps that facet
/// average, which is what the client would draw. Coincident nodes (a closed
/// face's seam copies) merge only when their normals agree, so a cone apex
/// keeps its copies, and the weld never crosses a face.
fn display_face(
    nodes: Vec<f64>,
    tris: Vec<u32>,
    surface_normals: &[f64],
    flip: bool,
    is_plane: bool,
) -> DisplayFace {
    let n = nodes.len() / 3;
    let p = |i: u32| {
        let i = i as usize * 3;
        [nodes[i], nodes[i + 1], nodes[i + 2]]
    };
    let facets: Vec<[f64; 3]> = tris
        .chunks_exact(3)
        .map(|c| cross(sub(p(c[1]), p(c[0])), sub(p(c[2]), p(c[0]))))
        .collect();

    if is_plane {
        let s = facets
            .iter()
            .fold([0.0; 3], |a, f| [a[0] + f[0], a[1] + f[1], a[2] + f[2]]);
        let ln = norm(s);
        let unit = if ln > 1e-12 {
            [s[0] / ln, s[1] / ln, s[2] / ln]
        } else {
            [0.0, 0.0, 1.0]
        };
        let normals = unit.iter().copied().cycle().take(3 * n).collect();
        return DisplayFace {
            positions: nodes,
            triangles: tris,
            normals,
        };
    }

    let mut acc = vec![[0.0f64; 3]; n];
    for (c, f) in tris.chunks_exact(3).zip(&facets) {
        for &v in c {
            let a = &mut acc[v as usize];
            a[0] += f[0];
            a[1] += f[1];
            a[2] += f[2];
        }
    }
    for a in &mut acc {
        let ln = norm(*a);
        let d = if ln < 1e-12 { 1.0 } else { ln };
        *a = [a[0] / d, a[1] / d, a[2] / d];
    }

    let mut nn: Vec<[f64; 3]> = if surface_normals.len() == 3 * n {
        let sign = if flip { -1.0 } else { 1.0 };
        surface_normals
            .chunks_exact(3)
            .map(|c| [sign * c[0], sign * c[1], sign * c[2]])
            .collect()
    } else {
        acc.clone()
    };
    let agreement: f64 = nn.iter().zip(&acc).map(|(a, b)| dot(*a, *b)).sum();
    if agreement < 0.0 {
        for v in &mut nn {
            *v = [-v[0], -v[1], -v[2]];
        }
    }
    for (v, a) in nn.iter_mut().zip(&acc) {
        let bad =
            !v.iter().all(|x| x.is_finite()) || (norm(*v) - 1.0).abs() > 1e-3 || dot(*v, *a) < 0.0;
        if bad {
            *v = *a;
        }
    }

    let (positions, triangles, nn) = weld(nodes, tris, nn);
    DisplayFace {
        positions,
        triangles,
        normals: nn.iter().flatten().copied().collect(),
    }
}

/// numpy's `round(x, 6)`, half to even on the scaled value, with -0.0 folded
/// into 0.0 so the two hash alike.
fn weld_key(v: f64) -> u64 {
    ((v * 1e6).round_ties_even() / 1e6 + 0.0).to_bits()
}

fn weld(nodes: Vec<f64>, tris: Vec<u32>, nn: Vec<[f64; 3]>) -> (Vec<f64>, Vec<u32>, Vec<[f64; 3]>) {
    let n = nn.len();
    let mut first: HashMap<[u64; 3], usize> = HashMap::with_capacity(n);
    let mut rep = Vec::with_capacity(n);
    for (i, c) in nodes.chunks_exact(3).enumerate() {
        let key = [weld_key(c[0]), weld_key(c[1]), weld_key(c[2])];
        let r = *first.entry(key).or_insert(i);
        rep.push(r);
    }
    if first.len() == n {
        return (nodes, tris, nn);
    }
    for i in 0..n {
        if dot(nn[i], nn[rep[i]]) <= 0.9999 {
            rep[i] = i;
        }
    }
    let mut remap = vec![0u32; n];
    let mut positions = Vec::with_capacity(nodes.len());
    let mut kept = Vec::with_capacity(n);
    for i in 0..n {
        if rep[i] == i {
            remap[i] = kept.len() as u32;
            positions.extend_from_slice(&nodes[3 * i..3 * i + 3]);
            kept.push(nn[i]);
        }
    }
    for i in 0..n {
        remap[i] = remap[rep[i]];
    }
    let triangles = tris.iter().map(|&v| remap[v as usize]).collect();
    (positions, triangles, kept)
}

/// The box of the vertices sent, what the viewport draws; the triangulation's
/// `BRepBndLib` box only for a body with no vertices.
pub fn mesh_bbox(shape: &Shape, positions: &[f64]) -> Option<([f64; 3], [f64; 3])> {
    if positions.len() >= 3 {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for c in positions.chunks_exact(3) {
            for k in 0..3 {
                min[k] = min[k].min(c[k]);
                max[k] = max[k].max(c[k]);
            }
        }
        return Some((min, max));
    }
    mesh_access::bnd_box(shape).map(|b| ([b[0], b[1], b[2]], [b[3], b[4], b[5]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weld_merges_agreeing_copies_only() {
        // Nodes 0 and 2 coincide with the same normal, 1 and 3 coincide with
        // opposite normals, the apex case.
        let nodes = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        ];
        let up = [0.0, 0.0, 1.0];
        let nn = vec![up, up, up, [0.0, 0.0, -1.0], up];
        let (pos, tris, kept) = weld(nodes, vec![0, 1, 4, 2, 3, 4], nn);
        assert_eq!(pos.len(), 12);
        assert_eq!(kept.len(), 4);
        assert_eq!(tris, vec![0, 1, 3, 0, 2, 3]);
    }

    #[test]
    fn weld_key_rounds_half_to_even() {
        assert_eq!(weld_key(0.0000005), weld_key(0.0));
        assert_eq!(weld_key(-0.0), weld_key(0.0));
        assert_eq!(weld_key(1.0000004), weld_key(1.0));
    }
}
