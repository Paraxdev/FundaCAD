//! Whether a round over an edge whose faces turn tangent at one end, like the mitre two rounds leave where they
//! meet, came out smooth: OCCT fails such an edge at sizes in no order and ripples others that BRepCheck passes.

use std::collections::HashMap;

use glam::DVec3;
use opencascade::primitives::Shape;

use crate::kernel::{self, Kind};
use crate::select::entity::EdgeEnt;

/// blend_section.hxx `FADE_DEG`: faces closer than this are tangent.
pub const FADE_DEG: f64 = 0.5;
/// The worst bend of the rounded body over the worst of the body before or the round's own, 1 / size. Away from
/// where the round runs out, smooth rounds on these edges measured up to 1.4, the section build's torn ends 10 to 400.
pub const MAX_BEND: f64 = 2.5;
/// The largest share by which a face's mesh may miss its exact area.
pub const MAX_AREA_OFF: f64 = 0.02;
/// How far a ball of the round's radius, resting on a face the round added, may stand out of the body, as a share
/// of that radius. Smooth rounds measured up to 0.006, rippled ones 0.03 to 1.
pub const MAX_POKE: f64 = 0.015;
const MESH_TOLERANCE: f64 = 0.01;
/// Within this many mm of a point where the faces turn tangent the round narrows to nothing, and its mesh normals
/// bend there up to 30 times more than on the rest of a kernel round that is smooth.
const APEX: f64 = 0.05;
/// A face no wider than this, in mm, is a speck no one sees, like the cap the kernel leaves where a round runs out.
const SPECK: f64 = 0.05;
/// A triangle smaller than this, in mm2, is too small to see whichever way it faces.
const SPECK_TRIANGLE: f64 = MESH_TOLERANCE * MESH_TOLERANCE;
/// Mesh edges shorter than this, in mm, are too short to tell a bend from noise.
const SHORTEST: f64 = 0.02;
/// A face smaller than this, in mm2, meshes too coarsely for its area to say anything.
const SMALLEST_FACE: f64 = 0.05;

/// What the mesh of a blended body says about its faces.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lumps {
    /// The worst bend, see `MAX_BEND`.
    pub bend: f64,
    /// Triangles, not specks, whose facet faces against the surface normals at its corners, past those the body had
    /// before.
    pub flipped: usize,
    /// The largest share by which a face's mesh misses its exact area.
    pub area_off: f64,
    /// Faces too small to mesh, past those the body had before: the slivers a boolean leaves where a lofted round
    /// grazes a face.
    pub slivers: usize,
    /// See `MAX_POKE`, 0 for a blend that is not a rolling ball.
    pub poke: f64,
}

impl Lumps {
    pub fn smooth(&self) -> bool {
        self.bend <= MAX_BEND
            && self.flipped == 0
            && self.area_off <= MAX_AREA_OFF
            && self.slivers == 0
            && self.poke <= MAX_POKE
    }
}

/// The angle between the faces of `edge` near `p`, folded so that 0 is tangent either way round.
fn turn_at(shape: &Shape, edge: &Shape, p: DVec3) -> Option<f64> {
    let d = super::ops::dihedral_at(shape, edge, p)?;
    Some(d.min(180.0 - d))
}

/// The ends of `edges` where their faces turn tangent, on edges that are a real corner in their middle.
pub fn fade_ends(shape: &Shape, edges: &[Shape]) -> Vec<DVec3> {
    edges
        .iter()
        .flat_map(|e| {
            let Ok(ent) = EdgeEnt::new(e.clone()) else {
                return Vec::new();
            };
            if turn_at(shape, e, ent.mid).is_none_or(|a| a < 10.0 * FADE_DEG) {
                return Vec::new();
            }
            kernel::subshapes(e, Kind::Vertex)
                .iter()
                .filter_map(kernel::bbox)
                .map(|b| DVec3::new(b[0], b[1], b[2]))
                .filter(|&p| turn_at(shape, e, p).is_some_and(|a| a < FADE_DEG))
                .collect()
        })
        .collect()
}

struct Bends {
    /// The worst bend over the curved faces, in 1/mm.
    worst: f64,
    flipped: usize,
    area_off: f64,
    slivers: usize,
    poke: f64,
}

/// A ball of `radius` rolled over a blend of `before`.
struct Ball<'a> {
    before: &'a Shape,
    radius: f64,
}

fn grown(b: [f64; 6], by: f64) -> [f64; 6] {
    [b[0] - by, b[1] - by, b[2] - by, b[3] + by, b[4] + by, b[5] + by]
}

fn overlaps(a: &[f64; 6], b: &[f64; 6]) -> bool {
    (0..3).all(|k| a[k] <= b[k + 3] && b[k] <= a[k + 3])
}

