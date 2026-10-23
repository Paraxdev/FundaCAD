//! Local refinement of a finished tet mesh by longest edge bisection (Rivara's LEPP in 3D): a marked tet is split
//! through the end of its longest edge propagation path, every tet around a split edge splits with it, so the mesh
//! stays conforming and positively oriented, and children keep their parent's boundary face tags.

use std::collections::HashMap;
use std::hash::BuildHasherDefault;

use super::tetmesh::{boundary_faces, dihedral_range, edge_key, node_faces, orient, KeyHasher, MeshError, Surface};
use super::{MeshStats, SurfaceMesh, TetMesh};

type V3 = [f64; 3];
type EdgeMap = HashMap<u64, Vec<u32>, BuildHasherDefault<KeyHasher>>;

const TICK_EVERY: usize = 256;
/// A boundary midpoint moves onto the surface only by less than this share of its edge.
const MOVE_REACH: f64 = 0.25;
/// A moved midpoint must leave every child at least this share of the volume it has on the chord.
const KEEP_VOLUME: f64 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefineOptions {
    /// Tets allowed after refinement, 0 for no limit; refinement stops before a split that would pass it.
    pub max_tets: usize,
    /// Edges shorter than this (mm) are never split.
    pub min_edge: f64,
    /// The element size the mesh was stuffed with, which scales the on face tolerance as in the mesher.
    pub size: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Refined {
    pub mesh: TetMesh,
    pub stats: MeshStats,
    /// The smallest mean edge length of any element, mm.
    pub finest: f64,
    /// Edges bisected.
    pub split: usize,
}

struct Work<'a> {
    surf: Surface,
    surface: &'a SurfaceMesh,
    nodes: Vec<V3>,
    tets: Vec<[u32; 4]>,
    fresh: Vec<bool>,
    around: EdgeMap,
    faces: HashMap<[u32; 3], u32>,
}

const EDGES: [[usize; 2]; 6] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

fn sorted3(mut k: [u32; 3]) -> [u32; 3] {
    k.sort_unstable();
    k
}

fn len2(a: V3, b: V3) -> f64 {
    (0..3).map(|k| (a[k] - b[k]) * (a[k] - b[k])).sum()
}

/// Edges in a strict total order, length first, so propagation paths always end.
fn longer(a: (f64, u64), b: (f64, u64)) -> bool {
    a.0 > b.0 || (a.0 == b.0 && a.1 > b.1)
}

impl Work<'_> {
    fn rank(&self, a: u32, b: u32) -> (f64, u64) {
        (len2(self.nodes[a as usize], self.nodes[b as usize]), edge_key(a as usize, b as usize))
    }

    fn longest(&self, t: u32) -> ([u32; 2], (f64, u64)) {
        let tet = self.tets[t as usize];
        let mut best = ([tet[0], tet[1]], self.rank(tet[0], tet[1]));
        for [i, j] in &EDGES[1..] {
            let r = self.rank(tet[*i], tet[*j]);
            if longer(r, best.1) {
                best = ([tet[*i], tet[*j]], r);
            }
        }
        best
    }

    fn link(&mut self, slot: u32) {
        let t = self.tets[slot as usize];
        for [i, j] in EDGES {
            self.around.entry(edge_key(t[i] as usize, t[j] as usize)).or_default().push(slot);
        }
    }

    fn unlink(&mut self, slot: u32, skip: u64) {
        let t = self.tets[slot as usize];
        for [i, j] in EDGES {
            let k = edge_key(t[i] as usize, t[j] as usize);
            if k != skip {
                if let Some(list) = self.around.get_mut(&k) {
                    list.retain(|&s| s != slot);
                }
            }
        }
    }

    fn split(&mut self, [a, b]: [u32; 2]) {
        let key = edge_key(a as usize, b as usize);
        let ring = self.around.remove(&key).unwrap_or_default();
        let (pa, pb) = (self.nodes[a as usize], self.nodes[b as usize]);
        let chord = [0, 1, 2].map(|k| 0.5 * (pa[k] + pb[k]));
        let mut sides: Vec<(u32, u32)> = Vec::new();
        for &s in &ring {
            for &c in &self.tets[s as usize] {
                if c != a && c != b {
                    if let Some(&f) = self.faces.get(&sorted3([a, b, c])) {
                        if !sides.iter().any(|&(o, _)| o == c) {
                            sides.push((c, f));
                        }
                    }
                }
            }
        }
        let mut m = chord;
        if let [(_, f), (_, g)] = sides[..] {
            if f == g {
                let faces = &self.surface.face_ids;
                let reach = MOVE_REACH * len2(pa, pb).sqrt();
                if let Some((_, q)) = self.surf.closest_kept(chord, reach, &|t| faces[t] == f) {
                    if ring.iter().all(|&s| self.keeps_volume(s, a, b, chord, q)) {
                        m = q;
                    }
                }
            }
        }
        let mi = self.nodes.len() as u32;
        self.nodes.push(m);
        for &s in &ring {
            self.unlink(s, key);
            let t = self.tets[s as usize];
            let first = t.map(|n| if n == b { mi } else { n });
            let second = t.map(|n| if n == a { mi } else { n });
            self.tets[s as usize] = first;
            self.fresh[s as usize] = true;
            let child = self.tets.len() as u32;
            self.tets.push(second);
            self.fresh.push(true);
            self.link(s);
            self.link(child);
        }
        for (c, f) in sides {
            self.faces.remove(&sorted3([a, b, c]));
            self.faces.insert(sorted3([a, mi, c]), f);
            self.faces.insert(sorted3([mi, b, c]), f);
        }
    }

    fn keeps_volume(&self, s: u32, a: u32, b: u32, chord: V3, moved: V3) -> bool {
        let t = self.tets[s as usize];
        [b, a].iter().all(|&gone| {
            let at = |m: V3| t.map(|n| if n == gone { m } else { self.nodes[n as usize] });
            orient(&at(moved)) >= KEEP_VOLUME * orient(&at(chord))
        })
    }
}

