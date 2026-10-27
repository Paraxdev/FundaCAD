//! Whether a round over an edge whose faces turn tangent at one end, like the mitre two rounds leave where they
//! meet, came out smooth: OCCT fails such an edge at sizes in no order and ripples others that BRepCheck passes.

use glam::DVec3;
use opencascade::primitives::Shape;

use crate::kernel::{self, Kind};
use crate::select::entity::EdgeEnt;

/// blend_section.hxx `FADE_DEG`: faces closer than this are tangent.
pub const FADE_DEG: f64 = 0.5;
/// The worst bend of the rounded body over the worst of the body before or the round's own, 1 / size. Smooth
/// rounds on these edges measured up to 1.7 and 2.4 (a 4.5 mm round into 4.7 mm G2 top rounds), ripples 3 to 40.
pub const MAX_BEND: f64 = 2.5;
/// The largest share by which a face's mesh may miss its exact area.
pub const MAX_AREA_OFF: f64 = 0.02;
const MESH_TOLERANCE: f64 = 0.01;
/// Mesh edges shorter than this, in mm, are too short to tell a bend from noise.
const SHORTEST: f64 = 0.02;
/// A face smaller than this, in mm2, meshes too coarsely for its area to say anything.
const SMALLEST_FACE: f64 = 0.05;

/// What the mesh of a blended body says about its faces.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lumps {
    /// The worst bend, see `MAX_BEND`.
    pub bend: f64,
    /// Triangles whose facet faces against the surface normals at its corners, past those the body had before.
    pub flipped: usize,
    /// The largest share by which a face's mesh misses its exact area.
    pub area_off: f64,
    /// Faces too small to mesh, past those the body had before: the slivers a boolean leaves where a lofted round
    /// grazes a face.
    pub slivers: usize,
}

impl Lumps {
    pub fn smooth(&self) -> bool {
        self.bend <= MAX_BEND && self.flipped == 0 && self.area_off <= MAX_AREA_OFF && self.slivers == 0
    }
}

/// The angle between the faces of `edge` near `p`, folded so that 0 is tangent either way round.
fn turn_at(shape: &Shape, edge: &Shape, p: DVec3) -> Option<f64> {
    let d = super::ops::dihedral_at(shape, edge, p)?;
    Some(d.min(180.0 - d))
}

/// Whether one of `edges` is a real corner in its middle while its faces turn tangent at an end.
pub fn turns_tangent(shape: &Shape, edges: &[Shape]) -> bool {
    edges.iter().any(|e| {
        let Ok(ent) = EdgeEnt::new(e.clone()) else {
            return false;
        };
        if turn_at(shape, e, ent.mid).is_none_or(|a| a < 10.0 * FADE_DEG) {
            return false;
        }
        kernel::subshapes(e, Kind::Vertex)
            .iter()
            .filter_map(kernel::bbox)
            .any(|b| turn_at(shape, e, DVec3::new(b[0], b[1], b[2])).is_some_and(|a| a < FADE_DEG))
    })
}

struct Bends {
    /// The worst bend over the curved faces, in 1/mm.
    worst: f64,
    flipped: usize,
    area_off: f64,
    slivers: usize,
}

/// The mesh's normals bend along each mesh edge of a curved face by angle over length, the discrete normal
/// curvature, and the worst of it is taken. A copy is meshed so the body keeps no triangulation from here.
fn bends(shape: &Shape) -> Bends {
    let Ok(copy) = kernel::copy(shape) else {
        return Bends { worst: f64::INFINITY, flipped: 0, area_off: 0.0, slivers: 0 };
    };
    let faces = kernel::subshapes(&copy, Kind::Face);
    let view = crate::mesh::body_payload(&copy, "blend", "blend", MESH_TOLERANCE, crate::mesh::viewport_profile(1));
    let at = |v: &[f32], i: usize| DVec3::new(v[3 * i] as f64, v[3 * i + 1] as f64, v[3 * i + 2] as f64);
    let normals = view.normals.clone().unwrap_or_default();
    let curved: Vec<bool> = faces.iter().map(|f| !kernel::face_is_planar(f)).collect();
    let mut meshed = vec![0.0f64; faces.len()];
    let (mut worst, mut flipped) = (0.0f64, 0usize);
    for (t, &f) in view.face_ids.iter().enumerate() {
        let f = f as usize;
        let ix = [0, 1, 2].map(|k| view.indices[3 * t + k] as usize);
        let p = ix.map(|i| at(&view.positions, i));
        let facet = (p[1] - p[0]).cross(p[2] - p[0]);
        if let Some(m) = meshed.get_mut(f) {
            *m += 0.5 * facet.length();
        }
        if normals.is_empty() || facet.length() < 1e-12 {
            continue;
        }
        let n = ix.map(|i| at(&normals, i));
        if (n[0] + n[1] + n[2]).dot(facet) < 0.0 {
            flipped += 1;
        }
        if !curved.get(f).copied().unwrap_or(false) {
            continue;
        }
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            let len = p[a].distance(p[b]);
            if len >= SHORTEST {
                worst = worst.max(n[a].normalize_or_zero().dot(n[b].normalize_or_zero()).clamp(-1.0, 1.0).acos() / len);
            }
        }
    }
    let exact: Vec<f64> = faces.iter().map(|f| kernel::face_area_centre(f).map_or(0.0, |a| a[0])).collect();
    let area_off = exact
        .iter()
        .zip(&meshed)
        .filter(|(&e, _)| e >= SMALLEST_FACE)
        .map(|(&e, &m)| (m - e).abs() / e)
        .fold(0.0, f64::max);
    let slivers = exact.iter().filter(|&&e| e < SMALLEST_FACE).count();
    Bends { worst, flipped, area_off, slivers }
}

/// The body before a blend, measured once for every result it is held against.
pub struct Gauge {
    before: Bends,
}

impl Gauge {
    pub fn new(before: &Shape) -> Gauge {
        Gauge { before: bends(before) }
    }

    /// How smooth `after`, the body blended at `size`, came out.
    pub fn lumps(&self, after: &Shape, size: f64) -> Lumps {
        let now = bends(after);
        let own = if size > 0.0 { 1.0 / size } else { 0.0 };
        Lumps {
            bend: now.worst / self.before.worst.max(own).max(1e-9),
            flipped: now.flipped.saturating_sub(self.before.flipped),
            area_off: now.area_off,
            slivers: now.slivers.saturating_sub(self.before.slivers),
        }
    }
}