/// The faces of `shape` whose box meets `region`.
fn faces_in(shape: &Shape, region: &[f64; 6]) -> Vec<Shape> {
    kernel::subshapes(shape, Kind::Face)
        .into_iter()
        .filter(|f| kernel::coarse_bbox(f).is_some_and(|b| overlaps(&b, region)))
        .collect()
}

/// A body mesh's nodes and unit normals.
struct Mesh<'a> {
    at: Vec<DVec3>,
    normal: Vec<DVec3>,
    indices: &'a [u32],
}

impl<'a> Mesh<'a> {
    fn of(view: &'a fundacad_protocol::FullBody) -> Mesh<'a> {
        let read = |v: &[f32]| -> Vec<DVec3> {
            v.chunks_exact(3).map(|c| DVec3::new(c[0] as f64, c[1] as f64, c[2] as f64)).collect()
        };
        let normal = view.normals.as_deref().map(read).unwrap_or_default();
        Mesh {
            at: read(&view.positions),
            normal: normal.iter().map(|n| n.normalize_or_zero()).collect(),
            indices: &view.indices,
        }
    }

    fn triangle(&self, t: usize) -> [usize; 3] {
        [0, 1, 2].map(|k| self.indices[3 * t + k] as usize)
    }
}

/// The mesh's normals bend along each mesh edge of a curved face in `region` by angle over length, the discrete
/// normal curvature, and the worst of it is taken away from `ends`. A copy is meshed so the body keeps no
/// triangulation.
fn bends(shape: &Shape, region: &[f64; 6], ends: &[DVec3], ball: Option<Ball>) -> Bends {
    let Ok(copy) = kernel::copy(&kernel::compound(&faces_in(shape, region))) else {
        return Bends { worst: f64::INFINITY, flipped: 0, area_off: 0.0, slivers: 0, poke: f64::INFINITY };
    };
    let faces = kernel::subshapes(&copy, Kind::Face);
    let view = crate::mesh::body_payload(&copy, "blend", "blend", MESH_TOLERANCE, crate::mesh::viewport_profile(1));
    let mesh = Mesh::of(&view);
    let curved: Vec<bool> = faces.iter().map(|f| !kernel::face_is_planar(f)).collect();
    let exact: Vec<f64> = faces.iter().map(|f| kernel::face_area_centre(f).map_or(0.0, |a| a[0])).collect();
    let speck: Vec<bool> = faces
        .iter()
        .zip(&exact)
        .map(|(f, &a)| {
            a < SMALLEST_FACE
                && kernel::bbox(f).is_some_and(|b| DVec3::new(b[3] - b[0], b[4] - b[1], b[5] - b[2]).length() < SPECK)
        })
        .collect();
    let near_end = |p: DVec3| ends.iter().any(|e| e.distance(p) < APEX);
    let mut meshed = vec![0.0f64; faces.len()];
    let (mut worst, mut flipped) = (0.0f64, 0usize);
    for (t, &f) in view.face_ids.iter().enumerate() {
        let f = f as usize;
        let ix = mesh.triangle(t);
        let p = ix.map(|i| mesh.at[i]);
        let facet = (p[1] - p[0]).cross(p[2] - p[0]);
        if let Some(m) = meshed.get_mut(f) {
            *m += 0.5 * facet.length();
        }
        if mesh.normal.is_empty() || facet.length() < 1e-12 {
            continue;
        }
        let n = ix.map(|i| mesh.normal[i]);
        if (n[0] + n[1] + n[2]).dot(facet) < 0.0 && 0.5 * facet.length() >= SPECK_TRIANGLE {
            flipped += 1;
        }
        if !curved.get(f).copied().unwrap_or(false) {
            continue;
        }
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            let len = p[a].distance(p[b]);
            if len >= SHORTEST && !near_end(p[a]) && !near_end(p[b]) {
                worst = worst.max(n[a].dot(n[b]).clamp(-1.0, 1.0).acos() / len);
            }
        }
    }
    let area_off = exact
        .iter()
        .zip(&meshed)
        .filter(|(&e, _)| e >= SMALLEST_FACE)
        .map(|(&e, &m)| (m - e).abs() / e)
        .fold(0.0, f64::max);
    let slivers = exact.iter().zip(&speck).filter(|(&e, &tiny)| e < SMALLEST_FACE && !tiny).count();
    let poke = ball.map_or(0.0, |b| poke(&b, region, &faces, &view.face_ids, &mesh, &curved, &near_end));
    Bends { worst, flipped, area_off, slivers, poke }
}

