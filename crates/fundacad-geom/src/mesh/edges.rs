//! Edge polylines for the outline pass, replaces `edge_polylines_by_body`,
//! `_edge_points` and `_meets_smoothly` of `sidecar/tessellate.py`.
//!
//! Dropped, as in any MCAD: the seam between two coplanar planar faces, the
//! wrap-around seam of a closed periodic face (one face listed twice) and a
//! degenerate edge (a pole or an apex). The sidecar's per-TShape polyline memo
//! is a cache and is not ported.

use opencascade::mesh_access::MeshAccess;

/// Chord deviation target of an edge polyline, millimetres. The sampler hits
/// it almost exactly, so it is the worst case deviation.
pub const EDGE_DEFLECTION: f64 = 0.01;
/// Segment clamps for a curved edge. Both even, so every clamped polyline keeps
/// an odd point count.
pub const EDGE_MIN_SEG: usize = 4;
pub const EDGE_MAX_SEG: usize = 512;
/// Segments of the parameter walk used when the deflection sampler cannot run.
pub const EDGE_FALLBACK_SEG: usize = 24;

/// Below this angle between the faces' normals two faces meet tangentially,
/// the boundary of a fillet rather than a corner.
pub const SMOOTH_EDGE_DEG: f64 = 1.0;

#[derive(Debug, Clone, PartialEq)]
pub struct EdgeLine {
    pub points: Vec<[f64; 3]>,
    pub smooth: bool,
}

/// Every drawn edge of one body, in edge-to-face map order.
///
/// The edges go out to other threads: each one builds its own adaptors and
/// nothing is written back to the shape, and the results are collected by edge
/// index, so the list is the one a serial walk produces.
pub fn edge_polylines(access: &MeshAccess) -> Vec<EdgeLine> {
    let cos_tol = 1.0f64.to_radians().cos();
    let plane: Vec<Option<[f64; 3]>> = (0..access.face_count())
        .map(|f| access.face_plane_normal(f))
        .collect();
    let work = crate::par::Shared((access, &plane));
    let lines = crate::par::map_indexed(access.edge_count(), move |e| {
        let (access, plane) = *work.get();
        one_edge(access, plane, cos_tol, e)
    });
    lines.into_iter().flatten().collect()
}

fn one_edge(
    access: &MeshAccess,
    plane: &[Option<[f64; 3]>],
    cos_tol: f64,
    e: usize,
) -> Option<EdgeLine> {
    let plane_of = |f: usize| plane.get(f).copied().flatten();
    let faces = access.edge_faces(e);
    if faces.len() == 2 {
        if let (Some(n0), Some(n1)) = (plane_of(faces[0]), plane_of(faces[1])) {
            if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]).abs() > cos_tol {
                return None;
            }
        }
    }
    if access.edge_degenerated(e) {
        return None;
    }
    if !faces.is_empty()
        && faces.iter().all(|&f| f == faces[0])
        && (0..faces.len()).any(|k| access.edge_closed_on(e, k))
    {
        return None;
    }
    let points = edge_points(access, e)?;
    let smooth = faces.len() == 2
        && faces[0] != faces[1]
        && !(plane_of(faces[0]).is_some() && plane_of(faces[1]).is_some())
        && access.edge_smooth(e, SMOOTH_EDGE_DEG.to_radians().cos());
    Some(EdgeLine { points, smooth })
}

/// A line is its two endpoints; any other curve is deviation bounded; an edge
/// the sampler refuses is walked by its raw parameter.
fn edge_points(access: &MeshAccess, e: usize) -> Option<Vec<[f64; 3]>> {
    if let Ok(Some(ends)) = access.edge_line(e) {
        return Some(ends.to_vec());
    }
    sample_by_deflection(access, e, EDGE_DEFLECTION, EDGE_MIN_SEG, EDGE_MAX_SEG)
        .or_else(|| uniform_param_points(access, e, EDGE_FALLBACK_SEG))
}

fn uniform_param_points(access: &MeshAccess, e: usize, n: usize) -> Option<Vec<[f64; 3]>> {
    let (u0, u1) = access.edge_range(e)?;
    if u1.partial_cmp(&u0) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    let params: Vec<f64> = (0..=n)
        .map(|j| u0 + (u1 - u0) * (j as f64 / n as f64))
        .collect();
    access.edge_values(e, &params)
}

