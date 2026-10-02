//! Surface mesh to linear tetrahedra by isosurface stuffing (Labelle and Shewchuk, "Isosurface
//! Stuffing: Fast Tetrahedral Meshes with Good Dihedral Angles", SIGGRAPH 2007).
//!
//! A uniform body-centred cubic lattice of spacing `size` covers the part. The signed distance
//! to the surface (negative inside) is evaluated at every lattice vertex through a bounding
//! volume hierarchy over the triangles, signed by angle-weighted pseudonormals. Edges whose ends
//! lie on opposite sides get a cut point on the surface; a lattice vertex too close to a cut
//! point is warped onto it. Each lattice tetrahedron that reaches inside is then filled with the
//! paper's stencil for its sign pattern, which keeps every dihedral angle between about 10.7 and
//! 164.8 degrees. Where the part is thinner than about one element the stuffing cannot follow
//! it, so a mesh that came apart, bridged a gap or lost much of the volume is refused rather
//! than returned. Everything runs sequentially in lattice order, so the output is deterministic.

use std::collections::HashMap;
use std::fmt;
use std::hash::{BuildHasherDefault, Hasher};

use super::{MeshOptions, MeshStats, SurfaceMesh, TetMesh};

/// Warp thresholds of the paper, as fractions of the edge length: a cut point closer than this
/// to a lattice vertex pulls the vertex onto the surface. Long edges join two vertices of the
/// same grid (length h), short ones join the two grids (length h sqrt(3) / 2).
const ALPHA_LONG: f64 = 0.24999;
const ALPHA_SHORT: f64 = 0.41189;
/// Empty lattice cells kept around the bounding box, so the lattice border is well outside.
const MARGIN: usize = 2;
/// Lattice tetrahedra per h^3: three axis edges per cell, four tetrahedra around each.
const TETS_PER_CELL: f64 = 12.0;
/// Stencils split boundary tetrahedra, so a mesh has somewhat more than 12 V / h^3 elements.
const BOUNDARY_ALLOWANCE: f64 = 1.15;
/// Lattice vertices allowed, whatever `max_tets` says (about 40 bytes each).
const MAX_LATTICE: usize = 12_000_000;
/// The paper's dihedral angle bounds for these alphas, in degrees. A tetrahedron with all four
/// vertices on the surface is kept only when its angles are within them.
const PAPER_DIHEDRAL: [f64; 2] = [10.7, 164.8];
const MAX_ATTEMPTS: usize = 6;
/// Largest relative difference between the volume of the elements and the volume the surface
/// encloses; more means a part thinner than an element was dropped or a gap was filled.
const MAX_VOLUME_CHANGE: f64 = 0.1;
const TICK_EVERY: usize = 1024;

const IN: i8 = 1;
const OUT: i8 = -1;
const ZERO: i8 = 0;

type V3 = [f64; 3];

/// Why a surface could not be meshed. The messages are written for the person running the
/// analysis.
#[derive(Debug, Clone, PartialEq)]
pub enum MeshError {
    InvalidSize(f64),
    EmptySurface,
    FaceIdCount {
        triangles: usize,
        face_ids: usize,
    },
    MissingVertex,
    NonFinite,
    OpenSurface {
        open_edges: usize,
    },
    InsideOut,
    /// No element fits inside the part at element size `size`.
    TooSmall {
        size: f64,
        coarsening: Coarsening,
    },
    /// Parts of the body are thinner than about one element of `size`: the mesh came apart,
    /// joined separate pieces, lost material or has a boundary that is not a closed surface.
    TooThin {
        size: f64,
        coarsening: Coarsening,
    },
    TooManyElements {
        max_tets: usize,
    },
    Cancelled,
}

/// Why the element size used is larger than the one asked for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Coarsening {
    /// The size asked for was used.
    None,
    /// Grown so the mesh stays within `max_tets` elements.
    ElementLimit { max_tets: usize },
    /// Grown so the lattice fits in memory.
    LatticeLimit,
}

impl Coarsening {
    /// What the person can do about a part too thin for the elements used.
    fn advice(&self) -> String {
        match self {
            Coarsening::None => "use a smaller element size".to_string(),
            Coarsening::ElementLimit { max_tets } => format!(
                "the limit of {max_tets} elements forces elements this large, allow more elements"
            ),
            Coarsening::LatticeLimit => {
                "this is the smallest element size the mesher allows for a part this large"
                    .to_string()
            }
        }
    }
}

impl fmt::Display for MeshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MeshError::InvalidSize(s) => {
                write!(f, "the element size must be a positive number of millimetres, got {s}")
            }
            MeshError::EmptySurface => write!(f, "the body has no surface triangles to mesh"),
            MeshError::FaceIdCount { triangles, face_ids } => write!(
                f,
                "the surface mesh has {triangles} triangles but {face_ids} face ids, one per triangle is needed"
            ),
            MeshError::MissingVertex => {
                write!(f, "the surface mesh refers to a vertex that does not exist")
            }
            MeshError::NonFinite => {
                write!(f, "the surface mesh has a vertex whose coordinates are not finite numbers")
            }
            MeshError::OpenSurface { open_edges } => write!(
                f,
                "the surface is open, {open_edges} of its edges are not shared by exactly two consistently wound triangles, so it has no inside to fill"
            ),
            MeshError::InsideOut => {
                write!(f, "the surface encloses no volume, it is flat or wound inside out")
            }
            MeshError::TooSmall { size, coarsening } => write!(
                f,
                "the part is thinner than one element of {size:.3} mm, so no element fits inside it, {}",
                coarsening.advice()
            ),
            MeshError::TooThin { size, coarsening } => write!(
                f,
                "parts of the body are thinner than about one element of {size:.3} mm, so the mesh would come apart or lose material there, {}",
                coarsening.advice()
            ),
            MeshError::TooManyElements { max_tets } => write!(
                f,
                "the part needs more than {max_tets} elements even after coarsening the mesh, allow more elements"
            ),
            MeshError::Cancelled => write!(f, "meshing was cancelled"),
        }
    }
}

impl std::error::Error for MeshError {}

/// Fills the closed `surface` with positively oriented tetrahedra of about `opts.size`.
/// `tick` is called often; returning false cancels.
pub fn tetrahedralize(
    surface: &SurfaceMesh,
    opts: &MeshOptions,
    tick: &mut dyn FnMut() -> bool,
) -> Result<(TetMesh, MeshStats), MeshError> {
    if !(opts.size.is_finite() && opts.size > 0.0) {
        return Err(MeshError::InvalidSize(opts.size));
    }
    let surf = Surface::new(surface)?;
    if !tick() {
        return Err(MeshError::Cancelled);
    }
    let (mut h, mut coarsening) = choose_size(&surf, opts);

    let mut attempt = 0;
    let stuffed = loop {
        let s = stuff(&surf, h, tick)?;
        if opts.max_tets == 0 || s.tets.len() <= opts.max_tets {
            break s;
        }
        attempt += 1;
        if attempt >= MAX_ATTEMPTS {
            return Err(MeshError::TooManyElements {
                max_tets: opts.max_tets,
            });
        }
        h *= (s.tets.len() as f64 / opts.max_tets as f64).cbrt() * 1.02;
        coarsening = Coarsening::ElementLimit {
            max_tets: opts.max_tets,
        };
    };
    if stuffed.tets.is_empty() {
        return Err(MeshError::TooSmall {
            size: h,
            coarsening,
        });
    }
    if !tick() {
        return Err(MeshError::Cancelled);
    }

    let Stuffed { nodes, tets } = stuffed;
    let mut stats = MeshStats {
        min_dihedral_deg: 180.0,
        max_dihedral_deg: 0.0,
        volume: 0.0,
        size: h,
    };
    for t in &tets {
        let p = t.map(|i| nodes[i as usize]);
        let (lo, hi) = dihedral_range(&p);
        stats.min_dihedral_deg = stats.min_dihedral_deg.min(lo.to_degrees());
        stats.max_dihedral_deg = stats.max_dihedral_deg.max(hi.to_degrees());
        stats.volume += orient(&p) / 6.0;
    }

    // Where the part is thinner than about one element, the stuffing can drop the material,
    // split it, bridge a narrow gap or leave elements hinged on an edge. A solver cannot use
    // such a mesh, so refuse it rather than hand it on.
    let (boundary, pieces) = boundary_faces(&tets);
    if pieces != Some(surf.solids)
        || !closed_manifold(&boundary)
        || (stats.volume - surf.volume).abs() > MAX_VOLUME_CHANGE * surf.volume
    {
        return Err(MeshError::TooThin {
            size: h,
            coarsening,
        });
    }
    let mut boundary_face = Vec::with_capacity(boundary.len());
    for (i, f) in boundary.iter().enumerate() {
        if i % TICK_EVERY == 0 && !tick() {
            return Err(MeshError::Cancelled);
        }
        let c = scale(
            add(
                add(nodes[f[0] as usize], nodes[f[1] as usize]),
                nodes[f[2] as usize],
            ),
            1.0 / 3.0,
        );
        boundary_face.push(surface.face_ids[surf.nearest_triangle(c)]);
    }

    Ok((
        TetMesh {
            nodes,
            tets,
            boundary,
            boundary_face,
        },
        stats,
    ))
}

