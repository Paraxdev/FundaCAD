//! Where four or more chamfered edges meet at a vertex OCCT closes the corner with one filling patch. Near the size
//! where the side faces close it bulges out through them, and the solid still reports Done and passes BRepCheck.

use glam::DVec3;
use opencascade::primitives::Shape;

use super::{ops, overlap, vertex_points};
use crate::kernel;
use crate::select::entity::EdgeEnt;

const PROBES: usize = 16;
const PROBE_MM: f64 = 0.01;
const OUT_MM: f64 = 1e-3;
const NODE_DEFLECTION_MM: f64 = 0.1;
const SAME_POINT_MM: f64 = 1e-3;

/// A vertex where four or more of `edges` meet when every one of them is convex, so that the blend only removes
/// material and no new face may lie outside `body`.
pub fn convex_apex(body: &Shape, edges: &[Shape]) -> Option<[f64; 3]> {
    if edges.len() < 4 {
        return None;
    }
    let ends: Vec<Vec<[f64; 3]>> = edges.iter().map(vertex_points).collect();
    let at = ends.iter().flatten().copied().find(|&p| {
        let p = DVec3::from(p);
        ends.iter().filter(|e| e.iter().any(|&q| DVec3::from(q).distance(p) < SAME_POINT_MM)).count() >= 4
    })?;
    edges.iter().all(|e| is_convex(body, e)).then_some(at)
}

/// The probes on a small ring round the edge's middle that lie inside the body span less than a half turn.
fn is_convex(body: &Shape, edge: &Shape) -> bool {
    let Ok(ent) = EdgeEnt::new(edge.clone()) else {
        return false;
    };
    let along = ent.dir();
    if along.length_squared() < 1e-18 {
        return false;
    }
    let along = along.normalize();
    let u = along.cross(if along.x.abs() < 0.9 { DVec3::X } else { DVec3::Y }).normalize();
    let v = along.cross(u);
    let inside = (0..PROBES)
        .filter(|&k| {
            let a = std::f64::consts::TAU * k as f64 / PROBES as f64;
            let p = ent.mid + PROBE_MM * (a.cos() * u + a.sin() * v);
            kernel::point_inside(body, p.to_array(), 1e-9)
        })
        .count();
    2 * inside < PROBES
}

/// Whether a node of a face `after` made new lies outside `before`. What cannot be measured does not count.
pub fn leaves_body(before: &Shape, after: &Shape) -> bool {
    let fresh = overlap::new_faces(before, after);
    if fresh.is_empty() {
        return false;
    }
    let Ok(flat) = ops::face_triangles(&fresh, NODE_DEFLECTION_MM) else {
        return false;
    };
    flat.chunks_exact(10)
        .any(|t| [1, 4, 7].iter().any(|&i| kernel::point_outside(before, [t[i], t[i + 1], t[i + 2]], OUT_MM)))
}
