//! Face triangulations joined into one body mesh.

use opencascade::mesh_access::{self, EdgeSplits, MeshAccess};
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
    /// True surface normals and the seam weld, for the viewport payload. Export leaves them off, its mesh
    /// is the kernel's with split edges joined.
    pub display: bool,
    /// Drop a stored triangulation first. BRepMesh keeps a finer stored mesh
    /// for a coarser request, so a tolerance backoff needs this to coarsen.
    pub force_remesh: bool,
}

/// A reversed face gets its winding flipped so facet normals point out, faces the mesher left apart
/// along an edge are joined, and no triangle without area is left (mesh::flat).
pub fn tessellate(shape: &Shape, access: &MeshAccess, params: MeshParams) -> Tessellation {
    tessellate_with(shape, access, params, None)
}

/// A mesh pass's triangles for face `fid`, or `None` to mesh it plainly.
/// Called for several faces at once, from the engine's threads.
pub type Displacer<'a> = &'a dyn Fn(usize) -> Option<super::passes::FaceMesh>;

/// `tessellate`, with every face `displace` answers for replaced in place by
/// its displaced triangles.
pub fn tessellate_with(
    shape: &Shape,
    access: &MeshAccess,
    params: MeshParams,
    displace: Option<Displacer<'_>>,
) -> Tessellation {
    let mesh = |clean: bool| {
        crate::bench::phase("brep_mesh", || access.mesh(params.linear, params.relative, params.angular, clean));
        crate::bench::phase("edge_splits", || access.edge_splits())
    };
    let kept = !params.force_remesh && access.has_mesh();
    let mut edges = mesh(params.force_remesh);
    let mut reach = split_reach(shape, &edges);
    // BRepMesh keeps a stored face mesh that is fine enough, but a face shared with another body may have
    // been remeshed for it since. Only a whole body meshed in one run surely meets its neighbours.
    if kept && outdated(&edges, reach) {
        edges = mesh(true);
        reach = split_reach(shape, &edges);
    }
    let mut displaced: Vec<Option<super::passes::FaceMesh>> = match displace {
        Some(d) => {
            let work = crate::par::Shared(d);
            crate::par::map_indexed(access.face_count(), move |fid| (work.get())(fid))
        }
        None => Vec::new(),
    };
    let join = reach.and_then(|r| SplitJoin::of(&edges, r));
    let mut out = Tessellation::default();
    let mut normals: Option<Vec<f64>> = None;
    for fid in 0..access.face_count() {
        crate::heartbeat::beat();
        let Some(mut tri) = access.face_triangulation(fid, params.display) else {
            continue;
        };
        if let Some(m) = displaced.get_mut(fid).and_then(Option::take) {
            let from = out.positions.len();
            out.normals = normals.take();
            super::passes::append(&mut out, fid as u32, &m, params.display);
            normals = out.normals.take();
            if let Some(j) = &join {
                j.settle(&mut out.positions[from..]);
            }
            continue;
        }
        // Before the display weld, which would fold a node away while it
        // still sits apart from the point its neighbours take.
        if let Some(j) = &join {
            j.settle(&mut tri.nodes);
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
            let face = crate::bench::phase("display_face", || display_face(tri.nodes, t, &tri.normals, flip, is_plane));
            normals.get_or_insert_with(Vec::new).extend_from_slice(&face.normals);
            (face.positions, face.triangles)
        } else {
            (tri.nodes, t)
        };
        out.positions.extend_from_slice(&pos);
        out.indices.extend(t.iter().map(|i| i + base));
        out.face_ids.extend(std::iter::repeat(fid as u32).take(ntri));
    }
    out.normals = normals;
    crate::bench::phase("flat_triangles", || super::flat::remove(&mut out));
    out
}

pub(super) fn position_key(p: &[f64]) -> [u64; 3] {
    [0, 1, 2].map(|k| (p[k] + 0.0).to_bits())
}

/// `SPLIT_REACH` in mm for this body, `None` when its mesh has nothing to join.
fn split_reach(shape: &Shape, found: &EdgeSplits) -> Option<f64> {
    if found.pairs.is_empty() && found.unfilled.is_empty() {
        return None;
    }
    let (min, max) = mesh_bbox(shape, &[])?;
    Some(SPLIT_REACH * norm(sub(max, min)))
}

/// Faces disagree along an edge the way faces meshed in different runs do: another number of points,
/// or one step further apart than a fold leaves.
fn outdated(found: &EdgeSplits, reach: Option<f64>) -> bool {
    found.uneven > 0 || reach.is_some_and(|r| found.pairs.iter().any(|p| !(norm(sub(p[0], p[1])) <= r)))
}

/// BRepMesh folds a face's boundary nodes within its UV tolerance, so beside a shorter edge one face folds
/// and its neighbour does not. Each group of split points moves to the one met first, on every face.
pub(super) struct SplitJoin(HashMap<[u64; 3], [f64; 3]>);

impl SplitJoin {
    fn of(found: &EdgeSplits, reach: f64) -> Option<Self> {
        let lost = found
            .unfilled
            .iter()
            .filter(|f| f.size <= reach)
            .flat_map(|f| f.points.iter().skip(1).map(|p| [f.points[0], *p]));
        let join = Self::new(found.pairs.iter().copied().chain(lost), reach);
        (!join.0.is_empty()).then_some(join)
    }