/// The element size to stuff with: the one asked for, grown when the mesh would exceed
/// `max_tets` or the lattice would not fit in memory.
fn choose_size(surf: &Surface, opts: &MeshOptions) -> (f64, Coarsening) {
    let mut h = opts.size;
    let mut coarsening = Coarsening::None;
    if opts.max_tets > 0 {
        let wanted = BOUNDARY_ALLOWANCE * TETS_PER_CELL * surf.volume / (h * h * h);
        if wanted > opts.max_tets as f64 {
            h = (BOUNDARY_ALLOWANCE * TETS_PER_CELL * surf.volume / opts.max_tets as f64).cbrt();
            coarsening = Coarsening::ElementLimit {
                max_tets: opts.max_tets,
            };
        }
    }
    let cap = if opts.max_tets > 0 {
        MAX_LATTICE.min(opts.max_tets.saturating_mul(32).max(1_000_000))
    } else {
        MAX_LATTICE
    };
    // Counted in floating point: a tiny size would overflow the integer count. At most `cap`
    // cells along the longest side keeps the count finite for the steps below.
    let longest = (0..3).map(|a| surf.hi[a] - surf.lo[a]).fold(0.0, f64::max);
    h = h.max(longest / cap as f64);
    loop {
        let n = Lattice::vertices(surf.lo, surf.hi, h);
        if n <= cap as f64 {
            break;
        }
        h *= (n / cap as f64).cbrt() * 1.01;
        coarsening = if cap < MAX_LATTICE {
            Coarsening::ElementLimit {
                max_tets: opts.max_tets,
            }
        } else {
            Coarsening::LatticeLimit
        };
    }
    (h, coarsening)
}

// ---------------------------------------------------------------------------------------------
// Vector helpers.

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

fn lerp(a: V3, b: V3, t: f64) -> V3 {
    add(a, scale(sub(b, a), t))
}

/// Six times the signed volume of tetrahedron `p`.
fn orient(p: &[V3; 4]) -> f64 {
    dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), sub(p[3], p[0]))
}

/// Smallest and largest interior dihedral angle of a tetrahedron, in radians.
fn dihedral_range(p: &[V3; 4]) -> (f64, f64) {
    const EDGES: [[usize; 4]; 6] = [
        [0, 1, 2, 3],
        [0, 2, 1, 3],
        [0, 3, 1, 2],
        [1, 2, 0, 3],
        [1, 3, 0, 2],
        [2, 3, 0, 1],
    ];
    let (mut lo, mut hi) = (f64::INFINITY, 0.0f64);
    for [i, j, k, l] in EDGES {
        let e = sub(p[j], p[i]);
        let ee = dot(e, e);
        if ee <= 0.0 {
            return (0.0, std::f64::consts::PI);
        }
        let u = sub(p[k], p[i]);
        let w = sub(p[l], p[i]);
        let u = sub(u, scale(e, dot(u, e) / ee));
        let w = sub(w, scale(e, dot(w, e) / ee));
        let a = norm(cross(u, w)).atan2(dot(u, w));
        lo = lo.min(a);
        hi = hi.max(a);
    }
    (lo, hi)
}

// ---------------------------------------------------------------------------------------------
// Signed distance to the surface.

/// Where on a triangle the closest point lies; the sign of the distance comes from the
/// pseudonormal of that feature (Baerentzen and Aanaes 2005).
#[derive(Clone, Copy)]
enum Feature {
    Face,
    Edge(usize),
    Vertex(usize),
}

struct Node {
    lo: V3,
    hi: V3,
    /// Leaf: first triangle slot. Internal: index of the right child (the left one follows).
    index: u32,
    /// Triangles in a leaf, 0 for an internal node.
    count: u32,
}

/// A triangle in BVH leaf order with its corners and pseudonormals.
struct Tri {
    v: [V3; 3],
    face: V3,
    /// Edge `e` runs from corner `e` to corner `e + 1`.
    edge: [V3; 3],
    vert: [V3; 3],
    id: u32,
}

struct Surface {
    nodes: Vec<Node>,
    tris: Vec<Tri>,
    lo: V3,
    hi: V3,
    volume: f64,
    /// Closed shells enclosing material (positive volume); the others bound voids.
    solids: usize,
}

impl Surface {
    fn new(mesh: &SurfaceMesh) -> Result<Surface, MeshError> {
        let pos = &mesh.positions;
        let tris = &mesh.triangles;
        if tris.is_empty() {
            return Err(MeshError::EmptySurface);
        }
        if mesh.face_ids.len() != tris.len() {
            return Err(MeshError::FaceIdCount {
                triangles: tris.len(),
                face_ids: mesh.face_ids.len(),
            });
        }
        if tris.iter().flatten().any(|&i| i as usize >= pos.len()) {
            return Err(MeshError::MissingVertex);
        }
        if pos.iter().flatten().any(|c| !c.is_finite()) {
            return Err(MeshError::NonFinite);
        }

        // Closed: every undirected edge is used as often in one direction as in the other.
        let mut half: Vec<(u64, u32, u8)> = Vec::with_capacity(tris.len() * 3);
        for (t, tri) in tris.iter().enumerate() {
            for e in 0..3 {
                let (a, b) = (tri[e], tri[(e + 1) % 3]);
                if a != b {
                    half.push((edge_key(a as usize, b as usize), t as u32, e as u8));
                }
            }
        }
        half.sort_unstable();
        let mut open = 0;
        let mut i = 0;
        while i < half.len() {
            let mut j = i;
            let mut balance = 0i64;
            while j < half.len() && half[j].0 == half[i].0 {
                let (t, e) = (half[j].1 as usize, half[j].2 as usize);
                balance += if tris[t][e] < tris[t][(e + 1) % 3] {
                    1
                } else {
                    -1
                };
                j += 1;
            }
            if balance != 0 {
                open += 1;
            }
            i = j;
        }
        if open > 0 {
            return Err(MeshError::OpenSurface { open_edges: open });
        }
        let mut shells = UnionFind::new(tris.len());
        let mut i = 0;
        while i < half.len() {
            let mut j = i + 1;
            while j < half.len() && half[j].0 == half[i].0 {
                shells.union(half[i].1 as usize, half[j].1 as usize);
                j += 1;
            }
            i = j;
        }

        let corners = |t: usize| tris[t].map(|i| pos[i as usize]);
        let mut volume = 0.0;
        let mut face_n = Vec::with_capacity(tris.len());
        for t in 0..tris.len() {
            let [a, b, c] = corners(t);
            volume += dot(a, cross(b, c)) / 6.0;
            let n = cross(sub(b, a), sub(c, a));
            let len = norm(n);
            let longest = dot(sub(b, a), sub(b, a))
                .max(dot(sub(c, b), sub(c, b)))
                .max(dot(sub(a, c), sub(a, c)));
            face_n.push(if len > 1e-14 * longest {
                scale(n, 1.0 / len)
            } else {
                [0.0; 3]
            });
        }
        if !(volume > 0.0) {
            return Err(MeshError::InsideOut);
        }
        let mut shell_volume = vec![0.0; tris.len()];
        for t in 0..tris.len() {
            let [a, b, c] = corners(t);
            shell_volume[shells.find(t)] += dot(a, cross(b, c)) / 6.0;
        }
        let solids = shell_volume.iter().filter(|&&v| v > 1e-9 * volume).count();

        // Edge pseudonormals: the sum of the unit normals of the triangles on the edge.
        let mut edge_n = vec![[[0.0; 3]; 3]; tris.len()];
        let mut i = 0;
        while i < half.len() {
            let mut j = i;
            let mut n = [0.0; 3];
            while j < half.len() && half[j].0 == half[i].0 {
                n = add(n, face_n[half[j].1 as usize]);
                j += 1;
            }
            for h in &half[i..j] {
                edge_n[h.1 as usize][h.2 as usize] = n;
            }
            i = j;
        }
        // Vertex pseudonormals: unit normals weighted by the corner angle.
        let mut vert_n = vec![[0.0; 3]; pos.len()];
        for t in 0..tris.len() {
            let p = corners(t);
            for k in 0..3 {
                let u = sub(p[(k + 1) % 3], p[k]);
                let w = sub(p[(k + 2) % 3], p[k]);
                let angle = norm(cross(u, w)).atan2(dot(u, w));
                let v = tris[t][k] as usize;
                vert_n[v] = add(vert_n[v], scale(face_n[t], angle));
            }
        }

        // Degenerate triangles carry no area, their neighbours cover the surface.
        let mut order: Vec<u32> = (0..tris.len() as u32)
            .filter(|&t| face_n[t as usize] != [0.0; 3])
            .collect();
        if order.is_empty() {
            return Err(MeshError::InsideOut);
        }
        let centroid: Vec<V3> = (0..tris.len())
            .map(|t| {
                let [a, b, c] = corners(t);
                scale(add(add(a, b), c), 1.0 / 3.0)
            })
            .collect();
        let mut nodes = Vec::with_capacity(order.len() / 2 + 1);
        let len = order.len();
        build_bvh(&mut nodes, &mut order, 0, len, &centroid, &|t| {
            corners(t as usize)
        });
        let tri_list: Vec<Tri> = order
            .iter()
            .map(|&t| {
                let t = t as usize;
                Tri {
                    v: corners(t),
                    face: face_n[t],
                    edge: edge_n[t],
                    vert: tris[t].map(|v| vert_n[v as usize]),
                    id: t as u32,
                }
            })
            .collect();
        let (lo, hi) = (nodes[0].lo, nodes[0].hi);
        Ok(Surface {
            nodes,
            tris: tri_list,
            lo,
            hi,
            volume,
            solids,
        })
    }

    /// Closest point among triangles strictly nearer than `sqrt(best)`.
    fn closest(&self, p: V3, mut best: f64) -> Option<(usize, V3, Feature)> {
        let mut found = None;
        let mut stack = [0u32; 96];
        let mut sp = 0;
        if box_dist2(&self.nodes[0], p) < best {
            stack[0] = 0;
            sp = 1;
        }
        while sp > 0 {
            sp -= 1;
            let n = &self.nodes[stack[sp] as usize];
            if box_dist2(n, p) >= best {
                continue;
            }
            if n.count > 0 {
                let start = n.index as usize;
                for (slot, tri) in self.tris[start..start + n.count as usize]
                    .iter()
                    .enumerate()
                {
                    let (q, feat) = closest_on_triangle(p, &tri.v);
                    let d = sub(p, q);
                    let d2 = dot(d, d);
                    if d2 < best {
                        best = d2;
                        found = Some((start + slot, q, feat));
                    }
                }
            } else {
                let l = stack[sp] + 1;
                let r = n.index;
                let dl = box_dist2(&self.nodes[l as usize], p);
                let dr = box_dist2(&self.nodes[r as usize], p);
                let (near, dn, far, df) = if dl <= dr {
                    (l, dl, r, dr)
                } else {
                    (r, dr, l, dl)
                };
                if df < best && sp < stack.len() {
                    stack[sp] = far;
                    sp += 1;
                }
                if dn < best && sp < stack.len() {
                    stack[sp] = near;
                    sp += 1;
                }
            }
        }
        found
    }