/// Splits each tet of `marked` (indices into `mesh.tets`) once, propagating along longest edges as needed. Returns
/// the mesh unchanged when nothing is split.
pub fn refine(
    surface: &SurfaceMesh,
    mesh: &TetMesh,
    marked: &[u32],
    opts: &RefineOptions,
    tick: &mut dyn FnMut() -> bool,
) -> Result<Refined, MeshError> {
    let mut work = Work {
        surf: Surface::new(surface)?,
        surface,
        nodes: mesh.nodes.clone(),
        tets: mesh.tets.clone(),
        fresh: vec![false; mesh.tets.len()],
        around: EdgeMap::default(),
        faces: mesh.boundary.iter().zip(&mesh.boundary_face).map(|(t, &f)| (sorted3(*t), f)).collect(),
    };
    for s in 0..mesh.tets.len() as u32 {
        work.link(s);
    }
    let min2 = opts.min_edge * opts.min_edge;
    let mut split = 0usize;
    'marked: for &t in marked {
        if t as usize >= mesh.tets.len() {
            continue;
        }
        while !work.fresh[t as usize] {
            let (mut edge, mut rank) = work.longest(t);
            if rank.0 < min2 {
                continue 'marked;
            }
            loop {
                let mut next = None;
                for &s in &work.around[&rank.1] {
                    let (e, r) = work.longest(s);
                    if longer(r, rank) && next.is_none_or(|(_, n)| longer(r, n)) {
                        next = Some((e, r));
                    }
                }
                match next {
                    Some((e, r)) => (edge, rank) = (e, r),
                    None => break,
                }
            }
            if opts.max_tets > 0 && work.tets.len() + work.around[&rank.1].len() > opts.max_tets {
                break 'marked;
            }
            if split.is_multiple_of(TICK_EVERY) && !tick() {
                return Err(MeshError::Cancelled);
            }
            work.split(edge);
            split += 1;
        }
    }

    let out = if split == 0 {
        mesh.clone()
    } else {
        let Work { surf, nodes, tets, faces, .. } = work;
        let (boundary, _) = boundary_faces(&tets);
        let boundary_face = boundary
            .iter()
            .map(|t| match faces.get(&sorted3(*t)) {
                Some(&f) => f,
                None => {
                    let c = [0, 1, 2].map(|k| t.iter().map(|&n| nodes[n as usize][k]).sum::<f64>() / 3.0);
                    surface.face_ids[surf.nearest_triangle(c)]
                }
            })
            .collect();
        let node_faces = node_faces(&surf, surface, &nodes, &boundary, opts.size, tick)?;
        TetMesh { nodes, tets, boundary, boundary_face, node_faces }
    };
    let mut stats = MeshStats { min_dihedral_deg: 180.0, max_dihedral_deg: 0.0, volume: 0.0, size: opts.size };
    let mut finest = f64::INFINITY;
    for t in &out.tets {
        let p = t.map(|n| out.nodes[n as usize]);
        let (lo, hi) = dihedral_range(&p);
        stats.min_dihedral_deg = stats.min_dihedral_deg.min(lo.to_degrees());
        stats.max_dihedral_deg = stats.max_dihedral_deg.max(hi.to_degrees());
        stats.volume += orient(&p) / 6.0;
        finest = finest.min(EDGES.iter().map(|[i, j]| len2(p[*i], p[*j]).sqrt()).sum::<f64>() / 6.0);
    }
    Ok(Refined { mesh: out, stats, finest, split })
}