    /// `splits` are pairs of points to make one, pairs further apart than
    /// `reach` are left out.
    pub(super) fn new(splits: impl IntoIterator<Item = [[f64; 3]; 2]>, reach: f64) -> Self {
        let mut ids: HashMap<[u64; 3], usize> = HashMap::new();
        let mut points: Vec<[f64; 3]> = Vec::new();
        let mut parent: Vec<usize> = Vec::new();
        fn root(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            i
        }
        for pair in splits {
            if !(norm(sub(pair[0], pair[1])) <= reach) {
                continue;
            }
            let [a, b] = pair.map(|p| {
                *ids.entry(position_key(&p)).or_insert_with(|| {
                    points.push(p);
                    parent.push(parent.len());
                    parent.len() - 1
                })
            });
            let (a, b) = (root(&mut parent, a), root(&mut parent, b));
            parent[a.max(b)] = a.min(b);
        }
        Self(ids.into_iter().map(|(key, id)| (key, points[root(&mut parent, id)])).collect())
    }

    pub(super) fn settle(&self, positions: &mut [f64]) {
        for c in positions.chunks_exact_mut(3) {
            if let Some(to) = self.0.get(&position_key(c)) {
                c.copy_from_slice(to);
            }
        }
    }
}

/// As a share of the body's diagonal: how far apart split edge points may be joined, and how large an
/// unfilled face still counts as a point. Measured folds stay under 2e-6, a wider gap is another fault.
const SPLIT_REACH: f64 = 1e-4;

struct DisplayFace {
    positions: Vec<f64>,
    triangles: Vec<u32>,
    normals: Vec<f64>,
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

/// OCCT's normals ignore a REVERSED face, so they are flipped with the winding and checked against area
/// weighted facet normals. Seam copies merge only when normals agree, so a cone apex keeps its copies.
fn display_face(nodes: Vec<f64>, tris: Vec<u32>, surface_normals: &[f64], flip: bool, is_plane: bool) -> DisplayFace {
    let n = nodes.len() / 3;
    let p = |i: u32| {
        let i = i as usize * 3;
        [nodes[i], nodes[i + 1], nodes[i + 2]]
    };
    let facets: Vec<[f64; 3]> =
        tris.chunks_exact(3).map(|c| cross(sub(p(c[1]), p(c[0])), sub(p(c[2]), p(c[0])))).collect();

    if is_plane {
        let s = facets.iter().fold([0.0; 3], |a, f| [a[0] + f[0], a[1] + f[1], a[2] + f[2]]);
        let ln = norm(s);
        let unit = if ln > 1e-12 { [s[0] / ln, s[1] / ln, s[2] / ln] } else { [0.0, 0.0, 1.0] };
        let normals = unit.iter().copied().cycle().take(3 * n).collect();
        return DisplayFace { positions: nodes, triangles: tris, normals };
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
        surface_normals.chunks_exact(3).map(|c| [sign * c[0], sign * c[1], sign * c[2]]).collect()
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
        let bad = !v.iter().all(|x| x.is_finite()) || (norm(*v) - 1.0).abs() > 1e-3 || dot(*v, *a) < 0.0;
        if bad {
            *v = *a;
        }
    }

    let (positions, triangles, nn) = weld(nodes, tris, nn);
    DisplayFace { positions, triangles, normals: nn.iter().flatten().copied().collect() }
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
        let nodes = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let up = [0.0, 0.0, 1.0];
        let nn = vec![up, up, up, [0.0, 0.0, -1.0], up];
        let (pos, tris, kept) = weld(nodes, vec![0, 1, 4, 2, 3, 4], nn);
        assert_eq!(pos.len(), 12);
        assert_eq!(kept.len(), 4);
        assert_eq!(tris, vec![0, 1, 3, 0, 2, 3]);
    }

    #[test]
    fn a_split_edge_is_joined_and_the_triangle_it_flattens_goes() {
        // Nodes 0 and 3 are one edge point two faces hold 1e-5 apart, the
        // last triangle spans only that gap.
        let mut t = Tessellation {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1e-5, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0, 0.0],
            indices: vec![0, 1, 2, 3, 4, 5, 0, 3, 4],
            face_ids: vec![0, 1, 1],
            normals: None,
        };
        let near = [[0.0, 0.0, 0.0], [1e-5, 0.0, 0.0]];
        // Too far apart to be one point the mesher folded.
        let far = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let join = SplitJoin::new([far, near], 1e-4);
        join.settle(&mut t.positions);
        super::super::flat::remove(&mut t);
        assert_eq!(t.positions[9..12], [0.0, 0.0, 0.0]);
        assert_eq!(t.positions[3..9], [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        assert_eq!(t.indices, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(t.face_ids, vec![0, 1]);
    }

    #[test]
    fn a_mesh_is_outdated_by_uneven_edges_or_a_step_too_far_apart_for_a_fold() {
        let near = [[0.0; 3], [1e-5, 0.0, 0.0]];
        let far = [[0.0; 3], [0.5, 0.0, 0.0]];
        let found = |pairs: Vec<[[f64; 3]; 2]>, uneven| EdgeSplits { pairs, uneven, unfilled: Vec::new() };
        assert!(!outdated(&found(vec![near], 0), Some(1e-4)));
        assert!(outdated(&found(vec![near, far], 0), Some(1e-4)));
        assert!(outdated(&found(Vec::new(), 1), None));
    }

    #[test]
    fn weld_key_rounds_half_to_even() {
        assert_eq!(weld_key(0.0000005), weld_key(0.0));
        assert_eq!(weld_key(-0.0), weld_key(0.0));
        assert_eq!(weld_key(1.0000004), weld_key(1.0));
    }
}