    /// Signed distance (negative inside) and the closest surface point. `bound` is an upper
    /// bound of the distance when known, which prunes the search.
    fn signed(&self, p: V3, bound: f64) -> (f64, V3) {
        let limit = if bound.is_finite() {
            bound * bound * (1.0 + 1e-9) + 1e-300
        } else {
            f64::INFINITY
        };
        let hit = self
            .closest(p, limit)
            .or_else(|| self.closest(p, f64::INFINITY));
        let (slot, q, feat) = hit.expect("a surface with triangles has a closest point");
        let t = &self.tris[slot];
        let n = match feat {
            Feature::Face => t.face,
            Feature::Edge(e) => t.edge[e],
            Feature::Vertex(k) => t.vert[k],
        };
        let d = sub(p, q);
        let dist = norm(d);
        (if dot(d, n) < 0.0 { -dist } else { dist }, q)
    }

    /// Index of the input triangle closest to `p`.
    fn nearest_triangle(&self, p: V3) -> usize {
        let (slot, _, _) = self
            .closest(p, f64::INFINITY)
            .expect("a surface with triangles has a closest point");
        self.tris[slot].id as usize
    }

    /// The surface point on segment `pi`-`po` where the signed distance crosses zero, from the
    /// end values `fi < 0 < fo`, by the Illinois variant of regula falsi.
    fn cut(&self, pi: V3, fi: f64, po: V3, fo: f64, tol: f64) -> V3 {
        let len = norm(sub(po, pi));
        let (mut t0, mut f0, mut t1, mut f1) = (0.0, fi, 1.0, fo);
        // Illinois halves the kept end's value; the true distances still bound the search.
        let (mut g0, mut g1) = (-fi, fo);
        let mut side = 0i8;
        let mut last = (pi, pi, f64::INFINITY);
        for _ in 0..64 {
            let t = ((t0 * f1 - t1 * f0) / (f1 - f0)).clamp(t0, t1);
            let p = lerp(pi, po, t);
            let bound = (g0 + (t - t0) * len).min(g1 + (t1 - t) * len);
            let (f, q) = self.signed(p, bound);
            last = (p, q, f);
            if f.abs() <= tol {
                return q;
            }
            if f < 0.0 {
                t0 = t;
                f0 = f;
                g0 = -f;
                if side < 0 {
                    f1 *= 0.5;
                }
                side = -1;
            } else {
                t1 = t;
                f1 = f;
                g1 = f;
                if side > 0 {
                    f0 *= 0.5;
                }
                side = 1;
            }
            if (t1 - t0) * len <= tol {
                break;
            }
        }
        // A bracket that closed away from the surface means the sign jumps here (a surface
        // defect); keep the point on the edge rather than the far closest point.
        if last.2.abs() <= 1e-3 * len {
            last.1
        } else {
            last.0
        }
    }
}

fn build_bvh(
    nodes: &mut Vec<Node>,
    order: &mut [u32],
    start: usize,
    end: usize,
    centroid: &[V3],
    corners: &dyn Fn(u32) -> [V3; 3],
) -> usize {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    let mut clo = [f64::INFINITY; 3];
    let mut chi = [f64::NEG_INFINITY; 3];
    for &t in &order[start..end] {
        for v in corners(t) {
            for a in 0..3 {
                lo[a] = lo[a].min(v[a]);
                hi[a] = hi[a].max(v[a]);
            }
        }
        let c = centroid[t as usize];
        for a in 0..3 {
            clo[a] = clo[a].min(c[a]);
            chi[a] = chi[a].max(c[a]);
        }
    }
    let me = nodes.len();
    nodes.push(Node {
        lo,
        hi,
        index: start as u32,
        count: (end - start) as u32,
    });
    let ext = sub(chi, clo);
    let axis = if ext[0] >= ext[1] && ext[0] >= ext[2] {
        0
    } else if ext[1] >= ext[2] {
        1
    } else {
        2
    };
    if end - start <= 4 || ext[axis] <= 0.0 {
        return me;
    }
    let mid = (start + end) / 2;
    order[start..end].select_nth_unstable_by(mid - start, |&a, &b| {
        centroid[a as usize][axis]
            .total_cmp(&centroid[b as usize][axis])
            .then(a.cmp(&b))
    });
    build_bvh(nodes, order, start, mid, centroid, corners);
    let right = build_bvh(nodes, order, mid, end, centroid, corners);
    nodes[me].index = right as u32;
    nodes[me].count = 0;
    me
}

fn box_dist2(n: &Node, p: V3) -> f64 {
    let mut d = 0.0;
    for a in 0..3 {
        let e = (n.lo[a] - p[a]).max(p[a] - n.hi[a]).max(0.0);
        d += e * e;
    }
    d
}

/// Closest point of triangle `v` to `p` and the feature it lies on (Ericson, Real-Time
/// Collision Detection, 5.1.5).
fn closest_on_triangle(p: V3, v: &[V3; 3]) -> (V3, Feature) {
    let [a, b, c] = *v;
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return (a, Feature::Vertex(0));
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return (b, Feature::Vertex(1));
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let t = d1 / (d1 - d3);
        return (add(a, scale(ab, t)), Feature::Edge(0));
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return (c, Feature::Vertex(2));
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let t = d2 / (d2 - d6);
        return (add(a, scale(ac, t)), Feature::Edge(2));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (add(b, scale(sub(c, b), t)), Feature::Edge(1));
    }
    let denom = 1.0 / (va + vb + vc);
    (
        add(a, add(scale(ab, vb * denom), scale(ac, vc * denom))),
        Feature::Face,
    )
}

// ---------------------------------------------------------------------------------------------
// The lattice.

/// Black vertices sit on the grid points `lo + h (i, j, k)` (shifted by the margin), red ones at
/// the cell centres. Black vertices come first in the numbering, then red, each x fastest.
struct Lattice {
    base: V3,
    h: f64,
    /// Cells per axis.
    n: [usize; 3],
    blacks: usize,
}

impl Lattice {
    /// Cells per axis, as floating point numbers.
    fn cells(lo: V3, hi: V3, h: f64) -> [f64; 3] {
        [0, 1, 2].map(|a| ((hi[a] - lo[a]) / h).ceil().max(1.0) + 2.0 * MARGIN as f64)
    }

    /// The number of vertices `Lattice::new(lo, hi, h).count()` would have, without overflow.
    fn vertices(lo: V3, hi: V3, h: f64) -> f64 {
        let [x, y, z] = Lattice::cells(lo, hi, h);
        (x + 1.0) * (y + 1.0) * (z + 1.0) + x * y * z
    }

    fn new(lo: V3, hi: V3, h: f64) -> Lattice {
        let n = Lattice::cells(lo, hi, h).map(|c| c as usize);
        Lattice {
            base: lo,
            h,
            n,
            blacks: (n[0] + 1) * (n[1] + 1) * (n[2] + 1),
        }
    }

    fn count(&self) -> usize {
        self.blacks + self.n[0] * self.n[1] * self.n[2]
    }

    fn black(&self, c: [usize; 3]) -> usize {
        c[0] + (self.n[0] + 1) * (c[1] + (self.n[1] + 1) * c[2])
    }

    fn red(&self, c: [usize; 3]) -> usize {
        self.blacks + c[0] + self.n[0] * (c[1] + self.n[1] * c[2])
    }

    /// Whether `v` is red, and its grid coordinates.
    fn coords(&self, v: usize) -> (bool, [usize; 3]) {
        let (red, i, nx, ny) = if v < self.blacks {
            (false, v, self.n[0] + 1, self.n[1] + 1)
        } else {
            (true, v - self.blacks, self.n[0], self.n[1])
        };
        (red, [i % nx, (i / nx) % ny, i / (nx * ny)])
    }

    fn position(&self, v: usize) -> V3 {
        let (red, c) = self.coords(v);
        let half = if red { 0.5 } else { 0.0 };
        [0, 1, 2].map(|a| self.base[a] + self.h * (c[a] as f64 - MARGIN as f64 + half))
    }

    /// The (up to) 14 lattice neighbours of `v`, each with whether the edge is long.
    fn neighbors(&self, v: usize, out: &mut [(usize, bool); 14]) -> usize {
        let (red, c) = self.coords(v);
        let mut k = 0;
        // Same grid, along the axes.
        let limit = if red { self.n.map(|x| x - 1) } else { self.n };
        for a in 0..3 {
            if c[a] > 0 {
                let mut d = c;
                d[a] -= 1;
                out[k] = (if red { self.red(d) } else { self.black(d) }, true);
                k += 1;
            }
            if c[a] < limit[a] {
                let mut d = c;
                d[a] += 1;
                out[k] = (if red { self.red(d) } else { self.black(d) }, true);
                k += 1;
            }
        }
        // The other grid, along the diagonals.
        for corner in 0..8 {
            let off = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
            let mut d = c;
            let mut ok = true;
            for a in 0..3 {
                if red {
                    d[a] += off[a];
                } else if off[a] == 1 {
                    if c[a] == 0 || c[a] > self.n[a] {
                        ok = false;
                    } else {
                        d[a] -= 1;
                    }
                } else if c[a] >= self.n[a] {
                    ok = false;
                }
            }
            if ok {
                out[k] = (if red { self.black(d) } else { self.red(d) }, false);
                k += 1;
            }
        }
        k
    }

    /// Parity of a vertex within its own grid; the two ends of a long edge differ.
    fn parity(&self, v: usize) -> usize {
        let (_, c) = self.coords(v);
        (c[0] + c[1] + c[2]) & 1
    }