/// Python's `round`, half to even.
fn py_round(x: f64) -> usize {
    x.round_ties_even().max(0.0) as usize
}

fn sample_by_deflection(
    access: &MeshAccess,
    e: usize,
    deflection: f64,
    min_seg: usize,
    max_seg: usize,
) -> Option<Vec<[f64; 3]>> {
    let (pts, params) = access.edge_deflection(e, deflection)?;
    let n = pts.len();
    if n < 2 {
        return None;
    }
    if n - 1 < min_seg {
        return uniform_param_points(access, e, min_seg);
    }
    let picks: Vec<usize> = if n - 1 > max_seg {
        (0..=max_seg)
            .map(|i| py_round(i as f64 * (n - 1) as f64 / max_seg as f64))
            .collect()
    } else {
        (0..n).collect()
    };
    let mut out: Vec<[f64; 3]> = picks.iter().map(|&i| pts[i]).collect();
    if out.len() % 2 == 0 {
        // The frontend names an edge by its index-middle point, stored in saved
        // selectors; an odd count keeps that point the parametric midpoint.
        let j = out.len() / 2;
        let umid = 0.5 * (params[picks[j - 1]] + params[picks[j]]);
        let mid = access.edge_values(e, &[umid])?;
        out.insert(j, *mid.first()?);
    }
    Some(out)
}

/// Whether the two faces on either side share a tangent plane along the edge,
/// sampled at the middle first so a crease costs one sample. Unsigned, tangent
/// faces can carry opposite surface orientations.
///
/// `MeshAccess::edge_smooth` is the same walk with the adaptors built once,
/// and is what the pass above calls; this stays as the reference the test
/// below and the bench suite's `smooth` stage check it against.
pub fn meets_smoothly(access: &MeshAccess, e: usize) -> bool {
    let cos_tol = SMOOTH_EDGE_DEG.to_radians().cos();
    let Some((t0, t1)) = access.edge_brep_range(e) else {
        return false;
    };
    for frac in [0.5, 0.15, 0.85] {
        let t = t0 + (t1 - t0) * frac;
        let mut normals = [[0.0f64; 3]; 2];
        for (side, slot) in normals.iter_mut().enumerate() {
            let Some(n) = access.edge_face_normal(e, side, t) else {
                return false;
            };
            let mag = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if mag < 1e-12 {
                return false;
            }
            *slot = [n[0] / mag, n[1] / mag, n[2] / mag];
        }
        let d = normals[0][0] * normals[1][0]
            + normals[0][1] * normals[1][1]
            + normals[0][2] * normals[1][2];
        if d.abs() < cos_tol {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::{self, Kind};
    use opencascade::primitives::Shape;

    fn agrees(shape: &Shape) {
        let access = MeshAccess::new(shape);
        let cos_tol = SMOOTH_EDGE_DEG.to_radians().cos();
        for e in 0..access.edge_count() {
            assert_eq!(
                meets_smoothly(&access, e),
                access.edge_smooth(e, cos_tol),
                "edge {e} disagrees"
            );
        }
    }

    /// The batched kernel call must decide exactly what the per sample walk
    /// decides, or a saved selector and an etag move under the client.
    #[test]
    fn the_batched_smooth_test_matches_the_sampled_one() {
        agrees(&kernel::make_box(20.0, 20.0, 10.0).expect("a box"));
        agrees(&kernel::make_cylinder(6.0, 12.0).expect("a cylinder"));
        agrees(&kernel::make_sphere(7.0).expect("a sphere"));
        agrees(&kernel::make_cone(6.0, 2.0, 9.0).expect("a cone"));
        agrees(&kernel::make_torus(10.0, 3.0).expect("a torus"));
        let b = kernel::make_box(20.0, 20.0, 10.0).expect("a box");
        let edges = kernel::subshapes(&b, Kind::Edge);
        let (filleted, _) = crate::features::blend::ops::fillet(&b, &edges, &vec![2.0; edges.len()])
            .expect("a fillet");
        agrees(&filleted);
    }
}