/// How far a ball of the blend's radius, resting on a node of a curved face near the blend, stands out of the body
/// as a share of the radius, the worst over nodes off `before`. The ball sits inside a face that bends away from its normals and outside one
/// that bends toward them. Only nodes past `MAX_POKE` are held against `before`, worst first.
fn poke(
    ball: &Ball,
    region: &[f64; 6],
    faces: &[Shape],
    face_ids: &[u32],
    mesh: &Mesh,
    curved: &[bool],
    near_end: &dyn Fn(DVec3) -> bool,
) -> f64 {
    let r = ball.radius;
    if mesh.normal.is_empty() || !(r > 0.0) {
        return 0.0;
    }
    let mut bulge = vec![0.0f64; faces.len()];
    let mut face_of = vec![usize::MAX; mesh.at.len()];
    for (t, &f) in face_ids.iter().enumerate() {
        let ix = mesh.triangle(t);
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            bulge[f as usize] += (mesh.normal[ix[b]] - mesh.normal[ix[a]]).dot(mesh.at[ix[b]] - mesh.at[ix[a]]);
        }
        for i in ix {
            face_of[i] = f as usize;
        }
    }
    let cell = |p: DVec3| ((p.x / r).floor() as i64, (p.y / r).floor() as i64, (p.z / r).floor() as i64);
    let mut grid: HashMap<(i64, i64, i64), Vec<DVec3>> = HashMap::new();
    for &p in &mesh.at {
        grid.entry(cell(p)).or_default().push(p);
    }
    let gap = |c: DVec3| {
        let (x, y, z) = cell(c);
        let mut least = f64::INFINITY;
        for i in x - 1..=x + 1 {
            for j in y - 1..=y + 1 {
                for k in z - 1..=z + 1 {
                    for q in grid.get(&(i, j, k)).into_iter().flatten() {
                        least = least.min(q.distance(c));
                    }
                }
            }
        }
        least
    };
    let mut pokes: Vec<(f64, usize)> = (0..mesh.at.len())
        .filter(|&i| {
            let f = face_of[i];
            f < faces.len() && curved[f] && !near_end(mesh.at[i])
        })
        .filter_map(|i| {
            let side = if bulge[face_of[i]] > 0.0 { -r } else { r };
            let out = r - gap(mesh.at[i] + side * mesh.normal[i]);
            (out > MAX_POKE * r).then_some((out / r, i))
        })
        .collect();
    if pokes.is_empty() {
        return 0.0;
    }
    pokes.sort_by(|a, b| b.0.total_cmp(&a.0));
    let before = kernel::compound(&faces_in(ball.before, region));
    let mut slack: HashMap<usize, f64> = HashMap::new();
    for (out, i) in pokes.into_iter().take(500) {
        let f = face_of[i];
        let tol =
            *slack.entry(f).or_insert_with(|| 1e-3 + opencascade_sys::xcaf::step_widest_tolerance(faces[f].raw()));
        if kernel::distance_to_point(&before, mesh.at[i].to_array()).is_none_or(|d| d > tol) {
            return out;
        }
    }
    0.0
}

/// The body before a blend, measured once for every result it is held against, near the blended edges only.
pub struct Gauge {
    before_shape: Shape,
    ends: Vec<DVec3>,
    region: [f64; 6],
    ball: bool,
    before: Bends,
}

impl Gauge {
    /// `ends` from `fade_ends`, `ball` when the blend is a rolling ball round whose radius is its size, and `size`
    /// the largest it is tried at.
    pub fn new(before: &Shape, edges: &[Shape], ends: Vec<DVec3>, ball: bool, size: f64) -> Gauge {
        let around = edges.iter().filter_map(kernel::bbox).reduce(|a, b| {
            [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2]), a[3].max(b[3]), a[4].max(b[4]), a[5].max(b[5])]
        });
        let region = around.map_or(
            [f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::INFINITY, f64::INFINITY],
            |b| grown(b, 2.0 * size + 1.0),
        );
        let measured = bends(before, &region, &ends, None);
        Gauge { before_shape: before.clone(), ends, region, ball, before: measured }
    }

    /// How smooth `after`, the body blended at `size`, came out.
    pub fn lumps(&self, after: &Shape, size: f64) -> Lumps {
        let ball = self.ball.then_some(Ball { before: &self.before_shape, radius: size });
        let now = bends(after, &self.region, &self.ends, ball);
        let own = if size > 0.0 { 1.0 / size } else { 0.0 };
        Lumps {
            bend: now.worst / self.before.worst.max(own).max(1e-9),
            flipped: now.flipped.saturating_sub(self.before.flipped),
            area_off: now.area_off,
            slivers: now.slivers.saturating_sub(self.before.slivers),
            poke: now.poke,
        }
    }
}