    fn same_grid(&self, a: usize, b: usize) -> bool {
        (a < self.blacks) == (b < self.blacks)
    }
}

fn edge_key(a: usize, b: usize) -> u64 {
    let (a, b) = if a < b { (a, b) } else { (b, a) };
    ((a as u64) << 32) | b as u64
}

/// Hash for edge keys; the map is only looked up, never iterated.
#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    fn write_u64(&mut self, x: u64) {
        let h = (self.0 ^ x).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        self.0 = h ^ (h >> 29);
    }
}

type CutMap = HashMap<u64, u32, BuildHasherDefault<KeyHasher>>;

// ---------------------------------------------------------------------------------------------
// Stuffing.

struct Stuffed {
    nodes: Vec<V3>,
    tets: Vec<[u32; 4]>,
}

fn stuff(surf: &Surface, h: f64, tick: &mut dyn FnMut() -> bool) -> Result<Stuffed, MeshError> {
    let lat = Lattice::new(surf.lo, surf.hi, h);
    let nv = lat.count();
    let eps = 1e-9 * h;

    // Signed distance at every lattice vertex. The previous vertex's distance plus the step
    // between them bounds this one's, which prunes most of the search.
    let mut pos = Vec::with_capacity(nv);
    let mut val = Vec::with_capacity(nv);
    let mut sign = Vec::with_capacity(nv);
    let mut prev: Option<(V3, f64)> = None;
    for v in 0..nv {
        if v % TICK_EVERY == 0 && !tick() {
            return Err(MeshError::Cancelled);
        }
        let p = lat.position(v);
        let bound = prev.map_or(f64::INFINITY, |(q, d)| d + norm(sub(p, q)));
        let (f, q) = surf.signed(p, bound);
        prev = Some((p, f.abs()));
        if f.abs() <= eps {
            pos.push(q);
            sign.push(ZERO);
        } else {
            pos.push(p);
            sign.push(if f < 0.0 { IN } else { OUT });
        }
        val.push(f);
    }

    // Cut points on every edge whose ends are strictly on opposite sides, snapped to the
    // closest surface point.
    let mut cuts: Vec<V3> = Vec::new();
    let mut cut_of = CutMap::default();
    let mut nb = [(0usize, false); 14];
    for v in 0..nv {
        if v % TICK_EVERY == 0 && !tick() {
            return Err(MeshError::Cancelled);
        }
        if sign[v] == ZERO {
            continue;
        }
        let k = lat.neighbors(v, &mut nb);
        for &(u, _) in &nb[..k] {
            if u > v && sign[u] == -sign[v] {
                let (a, b) = if sign[v] == IN { (v, u) } else { (u, v) };
                cut_of.insert(edge_key(v, u), cuts.len() as u32);
                cuts.push(surf.cut(pos[a], val[a], pos[b], val[b], eps * 0.1));
            }
        }
    }

    // Warp every vertex that a cut point violates onto the closest violating cut point. The
    // vertex is then on the surface, which retires the cut points of all its edges: an edge
    // keeps its cut point exactly while its ends have strictly opposite signs.
    let short = h * 3f64.sqrt() * 0.5;
    for v in 0..nv {
        if v % TICK_EVERY == 0 && !tick() {
            return Err(MeshError::Cancelled);
        }
        if sign[v] == ZERO {
            continue;
        }
        let k = lat.neighbors(v, &mut nb);
        let mut best: Option<(f64, u32)> = None;
        for &(u, long) in &nb[..k] {
            if sign[u] != -sign[v] {
                continue;
            }
            let c = cut_of[&edge_key(v, u)];
            let (len, alpha) = if long {
                (h, ALPHA_LONG)
            } else {
                (short, ALPHA_SHORT)
            };
            let d = norm(sub(cuts[c as usize], pos[v])) / len;
            if d < alpha && best.map_or(true, |(bd, _)| d < bd) {
                best = Some((d, c));
            }
        }
        if let Some((_, c)) = best {
            pos[v] = cuts[c as usize];
            sign[v] = ZERO;
        }
    }

    // Stencils for each lattice tetrahedron: a long edge along axis `a` and, around it, the
    // ring of four cell centres; consecutive centres close a positively oriented tetrahedron.
    let mut st = Stencils {
        lat: &lat,
        pos: &pos,
        sign: &sign,
        cuts: &cuts,
        cut_of: &cut_of,
        surf,
        tets: Vec::new(),
    };
    const RING: [[usize; 2]; 4] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for a in 0..3 {
        let (b, c) = ((a + 1) % 3, (a + 2) % 3);
        let n = lat.n;
        for z in 0..=n[2] {
            if !tick() {
                return Err(MeshError::Cancelled);
            }
            for y in 0..=n[1] {
                for x in 0..=n[0] {
                    let p = [x, y, z];
                    if p[a] >= n[a] || p[b] == 0 || p[b] >= n[b] || p[c] == 0 || p[c] >= n[c] {
                        continue;
                    }
                    let b0 = lat.black(p);
                    let mut q = p;
                    q[a] += 1;
                    let b1 = lat.black(q);
                    let ring = RING.map(|[db, dc]| {
                        let mut r = p;
                        r[b] = r[b] - 1 + db;
                        r[c] = r[c] - 1 + dc;
                        lat.red(r)
                    });
                    if sign[b0] == OUT && sign[b1] == OUT && ring.iter().all(|&r| sign[r] == OUT) {
                        continue;
                    }
                    for k in 0..4 {
                        st.fill([b0, b1, ring[k], ring[(k + 1) % 4]]);
                    }
                }
            }
        }
    }
    let tets = st.tets;

    // Keep only the nodes the tetrahedra use, lattice vertices first, in index order.
    let total = nv + cuts.len();
    let mut remap = vec![u32::MAX; total];
    for t in &tets {
        for &i in t {
            remap[i as usize] = 0;
        }
    }
    let mut nodes = Vec::new();
    for (i, r) in remap.iter_mut().enumerate() {
        if *r == 0 {
            *r = nodes.len() as u32;
            nodes.push(if i < nv { pos[i] } else { cuts[i - nv] });
        }
    }
    let tets = tets
        .into_iter()
        .map(|t| t.map(|i| remap[i as usize]))
        .collect();
    Ok(Stuffed { nodes, tets })
}

/// Fills lattice tetrahedra. Node ids: lattice vertex `v` is `v`, cut point `c` is `nv + c`.
struct Stencils<'a> {
    lat: &'a Lattice,
    pos: &'a [V3],
    sign: &'a [i8],
    cuts: &'a [V3],
    cut_of: &'a CutMap,
    surf: &'a Surface,
    tets: Vec<[u32; 4]>,
}

impl Stencils<'_> {
    fn point(&self, id: u32) -> V3 {
        let nv = self.pos.len();
        let i = id as usize;
        if i < nv {
            self.pos[i]
        } else {
            self.cuts[i - nv]
        }
    }

    fn cut(&self, a: usize, b: usize) -> u32 {
        (self.pos.len() + self.cut_of[&edge_key(a, b)] as usize) as u32
    }

    fn emit(&mut self, mut t: [u32; 4]) {
        let p = t.map(|i| self.point(i));
        if orient(&p) < 0.0 {
            t.swap(2, 3);
        }
        self.tets.push(t);
    }

    fn fill(&mut self, t: [usize; 4]) {
        let (mut ins, mut ni) = ([0usize; 4], 0);
        let (mut outs, mut no) = ([0usize; 4], 0);
        let (mut zeros, mut nz) = ([0usize; 4], 0);
        for &v in &t {
            match self.sign[v] {
                IN => {
                    ins[ni] = v;
                    ni += 1;
                }
                OUT => {
                    outs[no] = v;
                    no += 1;
                }
                _ => {
                    zeros[nz] = v;
                    nz += 1;
                }
            }
        }
        let id = |v: usize| v as u32;
        // No vertex inside. Four vertices on the surface can make an arbitrarily flat
        // tetrahedron (on a smooth surface they are nearly coplanar), so one is kept only when
        // it lies inside and its angles are within the paper's bounds. Dropping them all would
        // also drop the one element through a wall about one element thick and leave the
        // remaining ones hinged on an edge.
        if ni == 0 {
            if no == 0 {
                let p = t.map(|v| self.pos[v]);
                let (lo, hi) = dihedral_range(&p);
                let c = scale(add(add(p[0], p[1]), add(p[2], p[3])), 0.25);
                if lo >= PAPER_DIHEDRAL[0].to_radians()
                    && hi <= PAPER_DIHEDRAL[1].to_radians()
                    && self.surf.signed(c, f64::INFINITY).0 < 0.0
                {
                    self.emit(t.map(id));
                }
            }
            return;
        }
        if no == 0 {
            self.emit(t.map(id));
            return;
        }
        match (ni, no) {
            // One vertex inside: a single tetrahedron from it, the surface vertices and the
            // cut points on its edges to the outside vertices.
            (1, _) => {
                let a = ins[0];
                let mut q = [id(a); 4];
                let mut m = 1;
                for &z in &zeros[..nz] {
                    q[m] = id(z);
                    m += 1;
                }
                for &o in &outs[..no] {
                    q[m] = self.cut(a, o);
                    m += 1;
                }
                self.emit(q);
            }
            // Two inside, one on the surface, one outside: a pyramid with apex on the surface
            // over the quadrilateral on the lattice face.
            (2, 1) => {
                let (a, b, z, o) = (ins[0], ins[1], zeros[0], outs[0]);
                let (ca, cb) = (self.cut(a, o), self.cut(b, o));
                if self.diagonal_end(a, b, o) == a {
                    self.emit([id(z), id(a), id(b), cb]);
                    self.emit([id(z), id(a), cb, ca]);
                } else {
                    self.emit([id(z), id(a), id(b), ca]);
                    self.emit([id(z), id(b), cb, ca]);
                }
            }
            // Three inside, one outside: a prism between the inside face and the three cuts.
            (3, 1) => {
                let o = outs[0];
                let top = [ins[0], ins[1], ins[2]];
                let bot = top.map(|x| self.cut(x, o));
                let dirs = [(0, 1), (0, 2), (1, 2)]
                    .map(|(i, j)| Some(self.diagonal_end(top[i], top[j], o) == top[i]));
                self.prism(top.map(id), bot, dirs);
            }
            // Two inside, two outside: a prism along the inside edge. Its third quadrilateral
            // lies inside the lattice tetrahedron, so its diagonal is free.
            (2, 2) => {
                let (a, b) = (ins[0], ins[1]);
                let (o1, o2) = (outs[0], outs[1]);
                let top = [id(a), self.cut(a, o1), self.cut(a, o2)];
                let bot = [id(b), self.cut(b, o1), self.cut(b, o2)];
                let d1 = self.diagonal_end(a, b, o1) == a;
                let d2 = self.diagonal_end(a, b, o2) == a;
                self.prism(top, bot, [Some(d1), Some(d2), None]);
            }
            _ => unreachable!("a tetrahedron has four vertices"),
        }
    }

    /// The inside vertex that the diagonal of the quadrilateral on lattice face (`a`, `b`, `o`)
    /// touches; the quadrilateral is `a`, `b`, cut(b, o), cut(a, o). Both lattice tetrahedra on
    /// the face must agree, so the choice depends on the face alone. On a long edge `a`-`b` the
    /// face is symmetric and the parity rule picks the even end. On a short edge, one of
    /// `a`-`o` and `b`-`o` is long and the diagonal starts at that edge's inside end (the other
    /// choice measured a few degrees worse on random shapes).
    fn diagonal_end(&self, a: usize, b: usize, o: usize) -> usize {
        if self.lat.same_grid(a, b) {
            if self.lat.parity(a) == 0 {
                a
            } else {
                b
            }
        } else if self.lat.same_grid(a, o) {
            a
        } else {
            b
        }
    }

    /// Splits the prism with triangles `top` and `bot` (column `i` runs from `top[i]` to
    /// `bot[i]`) into three tetrahedra. `dirs` covers the quadrilaterals between columns
    /// (0, 1), (0, 2) and (1, 2): `Some(true)` when the diagonal runs from the first column's
    /// top to the second column's bottom, `Some(false)` for the other one, `None` when the
    /// quadrilateral is free; a free one takes the diagonal that gives the better tetrahedra.
    fn prism(&mut self, top: [u32; 3], bot: [u32; 3], dirs: [Option<bool>; 3]) {
        const PAIRS: [(usize, usize); 3] = [(0, 1), (0, 2), (1, 2)];
        let mut best: Option<(f64, [[u32; 4]; 3])> = None;
        for mask in 0..8u32 {
            let mut d = [false; 3];
            let mut skip = false;
            for q in 0..3 {
                let bit = (mask >> q) & 1 == 1;
                match dirs[q] {
                    Some(x) => {
                        skip |= bit;
                        d[q] = x;
                    }
                    None => d[q] = bit,
                }
            }
            if skip {
                continue;
            }
            // The diagonals order the columns; a cyclic order has no triangulation.
            let mut out = [0; 3];
            for (q, &(i, j)) in PAIRS.iter().enumerate() {
                out[if d[q] { i } else { j }] += 1;
            }
            let (Some(s), Some(m), Some(t)) = (
                out.iter().position(|&x| x == 2),
                out.iter().position(|&x| x == 1),
                out.iter().position(|&x| x == 0),
            ) else {
                continue;
            };
            let tets = [
                [top[s], top[m], top[t], bot[t]],
                [top[s], top[m], bot[m], bot[t]],
                [top[s], bot[s], bot[m], bot[t]],
            ];
            let score = tets
                .iter()
                .map(|t| {
                    let (lo, hi) = dihedral_range(&t.map(|i| self.point(i)));
                    lo.min(std::f64::consts::PI - hi)
                })
                .fold(f64::INFINITY, f64::min);
            if best.as_ref().map_or(true, |(b, _)| score > *b) {
                best = Some((score, tets));
            }
        }
        let (_, tets) = best.expect("the lattice face diagonals never order a prism cyclically");
        for t in tets {
            self.emit(t);
        }
    }
}

/// Faces of `tets` that no other tetrahedron shares, wound outward, in sorted vertex order, and
/// the number of pieces the tetrahedra form when joined across shared faces (`None` when a face
/// is shared by more than two).
fn boundary_faces(tets: &[[u32; 4]]) -> (Vec<[u32; 3]>, Option<usize>) {
    let mut faces: Vec<([u32; 3], u32, [u32; 3])> = Vec::with_capacity(tets.len() * 4);
    for (t, &[a, b, c, d]) in tets.iter().enumerate() {
        for f in [[a, c, b], [a, b, d], [a, d, c], [b, c, d]] {
            let mut k = f;
            k.sort_unstable();
            faces.push((k, t as u32, f));
        }
    }
    faces.sort_unstable();
    let mut pieces = UnionFind::new(tets.len());
    let mut conforming = true;
    let mut out = Vec::new();
    let mut i = 0;
    while i < faces.len() {
        let mut j = i + 1;
        while j < faces.len() && faces[j].0 == faces[i].0 {
            j += 1;
        }
        match j - i {
            1 => out.push(faces[i].2),
            2 => pieces.union(faces[i].1 as usize, faces[i + 1].1 as usize),
            _ => conforming = false,
        }
        i = j;
    }
    (out, conforming.then(|| pieces.count()))
}

/// Whether `faces` form closed, consistently wound 2-manifold surfaces: every edge belongs to
/// exactly two faces, once in each direction.
fn closed_manifold(faces: &[[u32; 3]]) -> bool {
    let mut edges: Vec<(u64, bool)> = Vec::with_capacity(faces.len() * 3);
    for f in faces {
        for e in 0..3 {
            let (a, b) = (f[e], f[(e + 1) % 3]);
            edges.push((edge_key(a as usize, b as usize), a < b));
        }
    }
    edges.sort_unstable();
    edges
        .chunks(2)
        .all(|p| p.len() == 2 && p[0].0 == p[1].0 && p[0].1 != p[1].1)
}

struct UnionFind {
    parent: Vec<u32>,
}

impl UnionFind {
    fn new(n: usize) -> UnionFind {
        UnionFind {
            parent: (0..n as u32).collect(),
        }
    }

    fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] as usize != x {
            let up = self.parent[self.parent[x] as usize];
            self.parent[x] = up;
            x = up as usize;
        }
        x
    }

    fn union(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            // The smaller root wins, so the result does not depend on the order of unions.
            self.parent[a.max(b)] = a.min(b) as u32;
        }
    }

    /// Number of separate sets.
    fn count(&mut self) -> usize {
        (0..self.parent.len())
            .filter(|&x| self.find(x) == x)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Builds closed test surfaces; each triangle is wound so its normal agrees with the
    /// outward hint it is given.
    #[derive(Default)]
    struct Shape {
        pos: Vec<V3>,
        tris: Vec<[u32; 3]>,
        ids: Vec<u32>,
    }

    impl Shape {
        fn vertex(&mut self, p: V3) -> u32 {
            self.pos.push(p);
            (self.pos.len() - 1) as u32
        }

        fn tri(&mut self, t: [u32; 3], id: u32, outward: V3) {
            let p = t.map(|i| self.pos[i as usize]);
            let n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
            self.tris.push(if dot(n, outward) < 0.0 {
                [t[0], t[2], t[1]]
            } else {
                t
            });
            self.ids.push(id);
        }

        fn quad(&mut self, q: [u32; 4], id: u32, outward: V3) {
            self.tri([q[0], q[1], q[2]], id, outward);
            self.tri([q[0], q[2], q[3]], id, outward);
        }

        fn centroid(&self, q: &[u32]) -> V3 {
            let s = q
                .iter()
                .fold([0.0; 3], |s, &i| add(s, self.pos[i as usize]));
            scale(s, 1.0 / q.len() as f64)
        }

        fn mesh(self) -> SurfaceMesh {
            SurfaceMesh {
                positions: self.pos,
                triangles: self.tris,
                face_ids: self.ids,
            }
        }
    }

    fn rotate(p: V3, ax: f64, ay: f64, az: f64) -> V3 {
        let (s, c) = ax.sin_cos();
        let p = [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
        let (s, c) = ay.sin_cos();
        let p = [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
        let (s, c) = az.sin_cos();
        [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]
    }

    /// A box `size` with corner at the origin, then `place`d; face ids 2a + side (0 for
    /// minus x, 1 for plus x, ...), two triangles per face.
    fn cuboid(size: V3, place: &dyn Fn(V3) -> V3) -> SurfaceMesh {
        let mut s = Shape::default();
        for i in 0..8 {
            let p = [0, 1, 2].map(|a| if (i >> a) & 1 == 1 { size[a] } else { 0.0 });
            s.vertex(place(p));
        }
        let centre = s.centroid(&[0, 1, 2, 3, 4, 5, 6, 7]);
        for a in 0..3 {
            let (b, c) = ((a + 1) % 3, (a + 2) % 3);
            for side in 0..2u32 {
                let q = [[0, 0], [1, 0], [1, 1], [0, 1]]
                    .map(|[x, y]| ((side as usize) << a | x << b | y << c) as u32);
                let out = sub(s.centroid(&q), centre);
                s.quad(q, 2 * a as u32 + side, out);
            }
        }
        s.mesh()
    }

    /// Latitude and longitude sphere; face id 0 above the equator, 1 below.
    fn sphere(centre: V3, r: f64, nu: usize, nv: usize) -> SurfaceMesh {
        let mut s = Shape::default();
        let north = s.vertex(add(centre, [0.0, 0.0, r]));
        let mut rings = Vec::new();
        for j in 1..nv {
            let th = std::f64::consts::PI * j as f64 / nv as f64;
            let ring: Vec<u32> = (0..nu)
                .map(|i| {
                    let ph = 2.0 * std::f64::consts::PI * i as f64 / nu as f64;
                    s.vertex(add(
                        centre,
                        [
                            r * th.sin() * ph.cos(),
                            r * th.sin() * ph.sin(),
                            r * th.cos(),
                        ],
                    ))
                })
                .collect();
            rings.push(ring);
        }
        let south = s.vertex(add(centre, [0.0, 0.0, -r]));
        for i in 0..nu {
            let i1 = (i + 1) % nu;
            let t = [north, rings[0][i], rings[0][i1]];
            let out = sub(s.centroid(&t), centre);
            s.tri(t, 0, out);
            let last = &rings[nv - 2];
            let t = [south, last[i], last[i1]];
            let out = sub(s.centroid(&t), centre);
            s.tri(t, 1, out);
            for j in 0..nv - 2 {
                let q = [rings[j][i], rings[j][i1], rings[j + 1][i1], rings[j + 1][i]];
                let out = sub(s.centroid(&q), centre);
                s.quad(q, if 2 * (j + 1) < nv { 0 } else { 1 }, out);
            }
        }
        s.mesh()
    }

    /// Torus around z with major radius `big` and tube radius `small`, face id 0.
    fn torus(big: f64, small: f64, nu: usize, nv: usize) -> SurfaceMesh {
        let mut s = Shape::default();
        let tau = 2.0 * std::f64::consts::PI;
        let mut grid = vec![vec![0u32; nv]; nu];
        for (i, row) in grid.iter_mut().enumerate() {
            let u = tau * i as f64 / nu as f64;
            for (j, g) in row.iter_mut().enumerate() {
                let v = tau * j as f64 / nv as f64;
                let w = big + small * v.cos();
                *g = s.vertex([w * u.cos(), w * u.sin(), small * v.sin()]);
            }
        }
        for i in 0..nu {
            for j in 0..nv {
                let (i1, j1) = ((i + 1) % nu, (j + 1) % nv);
                let q = [grid[i][j], grid[i1][j], grid[i1][j1], grid[i][j1]];
                let c = s.centroid(&q);
                let r = (c[0] * c[0] + c[1] * c[1]).sqrt();
                let core = [big * c[0] / r, big * c[1] / r, 0.0];
                s.quad(q, 0, sub(c, core));
            }
        }
        s.mesh()
    }

    /// Square plate `2 half` wide and `thick` high with a round hole of radius `r` through it
    /// along z. Face ids: 0 top, 1 bottom, 2 to 5 the sides, 6 the hole.
    fn holed_plate(half: f64, thick: f64, r: f64, segments: usize) -> SurfaceMesh {
        assert_eq!(
            segments % 8,
            0,
            "the square corners must be on the sampled angles"
        );
        let mut s = Shape::default();
        let tau = 2.0 * std::f64::consts::PI;
        let ring = |s: &mut Shape, z: f64| {
            let mut hole = Vec::new();
            let mut outer = Vec::new();
            for k in 0..segments {
                let a = tau * k as f64 / segments as f64;
                let (sn, cs) = a.sin_cos();
                hole.push(s.vertex([r * cs, r * sn, z]));
                let m = cs.abs().max(sn.abs());
                outer.push(s.vertex([half * cs / m, half * sn / m, z]));
            }
            (hole, outer)
        };
        let (hb, ob) = ring(&mut s, 0.0);
        let (ht, ot) = ring(&mut s, thick);
        for k in 0..segments {
            let k1 = (k + 1) % segments;
            s.quad([ht[k], ot[k], ot[k1], ht[k1]], 0, [0.0, 0.0, 1.0]);
            s.quad([hb[k], ob[k], ob[k1], hb[k1]], 1, [0.0, 0.0, -1.0]);
            let q = [ob[k], ob[k1], ot[k1], ot[k]];
            let c = s.centroid(&q);
            let side = if c[0].abs() > c[1].abs() {
                if c[0] < 0.0 {
                    2
                } else {
                    3
                }
            } else if c[1] < 0.0 {
                4
            } else {
                5
            };
            s.quad(q, side, [c[0], c[1], 0.0]);
            let q = [hb[k], hb[k1], ht[k1], ht[k]];
            let c = s.centroid(&q);
            s.quad(q, 6, [-c[0], -c[1], 0.0]);
        }
        s.mesh()
    }

    /// Both surfaces as one mesh.
    fn join(a: &SurfaceMesh, b: &SurfaceMesh) -> SurfaceMesh {
        let mut m = a.clone();
        let off = m.positions.len() as u32;
        m.positions.extend_from_slice(&b.positions);
        m.triangles
            .extend(b.triangles.iter().map(|t| t.map(|i| i + off)));
        m.face_ids.extend_from_slice(&b.face_ids);
        m
    }

    fn surface_volume(m: &SurfaceMesh) -> f64 {
        m.triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| m.positions[i as usize]);
                dot(a, cross(b, c)) / 6.0
            })
            .sum()
    }

    fn mesh(surface: &SurfaceMesh, size: f64) -> (TetMesh, MeshStats) {
        tetrahedralize(surface, &MeshOptions { size, max_tets: 0 }, &mut || true).expect("meshes")
    }

    /// Checks the mesh invariants: positive tetrahedra, every node used, conforming, `pieces`
    /// face-connected pieces, a closed and consistently wound boundary enclosing the elements.
    fn audit(m: &TetMesh, stats: &MeshStats, pieces: usize) -> Result<(), String> {
        let mut used = vec![false; m.nodes.len()];
        for t in &m.tets {
            let p = t.map(|i| m.nodes[i as usize]);
            if orient(&p) <= 0.0 {
                return Err(format!("tetrahedron {t:?} is not positively oriented"));
            }
            for &i in t {
                used[i as usize] = true;
            }
        }
        if !used.iter().all(|&u| u) {
            return Err("unused nodes".into());
        }

        // Conforming: no face is shared by more than two tetrahedra. Tetrahedra sharing a
        // face are one piece.
        let mut faces: Vec<([u32; 3], usize)> = Vec::new();
        for (k, &[a, b, c, d]) in m.tets.iter().enumerate() {
            for mut f in [[a, b, c], [a, b, d], [a, c, d], [b, c, d]] {
                f.sort_unstable();
                faces.push((f, k));
            }
        }
        faces.sort_unstable();
        let mut root: Vec<usize> = (0..m.tets.len()).collect();
        fn find(root: &mut [usize], mut x: usize) -> usize {
            while root[x] != x {
                x = root[x];
            }
            x
        }
        for w in faces.windows(3) {
            if w[0].0 == w[2].0 {
                return Err(format!(
                    "face {:?} shared by more than two tetrahedra",
                    w[0].0
                ));
            }
        }
        for w in faces.windows(2) {
            if w[0].0 == w[1].0 {
                let (x, y) = (find(&mut root, w[0].1), find(&mut root, w[1].1));
                root[x.max(y)] = x.min(y);
            }
        }
        let found = (0..m.tets.len())
            .filter(|&k| find(&mut root, k) == k)
            .count();
        if found != pieces {
            return Err(format!("{found} pieces, expected {pieces}"));
        }

        // The boundary is closed and consistently wound: each directed edge appears once and
        // its reverse once.
        if m.boundary.len() != m.boundary_face.len() {
            return Err("boundary faces and their ids differ in number".into());
        }
        let mut directed: Vec<(u32, u32)> = Vec::new();
        for f in &m.boundary {
            for e in 0..3 {
                directed.push((f[e], f[(e + 1) % 3]));
            }
        }
        directed.sort_unstable();
        for w in directed.windows(2) {
            if w[0] == w[1] {
                return Err(format!(
                    "boundary edge {:?} used twice in one direction",
                    w[0]
                ));
            }
        }
        for &(a, b) in &directed {
            if directed.binary_search(&(b, a)).is_err() {
                return Err(format!("boundary edge ({a}, {b}) is open"));
            }
        }
        let enclosed: f64 = m
            .boundary
            .iter()
            .map(|f| {
                let [a, b, c] = f.map(|i| m.nodes[i as usize]);
                dot(a, cross(b, c)) / 6.0
            })
            .sum();
        if (enclosed - stats.volume).abs() > 1e-9 * stats.volume {
            return Err(format!(
                "boundary encloses {enclosed}, tetrahedra fill {}",
                stats.volume
            ));
        }
        Ok(())
    }

    /// Meshes one solid, checks the mesh invariants and quality, and returns the relative
    /// volume error against the surface.
    fn check(name: &str, surface: &SurfaceMesh, size: f64) -> (TetMesh, MeshStats, f64) {
        let start = Instant::now();
        let (m, stats) = mesh(surface, size);
        let took = start.elapsed();
        if let Err(e) = audit(&m, &stats, 1) {
            panic!("{name}: {e}");
        }

        let reference = surface_volume(surface);
        let err = (stats.volume - reference) / reference;
        eprintln!(
            "{name:>22}: {:>7} tets {:>6} nodes, size {:.3}, dihedral {:6.2} to {:6.2} deg, volume error {:+.3}%, {:.0} ms",
            m.tets.len(),
            m.nodes.len(),
            stats.size,
            stats.min_dihedral_deg,
            stats.max_dihedral_deg,
            100.0 * err,
            took.as_secs_f64() * 1e3
        );
        assert!(
            stats.min_dihedral_deg > 9.0,
            "{name}: min dihedral {}",
            stats.min_dihedral_deg
        );
        assert!(
            stats.max_dihedral_deg < 166.0,
            "{name}: max dihedral {}",
            stats.max_dihedral_deg
        );
        (m, stats, err)
    }

    #[test]
    fn lattice_tetrahedra_are_positive_and_fill_space() {
        let lat = Lattice::new([0.0; 3], [3.0, 4.0, 5.0], 1.0);
        let mut nb = [(0usize, false); 14];
        // Neighbours are mutual, long edges have length h and short ones h sqrt(3) / 2.
        for v in 0..lat.count() {
            let k = lat.neighbors(v, &mut nb);
            let (_, c) = lat.coords(v);
            if c.iter().zip(lat.n).all(|(&x, n)| x >= 1 && x + 1 < n) {
                assert_eq!(k, 14);
            }
            for &(u, long) in &nb[..k] {
                let d = norm(sub(lat.position(u), lat.position(v)));
                assert!((d - if long { 1.0 } else { 0.75f64.sqrt() }).abs() < 1e-12);
                let mut back = [(0usize, false); 14];
                let kb = lat.neighbors(u, &mut back);
                assert!(back[..kb].iter().any(|&(w, _)| w == v));
            }
        }
        // Every lattice vertex is inside: the stencils emit the lattice tetrahedra themselves,
        // which must be positive and fill the region the lattice tetrahedra cover.
        let sign = vec![IN; lat.count()];
        let pos: Vec<V3> = (0..lat.count()).map(|v| lat.position(v)).collect();
        let surf = Surface::new(&cuboid([3.0, 4.0, 5.0], &|p| p)).unwrap();
        let cut_of = CutMap::default();
        let mut st = Stencils {
            lat: &lat,
            pos: &pos,
            sign: &sign,
            cuts: &[],
            cut_of: &cut_of,
            surf: &surf,
            tets: Vec::new(),
        };
        let n = lat.n;
        let mut vol = 0.0;
        for a in 0..3 {
            let (b, c) = ((a + 1) % 3, (a + 2) % 3);
            for z in 0..=n[2] {
                for y in 0..=n[1] {
                    for x in 0..=n[0] {
                        let p = [x, y, z];
                        if p[a] >= n[a] || p[b] == 0 || p[b] >= n[b] || p[c] == 0 || p[c] >= n[c] {
                            continue;
                        }
                        let mut q = p;
                        q[a] += 1;
                        let ring = [[0, 0], [1, 0], [1, 1], [0, 1]].map(|[db, dc]| {
                            let mut r = p;
                            r[b] = r[b] - 1 + db;
                            r[c] = r[c] - 1 + dc;
                            lat.red(r)
                        });
                        for k in 0..4 {
                            let t = [lat.black(p), lat.black(q), ring[k], ring[(k + 1) % 4]];
                            let o = orient(&t.map(|v| pos[v]));
                            assert!(o > 0.0, "lattice template must be positive");
                            vol += o / 6.0;
                            st.fill(t);
                        }
                    }
                }
            }
        }
        assert!((st.tets.len() as f64 - vol * 12.0).abs() < 1e-6);
        let (lo, hi) = dihedral_range(&st.tets[0].map(|i| pos[i as usize]));
        assert!((lo.to_degrees() - 60.0).abs() < 1e-9 && (hi.to_degrees() - 90.0).abs() < 1e-9);
    }

    #[test]
    fn signed_distance_matches_a_sphere() {
        let r = 5.0;
        let surf = Surface::new(&sphere([0.0; 3], r, 96, 48)).unwrap();
        let mut seed = 12345u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..4000 {
            let p = [0, 1, 2].map(|_| (rnd() * 2.0 - 1.0) * 1.6 * r);
            let exact = norm(p) - r;
            let (f, q) = surf.signed(p, f64::INFINITY);
            if exact.abs() > 0.02 * r {
                assert_eq!(f < 0.0, exact < 0.0, "sign at {p:?}");
            }
            assert!(
                (f - exact).abs() < 0.01 * r,
                "distance at {p:?}: {f} vs {exact}"
            );
            assert!((norm(q) - r).abs() < 0.01 * r);
        }
    }

    #[test]
    fn aligned_cube_is_exact() {
        let cube = cuboid([10.0; 3], &|p| p);
        let (m, _, err) = check("aligned cube", &cube, 1.0);
        assert!(err.abs() < 1e-9, "volume error {err}");
        // Lattice-aligned faces cut the boundary tetrahedra exactly in half.
        assert_eq!(m.tets.len(), 13200);
    }

    #[test]
    fn cube_volume_closed_boundary_and_quality() {
        let cube = cuboid([10.0; 3], &|p| {
            add(rotate(p, 0.3, 0.5, 0.7), [0.37, -1.21, 2.05])
        });
        let (_, _, err) = check("rotated cube", &cube, 0.5);
        assert!(err.abs() < 0.01, "volume error {err}");
        let cube = cuboid([10.0; 3], &|p| add(p, [0.37, 0.0, 0.0]));
        let (_, _, err) = check("shifted cube", &cube, 0.7);
        assert!(err.abs() < 0.01, "volume error {err}");
    }

    #[test]
    fn face_ids_follow_face_area() {
        let size = [10.0, 14.0, 18.0];
        let body = cuboid(size, &|p| rotate(p, 0.2, -0.4, 0.9));
        let (m, _, _) = check("tagged box", &body, 0.8);
        let mut area = [0.0; 6];
        for (f, &id) in m.boundary.iter().zip(&m.boundary_face) {
            let [a, b, c] = f.map(|i| m.nodes[i as usize]);
            area[id as usize] += 0.5 * norm(cross(sub(b, a), sub(c, a)));
        }
        let total: f64 = area.iter().sum();
        for id in 0..6 {
            let a = id / 2;
            let exact = size[(a + 1) % 3] * size[(a + 2) % 3];
            let exact_total = 2.0 * (size[0] * size[1] + size[1] * size[2] + size[2] * size[0]);
            let (got, want) = (area[id] / total, exact / exact_total);
            assert!(
                ((got - want) / want).abs() < 0.04,
                "face {id}: fraction {got:.4}, area says {want:.4}"
            );
        }
    }

    #[test]
    fn sphere_volume() {
        let s = sphere([0.31, -0.17, 0.05], 10.0, 128, 64);
        let (_, _, err) = check("sphere", &s, 0.8);
        assert!(err.abs() < 0.02, "volume error {err}");
    }

    #[test]
    fn torus_volume() {
        let t = torus(10.0, 4.0, 128, 48);
        let (_, _, err) = check("torus", &t, 0.6);
        assert!(err.abs() < 0.03, "volume error {err}");
    }

    #[test]
    fn thin_plate_two_elements_thick() {
        let thick = 2.0;
        let plate = cuboid([30.0, 20.0, thick], &|p| rotate(p, 0.11, -0.07, 0.4));
        let (m, _, err) = check("plate 2 elements thick", &plate, thick / 2.0);
        assert!(err.abs() < 0.03, "volume error {err}");
        // Every element sits inside the plate's thickness.
        let normal = rotate([0.0, 0.0, 1.0], 0.11, -0.07, 0.4);
        for p in &m.nodes {
            let z = dot(*p, normal);
            assert!(z > -1e-6 && z < thick + 1e-6, "node at height {z}");
        }
    }

    #[test]
    fn body_with_a_through_hole() {
        let body = holed_plate(10.0, 6.0, 4.0, 64);
        let (m, _, err) = check("plate with a hole", &body, 0.7);
        assert!(err.abs() < 0.03, "volume error {err}");
        // The boundary is one surface of genus 1: V - E + F = 0.
        let mut verts: Vec<u32> = m.boundary.iter().flatten().copied().collect();
        verts.sort_unstable();
        verts.dedup();
        let edges = m.boundary.len() * 3 / 2;
        assert_eq!(
            verts.len() as i64 - edges as i64 + m.boundary.len() as i64,
            0
        );
        // Nothing fills the hole, and its wall is tagged.
        for t in &m.tets {
            let c = scale(
                t.iter().fold([0.0; 3], |s, &i| add(s, m.nodes[i as usize])),
                0.25,
            );
            assert!(
                c[0].hypot(c[1]) > 4.0 - 0.7,
                "element inside the hole at {c:?}"
            );
        }
        let mut ids: Vec<u32> = m.boundary_face.clone();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn deterministic() {
        let s = torus(6.0, 2.5, 64, 24);
        let a = mesh(&s, 0.5);
        let b = mesh(&s, 0.5);
        assert!(a == b);
    }

    #[test]
    fn max_tets_coarsens_the_mesh() {
        let s = sphere([0.0; 3], 10.0, 64, 32);
        let (m, stats) = tetrahedralize(
            &s,
            &MeshOptions {
                size: 0.3,
                max_tets: 20_000,
            },
            &mut || true,
        )
        .unwrap();
        assert!(m.tets.len() <= 20_000, "{} tets", m.tets.len());
        assert!(m.tets.len() > 10_000, "{} tets", m.tets.len());
        assert!(stats.size > 0.3);
    }

    #[test]
    fn errors_read_well() {
        let cube = cuboid([10.0; 3], &|p| p);
        let opts = MeshOptions {
            size: 1.0,
            max_tets: 0,
        };

        let mut open = cube.clone();
        open.triangles.pop();
        open.face_ids.pop();
        let e = tetrahedralize(&open, &opts, &mut || true).unwrap_err();
        assert_eq!(e, MeshError::OpenSurface { open_edges: 3 });
        assert!(e.to_string().starts_with("the surface is open"));

        let mut flipped = cube.clone();
        for t in &mut flipped.triangles {
            t.swap(1, 2);
        }
        assert_eq!(
            tetrahedralize(&flipped, &opts, &mut || true).unwrap_err(),
            MeshError::InsideOut
        );

        let tiny = cuboid([0.2; 3], &|p| add(p, [0.3, 0.3, 0.3]));
        let e = tetrahedralize(
            &tiny,
            &MeshOptions {
                size: 2.0,
                max_tets: 0,
            },
            &mut || true,
        )
        .unwrap_err();
        assert_eq!(
            e,
            MeshError::TooSmall {
                size: 2.0,
                coarsening: Coarsening::None
            }
        );
        assert_eq!(
            e.to_string(),
            "the part is thinner than one element of 2.000 mm, so no element fits inside it, use a smaller element size"
        );

        assert_eq!(
            tetrahedralize(
                &cube,
                &MeshOptions {
                    size: 0.0,
                    max_tets: 0
                },
                &mut || true
            )
            .unwrap_err(),
            MeshError::InvalidSize(0.0)
        );
        let mut short = cube.clone();
        short.face_ids.pop();
        assert!(matches!(
            tetrahedralize(&short, &opts, &mut || true),
            Err(MeshError::FaceIdCount { .. })
        ));
        assert_eq!(
            tetrahedralize(&SurfaceMesh::default(), &opts, &mut || true).unwrap_err(),
            MeshError::EmptySurface
        );

        // Cancelling partway through, and the progress callback is called often.
        let mut calls = 0;
        let e = tetrahedralize(
            &cube,
            &MeshOptions {
                size: 0.25,
                max_tets: 0,
            },
            &mut || {
                calls += 1;
                calls < 20
            },
        )
        .unwrap_err();
        assert_eq!(e, MeshError::Cancelled);
        assert_eq!(e.to_string(), "meshing was cancelled");
        let mut calls = 0;
        tetrahedralize(&cube, &opts, &mut || {
            calls += 1;
            true
        })
        .unwrap();
        assert!(calls > 20, "{calls} progress calls");
    }

    #[test]
    fn fifty_thousand_tets_timing() {
        // Debug builds are far slower; the timing target is for release.
        let (r, size, surface_res) = if cfg!(debug_assertions) {
            (10.0, 1.6, (128, 64))
        } else {
            (10.0, 1.0, (384, 192))
        };
        let s = sphere([0.0; 3], r, surface_res.0, surface_res.1);
        let start = Instant::now();
        let (m, stats) = mesh(&s, size);
        let took = start.elapsed();
        eprintln!(
            "timing: {} tets from {} surface triangles in {:.0} ms (min dihedral {:.2})",
            m.tets.len(),
            s.triangles.len(),
            took.as_secs_f64() * 1e3,
            stats.min_dihedral_deg
        );
        if !cfg!(debug_assertions) {
            assert!(m.tets.len() >= 50_000, "{} tets", m.tets.len());
        }
    }

    #[test]
    fn quality_over_random_shapes_and_placements() {
        // Many sign patterns, warps and stencils: spheres, tori and boxes of random size,
        // position and rotation against the lattice.
        let mut seed = 99u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let count = if cfg!(debug_assertions) { 15 } else { 90 };
        let mut worst = (180.0f64, 0.0f64);
        for k in 0..count {
            let off = [rnd(), rnd(), rnd()];
            let s = match k % 3 {
                0 => sphere(off, 1.5 + 6.0 * rnd(), 64, 32),
                1 => torus(3.0 + 4.0 * rnd(), 1.0 + 1.5 * rnd(), 64, 24),
                _ => {
                    let (a, b, c) = (rnd() * 3.0, rnd() * 3.0, rnd() * 3.0);
                    let size = [2.0 + 6.0 * rnd(), 2.0 + 6.0 * rnd(), 1.5 + 6.0 * rnd()];
                    cuboid(size, &|p| add(rotate(p, a, b, c), off))
                }
            };
            let (_, stats) = mesh(&s, 0.5);
            worst = (
                worst.0.min(stats.min_dihedral_deg),
                worst.1.max(stats.max_dihedral_deg),
            );
        }
        eprintln!(
            "worst dihedral over {count} random meshes: {:.2} to {:.2} deg",
            worst.0, worst.1
        );
        assert!(
            worst.0 >= PAPER_DIHEDRAL[0] && worst.1 <= PAPER_DIHEDRAL[1],
            "{worst:?}"
        );
    }

    #[test]
    fn thin_parts_are_refused_not_broken() {
        // Walls and gaps around one element: the mesh is either sound, with the right number of
        // pieces and most of the volume, or refused. Never hinged, split or bridged.
        let mut seed = 7u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let h = 0.5;
        let mut refused = 0;
        let mut meshed = 0;
        for case in 0..60 {
            let (a, b, c) = (rnd() * 3.0, rnd() * 3.0, rnd() * 3.0);
            let off = [rnd(), rnd(), rnd()];
            let place = |p: V3| add(rotate(p, a, b, c), off);
            let k = case % 6;
            let (s, pieces) = if k < 3 {
                // Plates 0.5, 0.75 and 1 element thick.
                let t = h * [0.5, 0.75, 1.0][k];
                (cuboid([6.0, 5.0, t], &place), 1)
            } else {
                // Two cubes 0.5, 0.75 and 1 element apart.
                let gap = h * [0.5, 0.75, 1.0][k - 3];
                let one = cuboid([3.0; 3], &place);
                let two = cuboid([3.0; 3], &|p| place(add(p, [3.0 + gap, 0.0, 0.0])));
                (join(&one, &two), 2)
            };
            let name = format!("case {case}");
            match tetrahedralize(
                &s,
                &MeshOptions {
                    size: h,
                    max_tets: 0,
                },
                &mut || true,
            ) {
                Ok((m, stats)) => {
                    if let Err(e) = audit(&m, &stats, pieces) {
                        panic!("{name}: {e}");
                    }
                    let reference = surface_volume(&s);
                    assert!(
                        (stats.volume - reference).abs() <= MAX_VOLUME_CHANGE * reference,
                        "{name}: volume {} of {reference}",
                        stats.volume
                    );
                    meshed += 1;
                }
                Err(e) => {
                    assert!(
                        matches!(
                            e,
                            MeshError::TooThin {
                                coarsening: Coarsening::None,
                                ..
                            } | MeshError::TooSmall {
                                coarsening: Coarsening::None,
                                ..
                            }
                        ),
                        "{name}: {e:?}"
                    );
                    refused += 1;
                }
            }
        }
        eprintln!("thin parts: {meshed} meshed, {refused} refused");
        assert!(refused > 0 && meshed > 0);

        // Half an element thick never meshes, nor does a gap three quarters of an element wide.
        let plate = cuboid([6.0, 5.0, 0.25], &|p| rotate(p, 0.3, 0.2, 0.1));
        let e = tetrahedralize(
            &plate,
            &MeshOptions {
                size: h,
                max_tets: 0,
            },
            &mut || true,
        )
        .unwrap_err();
        assert!(matches!(e, MeshError::TooThin { .. }), "{e:?}");
        assert_eq!(
            e.to_string(),
            "parts of the body are thinner than about one element of 0.500 mm, so the mesh would come apart or lose material there, use a smaller element size"
        );
        let place = |p: V3| rotate(p, 0.3, 0.2, 0.1);
        let one = cuboid([3.0; 3], &place);
        let two = cuboid([3.0; 3], &|p| place(add(p, [3.375, 0.0, 0.0])));
        let e = tetrahedralize(
            &join(&one, &two),
            &MeshOptions {
                size: h,
                max_tets: 0,
            },
            &mut || true,
        )
        .unwrap_err();
        assert!(matches!(e, MeshError::TooThin { .. }), "{e:?}");
    }

    #[test]
    fn hollow_body_is_one_piece() {
        let outer = sphere([0.1, 0.2, 0.3], 5.0, 64, 32);
        let mut inner = sphere([0.1, 0.2, 0.3], 3.0, 64, 32);
        for t in &mut inner.triangles {
            t.swap(1, 2);
        }
        let s = join(&outer, &inner);
        let (m, stats) = mesh(&s, 0.5);
        audit(&m, &stats, 1).unwrap();
        let reference = surface_volume(&s);
        assert!(((stats.volume - reference) / reference).abs() < 0.02);
    }

    #[test]
    fn coarsening_errors_ask_for_more_elements() {
        // The element limit, not the size asked for, makes the elements too large.
        let cube = cuboid([10.0; 3], &|p| p);
        let e = tetrahedralize(
            &cube,
            &MeshOptions {
                size: 1.0,
                max_tets: 1,
            },
            &mut || true,
        )
        .unwrap_err();
        assert!(
            matches!(
                e,
                MeshError::TooSmall {
                    coarsening: Coarsening::ElementLimit { max_tets: 1 },
                    ..
                }
            ),
            "{e:?}"
        );
        let text = e.to_string();
        assert!(
            text.ends_with(
                "the limit of 1 elements forces elements this large, allow more elements"
            ) && !text.contains("smaller"),
            "{text}"
        );

        // A large thin plate at the default limit grows the size past its thickness.
        let plate = cuboid([100.0, 100.0, 1.0], &|p| rotate(p, 0.01, 0.02, 0.3));
        let e = tetrahedralize(
            &plate,
            &MeshOptions {
                size: 0.5,
                max_tets: 60_000,
            },
            &mut || true,
        )
        .unwrap_err();
        let MeshError::TooThin { size, coarsening } = e else {
            panic!("{e:?}");
        };
        assert!(size > 1.0, "{size}");
        assert_eq!(coarsening, Coarsening::ElementLimit { max_tets: 60_000 });
        assert!(e.to_string().ends_with(
            "the limit of 60000 elements forces elements this large, allow more elements"
        ));
    }

    #[test]
    fn tiny_sizes_do_not_overflow_the_lattice() {
        let surf = Surface::new(&cuboid([10.0; 3], &|p| p)).unwrap();
        for (max_tets, want) in [
            (0, Coarsening::LatticeLimit),
            (60_000, Coarsening::ElementLimit { max_tets: 60_000 }),
        ] {
            for size in [1e-7, 1e-30, f64::MIN_POSITIVE] {
                let (h, coarsening) = choose_size(&surf, &MeshOptions { size, max_tets });
                assert_eq!(coarsening, want);
                assert!(h.is_finite() && h > size);
                assert!(Lattice::vertices(surf.lo, surf.hi, h) <= MAX_LATTICE as f64);
            }
        }
        // A sensible size is left alone.
        let (h, coarsening) = choose_size(
            &surf,
            &MeshOptions {
                size: 1.0,
                max_tets: 0,
            },
        );
        assert_eq!((h, coarsening), (1.0, Coarsening::None));
    }
}
