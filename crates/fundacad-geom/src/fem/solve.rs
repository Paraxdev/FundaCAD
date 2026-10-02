//! Linear static analysis on quadratic tetrahedra (TET10), in mm, N and MPa.
//!
//! The linear mesh is promoted to TET10 by adding one node halfway along every edge, so the
//! geometry map stays affine and the shape function gradients of an element are exact from
//! its four corners. The stiffness is integrated with the 4-point Gauss rule, exact for TET10.
//! Nodes on fixed faces are held in all three directions and eliminated; the rest form a
//! sparse symmetric positive definite system, assembled straight into its lower triangle in
//! element order and factorised by faer's sparse Cholesky on one thread, so the same mesh
//! gives the same bits every run. Stress is evaluated at element corners (exact for the linear
//! strain of TET10), averaged per corner node, and a mid-edge node takes the mean of its ends.

use std::fmt;

use faer::dyn_stack::{MemBuffer, MemStack};
use faer::perm::PermRef;
use faer::sparse::linalg::cholesky::{factorize_symbolic_cholesky, SymmetricOrdering};
use faer::sparse::{SparseColMatRef, SymbolicSparseColMatRef};
use faer::{Conj, MatMut, Par, Side};

use super::TetMesh;

type V3 = [f64; 3];

const TICK_EVERY: usize = 256;

/// The corner pair of each mid-edge node of an element, TET10 local nodes 4 to 9.
const EDGES: [[usize; 2]; 6] = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]];
/// The 4-point Gauss rule (degree 2) in barycentric coordinates; each point weighs a quarter
/// of the volume.
const GAUSS_A: f64 = 0.585_410_196_624_968_5;
const GAUSS_B: f64 = 0.138_196_601_125_010_5;
const GAUSS: [[f64; 4]; 4] = [
    [GAUSS_A, GAUSS_B, GAUSS_B, GAUSS_B],
    [GAUSS_B, GAUSS_A, GAUSS_B, GAUSS_B],
    [GAUSS_B, GAUSS_B, GAUSS_A, GAUSS_B],
    [GAUSS_B, GAUSS_B, GAUSS_B, GAUSS_A],
];
/// Points closer to a line than this fraction of their spread count as on it.
const COLLINEAR: f64 = 1e-9;

/// An isotropic linear elastic material: Young's modulus in MPa and Poisson's ratio.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Material {
    pub e: f64,
    pub nu: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LoadKind {
    /// A total force in N, spread uniformly by area over the faces.
    Force([f64; 3]),
    /// A pressure in MPa pushing into the faces, along minus their outward normal.
    Pressure(f64),
}

/// A load on the boundary triangles tagged with any of `faces`.
#[derive(Debug, Clone, PartialEq)]
pub struct Load {
    pub faces: Vec<u32>,
    pub kind: LoadKind,
}

/// A linear static problem: the mesh, its material, the face ids held still, and the loads.
#[derive(Debug, Clone)]
pub struct Problem<'a> {
    pub mesh: &'a TetMesh,
    pub material: Material,
    pub fixed: Vec<u32>,
    pub loads: Vec<Load>,
}

/// The solved fields on the TET10 nodes. The first `corners` nodes are the linear mesh's
/// nodes in their order, so `displacement[..corners]` and `von_mises[..corners]` go with
/// `TetMesh::nodes`, and node `corners + i` sits halfway along `edges[i]`.
#[derive(Debug, Clone, PartialEq)]
pub struct Solution {
    pub nodes: Vec<V3>,
    pub corners: usize,
    pub edges: Vec<[u32; 2]>,
    /// mm.
    pub displacement: Vec<V3>,
    /// Smoothed Cauchy stress in MPa, [xx, yy, zz, xy, yz, zx].
    pub stress: Vec<[f64; 6]>,
    /// MPa, from the smoothed stress.
    pub von_mises: Vec<f64>,
    pub max_von_mises: f64,
    pub max_von_mises_node: u32,
    pub max_displacement: f64,
    pub max_displacement_node: u32,
    /// The sum of the applied loads, N.
    pub applied: V3,
    /// The sum of the forces the fixed faces exert on the body, N; balances `applied`.
    pub reaction: V3,
    /// N mm (mJ).
    pub strain_energy: f64,
    /// Unknowns solved for (free nodes times three).
    pub dofs: usize,
    pub elements: usize,
    /// Fixed face ids that no boundary triangle carries, so they hold nothing.
    pub missing_fixed: Vec<u32>,
}

impl Solution {
    /// Von Mises stress at the linear mesh's nodes.
    pub fn corner_von_mises(&self) -> &[f64] {
        &self.von_mises[..self.corners]
    }

    /// Displacement of the linear mesh's nodes.
    pub fn corner_displacement(&self) -> &[V3] {
        &self.displacement[..self.corners]
    }
}

/// Why a problem could not be solved. The messages are written for the person running the
/// analysis and leave out face ids, which mean nothing to them; the variants keep the ids so
/// the caller can name the face its own way.
#[derive(Debug, Clone, PartialEq)]
pub enum SolveError {
    InvalidMaterial(Material),
    InvalidMesh(String),
    /// `Problem::fixed` is empty.
    NoFixedFaces,
    /// None of the fixed faces has a boundary triangle, so nothing is held.
    FixedFacesNotMeshed {
        faces: Vec<u32>,
    },
    EmptyLoad {
        load: usize,
    },
    /// A force or pressure that is not a finite number.
    InvalidLoad {
        load: usize,
    },
    /// A face of `loads[load]` has no boundary triangle, so the load cannot be applied.
    MissingLoadFace {
        load: usize,
        face: u32,
    },
    /// Pieces of the mesh that no fixed face holds. `hinged` when the first of them touches
    /// a held piece along an edge or at a point, which it can turn about.
    NotHeld {
        loose: usize,
        near: V3,
        hinged: bool,
    },
    Singular,
    /// The solution overflowed, from loads far too large for the material.
    Overflow,
    /// The factorisation would need `needed` bytes, more than the `limit` it may use.
    TooLarge {
        needed: u64,
        limit: u64,
    },
    OutOfMemory,
    Cancelled,
}

impl fmt::Display for SolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SolveError::InvalidMaterial(m) => write!(
                f,
                "the material needs a Young's modulus above 0 and a Poisson's ratio between -1 and 0.5, got E = {} MPa and nu = {}",
                m.e, m.nu
            ),
            SolveError::InvalidMesh(why) => write!(f, "the volume mesh is not usable, {why}"),
            SolveError::NoFixedFaces => {
                write!(f, "no face is fixed, fix at least one face so the body is held")
            }
            SolveError::FixedFacesNotMeshed { faces } => {
                if faces.len() == 1 {
                    write!(f, "the fixed face got no elements, it is")?;
                } else {
                    write!(f, "none of the fixed faces got any elements, they are")?;
                }
                write!(
                    f,
                    " probably narrower than the element size, use a smaller element size or fix a larger face"
                )
            }
            SolveError::EmptyLoad { load } => write!(f, "loads[{load}] names no faces"),
            SolveError::InvalidLoad { load } => {
                write!(f, "the force or pressure of loads[{load}] is not a finite number")
            }
            SolveError::MissingLoadFace { load, .. } => write!(
                f,
                "a face of loads[{load}] got no elements, it is probably narrower than the element size, use a smaller element size"
            ),
            SolveError::NotHeld { loose, near, hinged } => {
                let [x, y, z] = near;
                if *hinged {
                    write!(
                        f,
                        "the body is not held and can still move, the piece near ({x:.3}, {y:.3}, {z:.3}) mm hangs on the rest by a single edge or corner and can turn about it"
                    )?;
                } else {
                    write!(
                        f,
                        "the body is not held and can still move, the piece near ({x:.3}, {y:.3}, {z:.3}) mm is not connected to a fixed face"
                    )?;
                }
                if *loose > 1 {
                    write!(f, " ({loose} pieces are loose)")?;
                }
                Ok(())
            }
            SolveError::Singular => write!(
                f,
                "the body is not held and can still move, its stiffness matrix is singular, fix more faces or check the mesh for flat elements"
            ),
            SolveError::Overflow => write!(
                f,
                "the displacements are too large to compute, check the size of the loads against the material's Young's modulus"
            ),
            SolveError::TooLarge { needed, limit } => write!(
                f,
                "solving this mesh needs about {:.1} GB of memory, more than the {:.1} GB it may use, use a larger element size or fewer elements",
                *needed as f64 / 1e9,
                *limit as f64 / 1e9
            ),
            SolveError::OutOfMemory => write!(
                f,
                "there is not enough memory to solve this mesh, use a larger element size"
            ),
            SolveError::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl std::error::Error for SolveError {}

/// The most memory the Cholesky factor and its scratch may take, however much the machine has.
/// Time grows faster than memory (about 25 s for 2.3 GB on one core), and a cancel only takes
/// effect once the factorisation is over, so this also bounds the wait.
pub const FACTOR_MEMORY_CAP: u64 = 3 << 30;
/// The share of the memory the system reports available (Linux only) the factor may take.
/// Allocation alone does not fail when memory runs out there, the process is killed later.
const AVAILABLE_SHARE: f64 = 0.6;

/// Solves `p`. `tick` is called often; returning false cancels.
pub fn solve(p: &Problem, tick: &mut dyn FnMut() -> bool) -> Result<Solution, SolveError> {
    solve_with(p, tick, &mut |f| f())
}

/// [`solve`], running the factorisation, one long call that cannot tick, inside `long`
/// (the engine passes a closure that keeps its heartbeat going meanwhile). A cancel during
/// the factorisation takes effect when it returns.
pub fn solve_with(
    p: &Problem,
    tick: &mut dyn FnMut() -> bool,
    long: &mut dyn FnMut(&mut dyn FnMut()),
) -> Result<Solution, SolveError> {
    solve_within(p, tick, long, memory_limit())
}

/// The bytes the factorisation may use here.
fn memory_limit() -> u64 {
    match available_memory() {
        Some(free) => FACTOR_MEMORY_CAP.min((free as f64 * AVAILABLE_SHARE) as u64),
        None => FACTOR_MEMORY_CAP,
    }
}

#[cfg(target_os = "linux")]
fn available_memory() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find(|l| l.starts_with("MemAvailable:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

#[cfg(not(target_os = "linux"))]
fn available_memory() -> Option<u64> {
    None
}

fn solve_within(
    p: &Problem,
    tick: &mut dyn FnMut() -> bool,
    long: &mut dyn FnMut(&mut dyn FnMut()),
    limit: u64,
) -> Result<Solution, SolveError> {
    let m = p.material;
    if !(m.e.is_finite() && m.e > 0.0 && m.nu.is_finite() && m.nu > -1.0 && m.nu < 0.5) {
        return Err(SolveError::InvalidMaterial(m));
    }
    let mesh = p.mesh;
    check_mesh(mesh)?;

    let mut present = mesh.boundary_face.clone();
    present.sort_unstable();
    present.dedup();
    let has = |id: &u32| present.binary_search(id).is_ok();
    let fixed = sorted(&p.fixed);
    if fixed.is_empty() {
        return Err(SolveError::NoFixedFaces);
    }
    let missing_fixed: Vec<u32> = fixed.iter().copied().filter(|id| !has(id)).collect();
    if missing_fixed.len() == fixed.len() {
        return Err(SolveError::FixedFacesNotMeshed {
            faces: missing_fixed,
        });
    }
    for (i, load) in p.loads.iter().enumerate() {
        if load.faces.is_empty() {
            return Err(SolveError::EmptyLoad { load: i });
        }
        let finite = match load.kind {
            LoadKind::Force(v) => v.iter().all(|c| c.is_finite()),
            LoadKind::Pressure(v) => v.is_finite(),
        };
        if !finite {
            return Err(SolveError::InvalidLoad { load: i });
        }
        if let Some(&face) = sorted(&load.faces).iter().find(|id| !has(id)) {
            return Err(SolveError::MissingLoadFace { load: i, face });
        }
    }
    if !tick() {
        return Err(SolveError::Cancelled);
    }

    let q = promote(mesh)?;
    let geo = q
        .tets
        .iter()
        .enumerate()
        .map(|(i, t)| {
            geometry([0, 1, 2, 3].map(|k| q.nodes[t[k] as usize])).ok_or_else(|| {
                SolveError::InvalidMesh(format!("element {i} is flat or inside out"))
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut held = vec![false; q.nodes.len()];
    for (tri, face) in q.boundary.iter().zip(&mesh.boundary_face) {
        if fixed.binary_search(face).is_ok() {
            for &n in tri {
                held[n as usize] = true;
            }
        }
    }
    check_held(mesh, &held)?;
    let prescribed: Vec<Option<V3>> = held
        .iter()
        .map(|&h| if h { Some([0.0; 3]) } else { None })
        .collect();
    let f_ext = loads(&q, mesh, &p.loads);
    if !tick() {
        return Err(SolveError::Cancelled);
    }

    let fields = analyse(&q, &geo, lame(m), &prescribed, &f_ext, tick, long, limit)?;
    finish(q, fields, missing_fixed)
}

fn sorted(ids: &[u32]) -> Vec<u32> {
    let mut v = ids.to_vec();
    v.sort_unstable();
    v.dedup();
    v
}

fn check_mesh(mesh: &TetMesh) -> Result<(), SolveError> {
    let n = mesh.nodes.len();
    let bad = |why: &str| Err(SolveError::InvalidMesh(why.to_string()));
    if mesh.tets.is_empty() {
        return bad("it has no elements");
    }
    if n > u32::MAX as usize / 8 {
        return bad("it has too many nodes");
    }
    if mesh.boundary.len() != mesh.boundary_face.len() {
        return bad("its boundary triangles and their face ids differ in number");
    }
    if mesh.nodes.iter().any(|p| p.iter().any(|c| !c.is_finite())) {
        return bad("a node's coordinates are not finite numbers");
    }
    let out = |v: &[u32]| v.iter().any(|&i| i as usize >= n);
    if mesh.tets.iter().any(|t| out(t)) || mesh.boundary.iter().any(|t| out(t)) {
        return bad("an element refers to a node that does not exist");
    }
    Ok(())
}

/// The mesh with a node on every edge.
struct Quadratic {
    nodes: Vec<V3>,
    corners: usize,
    edges: Vec<[u32; 2]>,
    tets: Vec<[u32; 10]>,
    /// The boundary triangles as [corner, corner, corner, mid 01, mid 12, mid 20].
    boundary: Vec<[u32; 6]>,
}

fn promote(mesh: &TetMesh) -> Result<Quadratic, SolveError> {
    let corners = mesh.nodes.len();
    let mut edges: Vec<[u32; 2]> = Vec::with_capacity(mesh.tets.len() * 6);
    for t in &mesh.tets {
        for [a, b] in EDGES {
            let (a, b) = (t[a], t[b]);
            edges.push([a.min(b), a.max(b)]);
        }
    }
    edges.sort_unstable();
    edges.dedup();
    if edges.iter().any(|[a, b]| a == b) {
        return Err(SolveError::InvalidMesh(
            "an element uses the same node twice".into(),
        ));
    }
    let mid = |a: u32, b: u32| {
        edges
            .binary_search(&[a.min(b), a.max(b)])
            .ok()
            .map(|i| (corners + i) as u32)
    };
    let tets = mesh
        .tets
        .iter()
        .map(|t| {
            let mut q = [0u32; 10];
            q[..4].copy_from_slice(t);
            for (k, [a, b]) in EDGES.iter().enumerate() {
                q[4 + k] = mid(t[*a], t[*b]).expect("every element edge is listed");
            }
            q
        })
        .collect();
    let boundary = mesh
        .boundary
        .iter()
        .map(|&[a, b, c]| Some([a, b, c, mid(a, b)?, mid(b, c)?, mid(c, a)?]))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            SolveError::InvalidMesh("a boundary triangle is not a face of any element".into())
        })?;
    let mut nodes = mesh.nodes.clone();
    nodes.extend(edges.iter().map(|&[a, b]| {
        let (p, q) = (mesh.nodes[a as usize], mesh.nodes[b as usize]);
        [0, 1, 2].map(|k| 0.5 * (p[k] + q[k]))
    }));
    Ok(Quadratic {
        nodes,
        corners,
        edges,
        tets,
        boundary,
    })
}

/// Fails when a piece of the mesh can still move. Elements sharing a face move as one rigid
/// piece; a piece is held by three non-collinear points that are fixed or shared with a held
/// piece, which catches loose lumps and pieces hinged on an edge or a corner.
fn check_held(mesh: &TetMesh, held: &[bool]) -> Result<(), SolveError> {
    let nt = mesh.tets.len();
    let mut parent: Vec<u32> = (0..nt as u32).collect();
    fn root(parent: &mut [u32], mut i: u32) -> u32 {
        while parent[i as usize] != i {
            let up = parent[parent[i as usize] as usize];
            parent[i as usize] = up;
            i = up;
        }
        i
    }
    let mut faces: Vec<([u32; 3], u32)> = Vec::with_capacity(nt * 4);
    for (i, t) in mesh.tets.iter().enumerate() {
        for skip in 0..4 {
            let mut f = [0u32; 3];
            let mut k = 0;
            for (j, &n) in t.iter().enumerate() {
                if j != skip {
                    f[k] = n;
                    k += 1;
                }
            }
            f.sort_unstable();
            faces.push((f, i as u32));
        }
    }
    faces.sort_unstable();
    for w in faces.windows(2) {
        if w[0].0 == w[1].0 {
            let (a, b) = (root(&mut parent, w[0].1), root(&mut parent, w[1].1));
            if a != b {
                parent[a.max(b) as usize] = a.min(b);
            }
        }
    }
    drop(faces);
    // Pieces numbered in order of their first element.
    let mut piece_of_root = vec![u32::MAX; nt];
    let mut piece = vec![0u32; nt];
    let mut pieces = 0u32;
    for (i, p) in piece.iter_mut().enumerate() {
        let r = root(&mut parent, i as u32) as usize;
        if piece_of_root[r] == u32::MAX {
            piece_of_root[r] = pieces;
            pieces += 1;
        }
        *p = piece_of_root[r];
    }
    if pieces == 1 {
        // One rigid piece holding a fixed triangle is held.
        return Ok(());
    }
    let mut pairs: Vec<(u32, u32)> = Vec::with_capacity(nt * 4);
    for (i, t) in mesh.tets.iter().enumerate() {
        pairs.extend(t.iter().map(|&n| (piece[i], n)));
    }
    pairs.sort_unstable();
    pairs.dedup();
    let mut start = vec![0usize; pieces as usize + 1];
    for &(c, _) in &pairs {
        start[c as usize + 1] += 1;
    }
    for c in 0..pieces as usize {
        start[c + 1] += start[c];
    }
    let mut on_held = vec![false; mesh.nodes.len()];
    let mut done = vec![false; pieces as usize];
    let mut pts: Vec<V3> = Vec::new();
    loop {
        let mut changed = false;
        for c in 0..pieces as usize {
            if done[c] {
                continue;
            }
            let nodes = &pairs[start[c]..start[c + 1]];
            pts.clear();
            pts.extend(
                nodes
                    .iter()
                    .filter(|(_, n)| held[*n as usize] || on_held[*n as usize])
                    .map(|(_, n)| mesh.nodes[*n as usize]),
            );
            if spans_plane(&pts) {
                done[c] = true;
                changed = true;
                for (_, n) in nodes {
                    on_held[*n as usize] = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    let loose = done.iter().filter(|d| !**d).count();
    let Some(first) = done.iter().position(|d| !*d) else {
        return Ok(());
    };
    let nodes = &pairs[start[first]..start[first + 1]];
    let mut near = [0.0; 3];
    for (_, n) in nodes {
        let p = mesh.nodes[*n as usize];
        for k in 0..3 {
            near[k] += p[k];
        }
    }
    let near = near.map(|s| s / nodes.len() as f64);
    let hinged = nodes.iter().any(|(_, n)| on_held[*n as usize]);
    Err(SolveError::NotHeld {
        loose,
        near,
        hinged,
    })
}

/// Whether the points are not all on one line.
fn spans_plane(pts: &[V3]) -> bool {
    let Some(&p0) = pts.first() else {
        return false;
    };
    let mut p1 = p0;
    let mut far = 0.0;
    for &p in pts {
        let d = norm(sub(p, p0));
        if d > far {
            far = d;
            p1 = p;
        }
    }
    if far == 0.0 {
        return false;
    }
    let dir = sub(p1, p0);
    pts.iter()
        .any(|&p| norm(cross(dir, sub(p, p0))) > COLLINEAR * far * far)
}

/// Consistent nodal loads: a uniform traction on a 6-node triangle puts nothing on its
/// corners and a third of traction times area on each mid-edge node.
fn loads(q: &Quadratic, mesh: &TetMesh, loads: &[Load]) -> Vec<V3> {
    let mut f = vec![[0.0; 3]; q.nodes.len()];
    for load in loads {
        let faces = sorted(&load.faces);
        let tris: Vec<&[u32; 6]> = q
            .boundary
            .iter()
            .zip(&mesh.boundary_face)
            .filter(|(_, face)| faces.binary_search(face).is_ok())
            .map(|(t, _)| t)
            .collect();
        let area_vec = |t: &[u32; 6]| {
            let [a, b, c] = [0, 1, 2].map(|k| q.nodes[t[k] as usize]);
            cross(sub(b, a), sub(c, a)).map(|v| 0.5 * v)
        };
        match load.kind {
            LoadKind::Force(total) => {
                let area: f64 = tris.iter().map(|t| norm(area_vec(t))).sum();
                if area <= 0.0 {
                    continue;
                }
                for t in &tris {
                    let share = norm(area_vec(t)) / area / 3.0;
                    for &n in &t[3..] {
                        for k in 0..3 {
                            f[n as usize][k] += total[k] * share;
                        }
                    }
                }
            }
            LoadKind::Pressure(p) => {
                for t in &tris {
                    let a = area_vec(t);
                    for &n in &t[3..] {
                        for k in 0..3 {
                            f[n as usize][k] -= p * a[k] / 3.0;
                        }
                    }
                }
            }
        }
    }
    f
}

/// Lamé's constants (lambda, mu) of the material.
fn lame(m: Material) -> (f64, f64) {
    let mu = m.e / (2.0 * (1.0 + m.nu));
    let lambda = m.e * m.nu / ((1.0 + m.nu) * (1.0 - 2.0 * m.nu));
    (lambda, mu)
}

/// An element's barycentric coordinate gradients (constant, the edges are straight) and volume.
#[derive(Debug, Clone, Copy)]
struct Geometry {
    grad: [V3; 4],
    volume: f64,
}

fn geometry(x: [V3; 4]) -> Option<Geometry> {
    let (a, b, c) = (sub(x[1], x[0]), sub(x[2], x[0]), sub(x[3], x[0]));
    let det = dot(a, cross(b, c));
    if !(det > 0.0 && det.is_finite()) {
        return None;
    }
    // Rows of the inverse of [a b c].
    let g1 = cross(b, c).map(|v| v / det);
    let g2 = cross(c, a).map(|v| v / det);
    let g3 = cross(a, b).map(|v| v / det);
    let g0 = [0, 1, 2].map(|k| -(g1[k] + g2[k] + g3[k]));
    Some(Geometry {
        grad: [g0, g1, g2, g3],
        volume: det / 6.0,
    })
}

/// TET10 shape function gradients at barycentric point `l`.
fn shape_gradients(g: &[V3; 4], l: [f64; 4]) -> [V3; 10] {
    let mut d = [[0.0; 3]; 10];
    for i in 0..4 {
        d[i] = g[i].map(|v| (4.0 * l[i] - 1.0) * v);
    }
    for (k, &[i, j]) in EDGES.iter().enumerate() {
        d[4 + k] = [0, 1, 2].map(|c| 4.0 * (l[i] * g[j][c] + l[j] * g[i][c]));
    }
    d
}

type Ke = [[f64; 30]; 30];

fn stiffness(geo: &Geometry, (lambda, mu): (f64, f64)) -> Box<Ke> {
    let mut k = Box::new([[0.0; 30]; 30]);
    let w = geo.volume / 4.0;
    for l in GAUSS {
        let d = shape_gradients(&geo.grad, l);
        for a in 0..10 {
            for b in 0..10 {
                let ga = d[a].map(|v| v * w);
                let gb = d[b];
                let both = mu * dot(ga, gb);
                for i in 0..3 {
                    let row = &mut k[3 * a + i];
                    for j in 0..3 {
                        row[3 * b + j] += lambda * ga[i] * gb[j] + mu * ga[j] * gb[i];
                    }
                    row[3 * b + i] += both;
                }
            }
        }
    }
    k
}

/// Stress [xx, yy, zz, xy, yz, zx] from shape gradients `d` and element displacements `u`.
fn stress_at(d: &[V3; 10], u: &[V3; 10], (lambda, mu): (f64, f64)) -> [f64; 6] {
    // Displacement gradient h[i][j] = du_j / dx_i.
    let mut h = [[0.0; 3]; 3];
    for a in 0..10 {
        for i in 0..3 {
            for j in 0..3 {
                h[i][j] += d[a][i] * u[a][j];
            }
        }
    }
    let tr = h[0][0] + h[1][1] + h[2][2];
    [
        lambda * tr + 2.0 * mu * h[0][0],
        lambda * tr + 2.0 * mu * h[1][1],
        lambda * tr + 2.0 * mu * h[2][2],
        mu * (h[0][1] + h[1][0]),
        mu * (h[1][2] + h[2][1]),
        mu * (h[2][0] + h[0][2]),
    ]
}

fn von_mises(s: &[f64; 6]) -> f64 {
    let [xx, yy, zz, xy, yz, zx] = *s;
    (0.5 * ((xx - yy).powi(2) + (yy - zz).powi(2) + (zz - xx).powi(2))
        + 3.0 * (xy * xy + yz * yz + zx * zx))
        .sqrt()
}

/// What `analyse` found on every TET10 node.
struct Fields {
    displacement: Vec<V3>,
    stress: Vec<[f64; 6]>,
    applied: V3,
    reaction: V3,
    strain_energy: f64,
    dofs: usize,
}

/// Solves K u = f with the displacements of `prescribed` nodes given, then recovers the
/// smoothed stress, the reactions and the strain energy.
#[allow(clippy::too_many_arguments)]
fn analyse(
    q: &Quadratic,
    geo: &[Geometry],
    lame: (f64, f64),
    prescribed: &[Option<V3>],
    f_ext: &[V3],
    tick: &mut dyn FnMut() -> bool,
    long: &mut dyn FnMut(&mut dyn FnMut()),
    limit: u64,
) -> Result<Fields, SolveError> {
    let nn = q.nodes.len();
    let mut used = vec![false; nn];
    for t in &q.tets {
        for &n in t {
            used[n as usize] = true;
        }
    }
    // Free nodes numbered in nested dissection order, three unknowns each, so the matrix
    // reaches the factorisation already ordered to limit fill.
    const FIXED: u32 = u32::MAX;
    let order = dissect(q, |n| used[n] && prescribed[n].is_none());
    let mut free = vec![FIXED; nn];
    for (i, &n) in order.iter().enumerate() {
        free[n as usize] = i as u32;
    }
    let nfree = order.len();
    drop(order);
    let ndof = 3 * nfree;

    // Lower triangle by node blocks: column block b holds b itself, then every free node a > b
    // that shares an element with it, ascending.
    let mut pairs: Vec<u64> = Vec::new();
    pairs
        .try_reserve(q.tets.len() * 55)
        .map_err(|_| SolveError::OutOfMemory)?;
    for t in &q.tets {
        for &a in t {
            let fa = free[a as usize];
            if fa == FIXED {
                continue;
            }
            for &b in t {
                let fb = free[b as usize];
                if fb != FIXED && fa >= fb {
                    pairs.push(((fb as u64) << 32) | fa as u64);
                }
            }
        }
    }
    pairs.sort_unstable();
    pairs.dedup();
    let mut nb_start = vec![0usize; nfree + 1];
    for &p in &pairs {
        nb_start[(p >> 32) as usize + 1] += 1;
    }
    for b in 0..nfree {
        nb_start[b + 1] += nb_start[b];
    }
    let nb: Vec<u32> = pairs.iter().map(|&p| p as u32).collect();
    drop(pairs);

    let mut col_ptr = Vec::with_capacity(ndof + 1);
    col_ptr.push(0usize);
    for b in 0..nfree {
        let m = nb_start[b + 1] - nb_start[b];
        for j in 0..3 {
            col_ptr.push(col_ptr.last().unwrap() + (3 - j) + 3 * (m - 1));
        }
    }
    let nnz = col_ptr[ndof];
    let mut row_idx: Vec<usize> = Vec::new();
    let mut values: Vec<f64> = Vec::new();
    row_idx
        .try_reserve_exact(nnz)
        .map_err(|_| SolveError::OutOfMemory)?;
    values
        .try_reserve_exact(nnz)
        .map_err(|_| SolveError::OutOfMemory)?;
    for b in 0..nfree {
        let around = &nb[nb_start[b]..nb_start[b + 1]];
        for j in 0..3 {
            row_idx.extend(3 * b + j..3 * b + 3);
            for &a in &around[1..] {
                row_idx.extend(3 * a as usize..3 * a as usize + 3);
            }
        }
    }
    values.resize(nnz, 0.0);

    let mut rhs = vec![0.0; ndof];
    for (n, f) in f_ext.iter().enumerate() {
        if free[n] != FIXED {
            rhs[3 * free[n] as usize..3 * free[n] as usize + 3].copy_from_slice(f);
        }
    }

    for (e, t) in q.tets.iter().enumerate() {
        if e % TICK_EVERY == 0 && !tick() {
            return Err(SolveError::Cancelled);
        }
        let k = stiffness(&geo[e], lame);
        for (p, &a) in t.iter().enumerate() {
            let fa = free[a as usize];
            if fa == FIXED {
                continue;
            }
            for (r, &b) in t.iter().enumerate() {
                let fb = free[b as usize];
                if fb == FIXED {
                    if let Some(ub) = prescribed[b as usize] {
                        for i in 0..3 {
                            let row = &k[3 * p + i];
                            rhs[3 * fa as usize + i] -= row[3 * r] * ub[0]
                                + row[3 * r + 1] * ub[1]
                                + row[3 * r + 2] * ub[2];
                        }
                    }
                    continue;
                }
                if fa < fb {
                    continue;
                }
                let (fa, fb) = (fa as usize, fb as usize);
                let around = &nb[nb_start[fb]..nb_start[fb + 1]];
                for j in 0..3 {
                    let start = col_ptr[3 * fb + j];
                    if fa == fb {
                        for i in j..3 {
                            values[start + i - j] += k[3 * p + i][3 * r + j];
                        }
                    } else {
                        let at = around.binary_search(&(fa as u32)).expect("pair listed");
                        let base = start + (3 - j) + 3 * (at - 1);
                        for i in 0..3 {
                            values[base + i] += k[3 * p + i][3 * r + j];
                        }
                    }
                }
            }
        }
    }
    drop(nb);
    drop(nb_start);
    if !tick() {
        return Err(SolveError::Cancelled);
    }

    let mut factored: Option<Result<(), SolveError>> = None;
    if ndof > 0 {
        let sym = SymbolicSparseColMatRef::new_checked(ndof, ndof, &col_ptr, None, &row_idx);
        let a = SparseColMatRef::new(sym, &values);
        let mut run = || {
            factored = Some(factor_and_solve(a, &mut rhs, limit));
        };
        long(&mut run);
        factored.unwrap_or(Err(SolveError::Cancelled))?;
    }
    drop(values);
    drop(row_idx);
    drop(col_ptr);
    if !tick() {
        return Err(SolveError::Cancelled);
    }

    let displacement: Vec<V3> = (0..nn)
        .map(|n| match (free[n], prescribed[n]) {
            (FIXED, Some(u)) => u,
            (FIXED, None) => [0.0; 3],
            (f, _) => {
                let f = 3 * f as usize;
                [rhs[f], rhs[f + 1], rhs[f + 2]]
            }
        })
        .collect();
    drop(rhs);

    // Internal forces element by element, and stress at each element's corners.
    let mut f_int = vec![[0.0; 3]; nn];
    let mut sum = vec![[0.0; 6]; q.corners];
    let mut count = vec![0u32; q.corners];
    for (e, t) in q.tets.iter().enumerate() {
        if e % TICK_EVERY == 0 && !tick() {
            return Err(SolveError::Cancelled);
        }
        let u: [V3; 10] = t.map(|n| displacement[n as usize]);
        let k = stiffness(&geo[e], lame);
        for (p, &a) in t.iter().enumerate() {
            for i in 0..3 {
                let row = &k[3 * p + i];
                let mut s = 0.0;
                for r in 0..10 {
                    s += row[3 * r] * u[r][0] + row[3 * r + 1] * u[r][1] + row[3 * r + 2] * u[r][2];
                }
                f_int[a as usize][i] += s;
            }
        }
        for c in 0..4 {
            let mut l = [0.0; 4];
            l[c] = 1.0;
            let s = stress_at(&shape_gradients(&geo[e].grad, l), &u, lame);
            let n = t[c] as usize;
            for k in 0..6 {
                sum[n][k] += s[k];
            }
            count[n] += 1;
        }
    }
    let mut stress: Vec<[f64; 6]> = sum
        .iter()
        .zip(&count)
        .map(|(s, &c)| {
            if c > 0 {
                s.map(|v| v / c as f64)
            } else {
                [0.0; 6]
            }
        })
        .collect();
    for &[a, b] in &q.edges {
        let (sa, sb) = (stress[a as usize], stress[b as usize]);
        stress.push([0, 1, 2, 3, 4, 5].map(|k| 0.5 * (sa[k] + sb[k])));
    }

    let mut applied = [0.0; 3];
    let mut reaction = [0.0; 3];
    let mut energy = 0.0;
    for n in 0..nn {
        for k in 0..3 {
            applied[k] += f_ext[n][k];
            if free[n] == FIXED {
                reaction[k] += f_int[n][k] - f_ext[n][k];
            }
        }
        energy += dot(displacement[n], f_int[n]);
    }
    let finite = |v: &[f64]| v.iter().all(|x| x.is_finite());
    if !(energy.is_finite() && finite(&reaction) && stress.iter().all(|s| finite(s))) {
        return Err(SolveError::Overflow);
    }
    Ok(Fields {
        displacement,
        stress,
        applied,
        reaction,
        strain_energy: 0.5 * energy,
        dofs: ndof,
    })
}

/// Elements per leaf of the dissection.
const LEAF: usize = 8;
/// A cut may leave between these fractions of the elements on one side.
const BALANCE: (f64, f64) = (0.35, 0.65);

/// The nodes `keep` accepts, in nested dissection order. The elements are sorted along each
/// axis by centroid; of the cuts that keep the halves balanced, the one whose two sides share
/// the fewest nodes wins, and those nodes come after both halves, recursively. Eliminating in
/// this order fills far less of the Cholesky factor than minimum degree, which tends to sweep
/// a solid part like a band.
fn dissect(q: &Quadratic, keep: impl Fn(usize) -> bool) -> Vec<u32> {
    const OPEN: u8 = 0;
    const RESERVED: u8 = 1;
    const PLACED: u8 = 2;
    struct Cut<'a> {
        tets: &'a [[u32; 10]],
        centroid: Vec<V3>,
        state: Vec<u8>,
        left: Vec<u32>,
        right: Vec<u32>,
        order: Vec<u32>,
    }
    /// The cut of `elems` (sorted) that shares the fewest open nodes: (shared, distance from
    /// the middle, position).
    fn best_cut(c: &mut Cut, elems: &[u32]) -> (usize, usize, usize) {
        let len = elems.len();
        let (lo, hi) = (
            (len as f64 * BALANCE.0) as usize,
            (len as f64 * BALANCE.1) as usize,
        );
        for &e in elems {
            for &n in &c.tets[e as usize] {
                c.right[n as usize] += 1;
            }
        }
        let mut shared = 0usize;
        let mut best = (usize::MAX, 0, len / 2);
        for (k, &e) in elems.iter().enumerate().take(hi.max(1)) {
            for &n in &c.tets[e as usize] {
                let n = n as usize;
                if c.state[n] != OPEN {
                    continue;
                }
                let before = c.left[n] > 0 && c.right[n] > 0;
                c.left[n] += 1;
                c.right[n] -= 1;
                let after = c.left[n] > 0 && c.right[n] > 0;
                match (before, after) {
                    (false, true) => shared += 1,
                    (true, false) => shared -= 1,
                    _ => {}
                }
            }
            let at = k + 1;
            if at >= lo.max(1) && at < len {
                let cand = (shared, at.abs_diff(len / 2), at);
                if cand < best {
                    best = cand;
                }
            }
        }
        for &e in elems {
            for &n in &c.tets[e as usize] {
                c.left[n as usize] = 0;
                c.right[n as usize] = 0;
            }
        }
        best
    }
    fn split(c: &mut Cut, elems: &mut Vec<u32>) {
        if elems.len() <= LEAF {
            for &e in elems.iter() {
                for &n in &c.tets[e as usize] {
                    if c.state[n as usize] == OPEN {
                        c.state[n as usize] = PLACED;
                        c.order.push(n);
                    }
                }
            }
            return;
        }
        let mut best: Option<((usize, usize, usize), Vec<u32>)> = None;
        for axis in 0..3 {
            let mut sorted = elems.clone();
            let centroid = &c.centroid;
            sorted.sort_unstable_by(|&a, &b| {
                centroid[a as usize][axis]
                    .total_cmp(&centroid[b as usize][axis])
                    .then(a.cmp(&b))
            });
            let cut = best_cut(c, &sorted);
            if best.as_ref().is_none_or(|(b, _)| cut < *b) {
                best = Some((cut, sorted));
            }
        }
        let ((_, _, at), mut left) = best.expect("three axes tried");
        let mut right = left.split_off(at);
        let mut shared = Vec::new();
        for &e in &left {
            for &n in &c.tets[e as usize] {
                c.left[n as usize] = 1;
            }
        }
        for &e in &right {
            for &n in &c.tets[e as usize] {
                if c.left[n as usize] == 1 && c.state[n as usize] == OPEN {
                    c.state[n as usize] = RESERVED;
                    shared.push(n);
                }
            }
        }
        for &e in &left {
            for &n in &c.tets[e as usize] {
                c.left[n as usize] = 0;
            }
        }
        elems.clear();
        elems.shrink_to_fit();
        split(c, &mut left);
        split(c, &mut right);
        for n in shared {
            c.state[n as usize] = PLACED;
            c.order.push(n);
        }
    }
    let nn = q.nodes.len();
    let mut c = Cut {
        tets: &q.tets,
        centroid: q
            .tets
            .iter()
            .map(|t| {
                [0, 1, 2].map(|k| t[..4].iter().map(|&n| q.nodes[n as usize][k]).sum::<f64>() / 4.0)
            })
            .collect(),
        state: (0..nn)
            .map(|n| if keep(n) { OPEN } else { PLACED })
            .collect(),
        left: vec![0; nn],
        right: vec![0; nn],
        order: Vec::new(),
    };
    let mut elems: Vec<u32> = (0..q.tets.len() as u32).collect();
    split(&mut c, &mut elems);
    c.order
}

/// Factorises the lower triangle `a` on one thread and overwrites `rhs` with the solution,
/// unless the factor and its scratch would take more than `limit` bytes.
fn factor_and_solve(
    a: SparseColMatRef<'_, usize, f64>,
    rhs: &mut [f64],
    limit: u64,
) -> Result<(), SolveError> {
    let oom = |_| SolveError::OutOfMemory;
    // The rows are already in dissection order. An explicit identity, as faer's `Identity`
    // ordering reads the matrix as an upper triangle whatever the side.
    let n = rhs.len();
    let id: Vec<usize> = (0..n).collect();
    let sym = factorize_symbolic_cholesky(
        a.symbolic(),
        Side::Lower,
        SymmetricOrdering::Custom(PermRef::new_checked(&id, &id, n)),
        Default::default(),
    )
    .map_err(oom)?;
    let factor_scratch = sym.factorize_numeric_llt_scratch::<f64>(Par::Seq, Default::default());
    let solve_scratch = sym.solve_in_place_scratch::<f64>(1, Par::Seq);
    let needed = (sym.len_val() as u64)
        .saturating_mul(std::mem::size_of::<f64>() as u64)
        .saturating_add(factor_scratch.unaligned_bytes_required() as u64)
        .saturating_add(solve_scratch.unaligned_bytes_required() as u64);
    if needed > limit {
        return Err(SolveError::TooLarge { needed, limit });
    }
    let mut l: Vec<f64> = Vec::new();
    l.try_reserve_exact(sym.len_val())
        .map_err(|_| SolveError::OutOfMemory)?;
    l.resize(sym.len_val(), 0.0);
    let mut mem = MemBuffer::try_new(factor_scratch).map_err(|_| SolveError::OutOfMemory)?;
    let llt = sym
        .factorize_numeric_llt(
            &mut l,
            a,
            Side::Lower,
            Default::default(),
            Par::Seq,
            MemStack::new(&mut mem),
            Default::default(),
        )
        .map_err(|_| SolveError::Singular)?;
    drop(mem);
    let mut mem = MemBuffer::try_new(solve_scratch).map_err(|_| SolveError::OutOfMemory)?;
    llt.solve_in_place_with_conj(
        Conj::No,
        MatMut::from_column_major_slice_mut(rhs, n, 1),
        Par::Seq,
        MemStack::new(&mut mem),
    );
    // The factorisation succeeded, so the matrix is positive definite and a value that is not
    // finite comes from loads too large for it.
    if rhs.iter().any(|v| !v.is_finite()) {
        return Err(SolveError::Overflow);
    }
    Ok(())
}

fn finish(q: Quadratic, f: Fields, missing_fixed: Vec<u32>) -> Result<Solution, SolveError> {
    let von_mises: Vec<f64> = f.stress.iter().map(von_mises).collect();
    let (mut vm_node, mut vm) = (0usize, f64::NEG_INFINITY);
    for (n, &v) in von_mises.iter().enumerate() {
        if v > vm {
            vm = v;
            vm_node = n;
        }
    }
    let (mut d_node, mut d) = (0usize, f64::NEG_INFINITY);
    for (n, u) in f.displacement.iter().enumerate() {
        let m = norm(*u);
        if m > d {
            d = m;
            d_node = n;
        }
    }
    Ok(Solution {
        corners: q.corners,
        elements: q.tets.len(),
        nodes: q.nodes,
        edges: q.edges,
        displacement: f.displacement,
        stress: f.stress,
        von_mises,
        max_von_mises: vm,
        max_von_mises_node: vm_node as u32,
        max_displacement: d,
        max_displacement_node: d_node as u32,
        applied: f.applied,
        reaction: f.reaction,
        strain_energy: f.strain_energy,
        dofs: f.dofs,
        missing_fixed,
    })
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A box [0, size] split into n cells per axis, each cell into the six tetrahedra around
    /// its main diagonal (conforming across cells). Boundary triangles are tagged 0 to 5 for
    /// the -x, +x, -y, +y, -z, +z sides. `jitter` moves interior nodes by up to that fraction
    /// of a cell, deterministically, for a distorted mesh.
    fn box_mesh(size: V3, n: [usize; 3], jitter: f64) -> TetMesh {
        let id = |i: usize, j: usize, k: usize| (i + (n[0] + 1) * (j + (n[1] + 1) * k)) as u32;
        let h = [0, 1, 2].map(|a| size[a] / n[a] as f64);
        let mut nodes = Vec::new();
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut rand = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
        };
        for k in 0..=n[2] {
            for j in 0..=n[1] {
                for i in 0..=n[0] {
                    let ijk = [i, j, k];
                    let inside = (0..3).all(|a| ijk[a] > 0 && ijk[a] < n[a]);
                    nodes.push([0, 1, 2].map(|a| {
                        let d = if inside { jitter * h[a] * rand() } else { 0.0 };
                        ijk[a] as f64 * h[a] + d
                    }));
                }
            }
        }
        let perms = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ];
        let mut tets = Vec::new();
        for k in 0..n[2] {
            for j in 0..n[1] {
                for i in 0..n[0] {
                    for p in perms {
                        let mut c = [i, j, k];
                        let mut t = [id(c[0], c[1], c[2]); 4];
                        for s in 0..3 {
                            c[p[s]] += 1;
                            t[s + 1] = id(c[0], c[1], c[2]);
                        }
                        let x = t.map(|v| nodes[v as usize]);
                        if dot(sub(x[1], x[0]), cross(sub(x[2], x[0]), sub(x[3], x[0]))) < 0.0 {
                            t.swap(2, 3);
                        }
                        tets.push(t);
                    }
                }
            }
        }
        let (boundary, boundary_face) = boundary_of(&nodes, &tets, |c| {
            (0..6)
                .find(|&f| {
                    let (a, hi) = (f / 2, f % 2 == 1);
                    let target = if hi { size[a] } else { 0.0 };
                    (c[a] - target).abs() < 1e-9 * size[a]
                })
                .expect("boundary triangle on a box side") as u32
        });
        TetMesh {
            nodes,
            tets,
            boundary,
            boundary_face,
        }
    }

    /// The faces used by one element only, wound outward, and the face id `tag` gives the
    /// centroid of each.
    fn boundary_of(
        nodes: &[V3],
        tets: &[[u32; 4]],
        tag: impl Fn(V3) -> u32,
    ) -> (Vec<[u32; 3]>, Vec<u32>) {
        let mut faces: Vec<([u32; 3], [u32; 3], u32)> = Vec::new();
        for t in tets {
            for skip in 0..4 {
                let f: Vec<u32> = (0..4).filter(|&i| i != skip).map(|i| t[i]).collect();
                let mut key = [f[0], f[1], f[2]];
                key.sort_unstable();
                faces.push((key, [f[0], f[1], f[2]], t[skip]));
            }
        }
        faces.sort_unstable();
        let mut out = Vec::new();
        let mut ids = Vec::new();
        let mut i = 0;
        while i < faces.len() {
            let mut j = i + 1;
            while j < faces.len() && faces[j].0 == faces[i].0 {
                j += 1;
            }
            if j - i == 1 {
                let (_, mut f, opp) = faces[i];
                let [a, b, c] = f.map(|v| nodes[v as usize]);
                if dot(cross(sub(b, a), sub(c, a)), sub(nodes[opp as usize], a)) > 0.0 {
                    f.swap(1, 2);
                }
                let centroid = [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0);
                out.push(f);
                ids.push(tag(centroid));
            }
            i = j;
        }
        (out, ids)
    }

    fn go() -> bool {
        true
    }

    const STEEL: Material = Material {
        e: 210_000.0,
        nu: 0.3,
    };

    fn balance(s: &Solution) -> f64 {
        let r = norm([0, 1, 2].map(|k| s.applied[k] + s.reaction[k]));
        r / norm(s.applied).max(1e-300)
    }

    /// The corner and mid-edge nodes of the boundary triangles tagged `face`.
    fn face_nodes(m: &TetMesh, s: &Solution, face: u32) -> Vec<u32> {
        let mut v = Vec::new();
        for (t, &f) in m.boundary.iter().zip(&m.boundary_face) {
            if f == face {
                for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                    v.push(a);
                    let e = [a.min(b), a.max(b)];
                    v.push((s.corners + s.edges.binary_search(&e).unwrap()) as u32);
                }
            }
        }
        v.sort_unstable();
        v.dedup();
        v
    }

    #[test]
    fn patch_test_reproduces_constant_strain() {
        let m = box_mesh([2.0, 3.0, 1.5], [3, 4, 3], 0.12);
        let q = promote(&m).unwrap();
        let geo: Vec<Geometry> = q
            .tets
            .iter()
            .map(|t| geometry([0, 1, 2, 3].map(|k| q.nodes[t[k] as usize])).unwrap())
            .collect();
        // u = A x + c, prescribed on every boundary node.
        let a = [
            [1e-3, 2e-4, -3e-4],
            [5e-4, -7e-4, 1e-4],
            [-2e-4, 3e-4, 4e-4],
        ];
        let c = [0.01, -0.02, 0.005];
        let exact = |x: V3| [0, 1, 2].map(|i| c[i] + (0..3).map(|j| a[i][j] * x[j]).sum::<f64>());
        let mut prescribed = vec![None; q.nodes.len()];
        for t in &q.boundary {
            for &n in t {
                prescribed[n as usize] = Some(exact(q.nodes[n as usize]));
            }
        }
        let interior = prescribed.iter().filter(|p| p.is_none()).count();
        assert!(interior > 50);
        let mat = Material {
            e: 3500.0,
            nu: 0.36,
        };
        let f = analyse(
            &q,
            &geo,
            lame(mat),
            &prescribed,
            &vec![[0.0; 3]; q.nodes.len()],
            &mut go,
            &mut |f| f(),
            FACTOR_MEMORY_CAP,
        )
        .unwrap();
        let mut err_u: f64 = 0.0;
        for (n, u) in f.displacement.iter().enumerate() {
            err_u = err_u.max(norm(sub(*u, exact(q.nodes[n]))));
        }
        let (l, mu) = lame(mat);
        let eps = |i: usize, j: usize| 0.5 * (a[i][j] + a[j][i]);
        let tr = eps(0, 0) + eps(1, 1) + eps(2, 2);
        let want = [
            l * tr + 2.0 * mu * eps(0, 0),
            l * tr + 2.0 * mu * eps(1, 1),
            l * tr + 2.0 * mu * eps(2, 2),
            2.0 * mu * eps(0, 1),
            2.0 * mu * eps(1, 2),
            2.0 * mu * eps(2, 0),
        ];
        let scale = want.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let mut err_s: f64 = 0.0;
        for s in &f.stress {
            for k in 0..6 {
                err_s = err_s.max((s[k] - want[k]).abs() / scale);
            }
        }
        eprintln!(
            "patch: max |u - exact| = {err_u:.3e} mm, max stress error = {err_s:.3e} (relative)"
        );
        assert!(err_u < 1e-9 * 0.01, "displacement error {err_u}");
        assert!(err_s < 1e-9, "stress error {err_s}");
        assert!(norm(f.reaction) < 1e-9 * scale * 10.0);
    }

    fn bar(nu: f64, len: f64, n: [usize; 3]) -> (TetMesh, Solution, f64) {
        let m = box_mesh([len, 10.0, 10.0], n, 0.0);
        let force = 1000.0;
        let p = Problem {
            mesh: &m,
            material: Material { e: 210_000.0, nu },
            fixed: vec![0],
            loads: vec![Load {
                faces: vec![1],
                kind: LoadKind::Force([force, 0.0, 0.0]),
            }],
        };
        let s = solve(&p, &mut go).unwrap();
        (m, s, force)
    }

    #[test]
    fn bar_without_poisson_is_exact() {
        // With nu = 0 the clamp does not disturb uniaxial tension, so the field is linear.
        let (m, s, force) = bar(0.0, 100.0, [10, 2, 2]);
        let area = 100.0;
        let tip = force * 100.0 / (210_000.0 * area);
        let mut err: f64 = 0.0;
        for (n, x) in s.nodes.iter().enumerate() {
            err = err.max((s.displacement[n][0] - tip * x[0] / 100.0).abs() / tip);
            err = err.max(s.displacement[n][1].abs().max(s.displacement[n][2].abs()) / tip);
            err = err.max((s.stress[n][0] - force / area).abs() / (force / area));
        }
        eprintln!(
            "bar nu=0: max relative error {err:.3e}, balance {:.3e}",
            balance(&s)
        );
        assert!(err < 1e-9, "{err}");
        assert!(balance(&s) < 1e-9);
        assert_eq!(s.elements, m.tets.len());
    }

    #[test]
    fn bar_in_tension() {
        let (len, area, e) = (100.0, 100.0, 210_000.0);
        let (m, s, force) = bar(0.3, len, [20, 4, 4]);
        let end = face_nodes(&m, &s, 1);
        let ux = end
            .iter()
            .map(|&n| s.displacement[n as usize][0])
            .sum::<f64>()
            / end.len() as f64;
        let want_u = force * len / (e * area);
        let mid: Vec<usize> = (0..s.nodes.len())
            .filter(|&n| (s.nodes[n][0] - len / 2.0).abs() < 1e-9)
            .collect();
        let sxx = mid.iter().map(|&n| s.stress[n][0]).sum::<f64>() / mid.len() as f64;
        let want_s = force / area;
        let (eu, es) = ((ux - want_u) / want_u, (sxx - want_s) / want_s);
        eprintln!(
            "bar: end ux {ux:.6e} vs FL/EA {want_u:.6e} ({:+.3}%), mid sigma {sxx:.5} vs F/A {want_s} ({:+.3}%), balance {:.2e}",
            eu * 100.0,
            es * 100.0,
            balance(&s)
        );
        assert!(eu.abs() < 0.005);
        assert!(es.abs() < 0.005);
        assert!(balance(&s) < 1e-6);
    }

    struct Cantilever {
        tip: f64,
        sigma_top: f64,
        s: Solution,
    }

    fn cantilever(n: [usize; 3]) -> Cantilever {
        let m = box_mesh([100.0, 10.0, 10.0], n, 0.0);
        let p = Problem {
            mesh: &m,
            material: STEEL,
            fixed: vec![0],
            loads: vec![Load {
                faces: vec![1],
                kind: LoadKind::Force([0.0, 0.0, -100.0]),
            }],
        };
        let s = solve(&p, &mut go).unwrap();
        let end = face_nodes(&m, &s, 1);
        let tip = -end
            .iter()
            .map(|&n| s.displacement[n as usize][2])
            .sum::<f64>()
            / end.len() as f64;
        let top: Vec<usize> = (0..s.nodes.len())
            .filter(|&n| (s.nodes[n][0] - 50.0).abs() < 1e-9 && (s.nodes[n][2] - 10.0).abs() < 1e-9)
            .collect();
        assert!(!top.is_empty());
        let sigma_top = top.iter().map(|&n| s.stress[n][0]).sum::<f64>() / top.len() as f64;
        Cantilever { tip, sigma_top, s }
    }

    #[test]
    fn cantilever_matches_timoshenko_and_is_deterministic() {
        let (p, l, b, h) = (100.0, 100.0, 10.0, 10.0);
        let i = b * h * h * h / 12.0;
        let g = STEEL.e / (2.0 * (1.0 + STEEL.nu));
        let want = p * l * l * l / (3.0 * STEEL.e * i) + p * l / (5.0 / 6.0 * g * b * h);
        let want_s = p * (l / 2.0) * (h / 2.0) / i;
        let t0 = std::time::Instant::now();
        let c = cantilever([40, 4, 4]);
        let took = t0.elapsed();
        let (ed, es) = ((c.tip - want) / want, (c.sigma_top - want_s) / want_s);
        eprintln!(
            "cantilever ({} tets, {} dofs, {:.2?}): tip {:.6} vs Timoshenko {want:.6} mm ({:+.3}%), mid-span top sigma_xx {:.4} vs Mc/I {want_s} MPa ({:+.3}%), peak vm {:.3} MPa, balance {:.2e}, energy {:.6} vs P delta / 2 {:.6}",
            c.s.elements,
            c.s.dofs,
            took,
            c.tip,
            ed * 100.0,
            c.sigma_top,
            es * 100.0,
            c.s.max_von_mises,
            balance(&c.s),
            c.s.strain_energy,
            0.5 * p * c.tip
        );
        assert!(ed.abs() < 0.03);
        assert!(es.abs() < 0.03);
        assert!(balance(&c.s) < 1e-6);
        let again = cantilever([40, 4, 4]);
        assert!(c.s == again.s, "a second run gave different bits");
    }

    #[test]
    fn pressure_equals_force() {
        let m = box_mesh([30.0, 10.0, 10.0], [6, 2, 2], 0.1);
        let solve_with_load = |kind| {
            let p = Problem {
                mesh: &m,
                material: STEEL,
                fixed: vec![0],
                loads: vec![Load {
                    faces: vec![1],
                    kind,
                }],
            };
            solve(&p, &mut go).unwrap()
        };
        // 2 MPa into the +x face of 100 mm^2 is 200 N along -x.
        let a = solve_with_load(LoadKind::Pressure(2.0));
        let b = solve_with_load(LoadKind::Force([-200.0, 0.0, 0.0]));
        let scale = a.max_displacement;
        let err = a
            .displacement
            .iter()
            .zip(&b.displacement)
            .map(|(u, v)| norm(sub(*u, *v)))
            .fold(0.0, f64::max)
            / scale;
        eprintln!(
            "pressure vs force: max difference {err:.3e} relative, applied {:?}",
            a.applied
        );
        assert!(err < 1e-10);
        assert!(norm(sub(a.applied, [-200.0, 0.0, 0.0])) < 1e-9);
        assert!(balance(&a) < 1e-6 && balance(&b) < 1e-6);
    }

    #[test]
    fn reactions_balance_combined_loads() {
        let m = box_mesh([40.0, 10.0, 6.0], [8, 2, 2], 0.15);
        let p = Problem {
            mesh: &m,
            material: Material {
                e: 2200.0,
                nu: 0.35,
            },
            fixed: vec![0, 4],
            loads: vec![
                Load {
                    faces: vec![1],
                    kind: LoadKind::Force([3.0, -20.0, 7.0]),
                },
                Load {
                    faces: vec![5, 3],
                    kind: LoadKind::Pressure(0.4),
                },
                Load {
                    faces: vec![2],
                    kind: LoadKind::Force([0.0, 0.0, -5.0]),
                },
            ],
        };
        let s = solve(&p, &mut go).unwrap();
        // The pressure pushes along -z over the 400 mm^2 of +z and along -y over the 240 of +y.
        let want = [3.0, -20.0 - 0.4 * 240.0, 7.0 - 0.4 * 400.0 - 5.0];
        eprintln!(
            "combined: applied {:?} reaction {:?} balance {:.2e}",
            s.applied,
            s.reaction,
            balance(&s)
        );
        assert!(norm(sub(s.applied, want)) < 1e-9 * norm(want));
        assert!(balance(&s) < 1e-6);
        assert!(s.strain_energy > 0.0);
        assert!(s.missing_fixed.is_empty());
    }

    #[test]
    fn errors_name_the_problem() {
        let m = box_mesh([10.0, 10.0, 10.0], [2, 2, 2], 0.0);
        let load = |faces: Vec<u32>| Load {
            faces,
            kind: LoadKind::Force([0.0, 0.0, -1.0]),
        };
        let run = |fixed: Vec<u32>, loads: Vec<Load>| {
            solve(
                &Problem {
                    mesh: &m,
                    material: STEEL,
                    fixed,
                    loads,
                },
                &mut go,
            )
        };
        let e = run(vec![], vec![load(vec![1])]).unwrap_err();
        assert_eq!(e, SolveError::NoFixedFaces);
        let e = run(vec![9], vec![load(vec![1])]).unwrap_err();
        assert_eq!(e, SolveError::FixedFacesNotMeshed { faces: vec![9] });
        assert_eq!(
            e.to_string(),
            "the fixed face got no elements, it is probably narrower than the element size, use a smaller element size or fix a larger face"
        );
        let e = run(vec![0], vec![load(vec![1]), load(vec![1, 7])]).unwrap_err();
        assert_eq!(e, SolveError::MissingLoadFace { load: 1, face: 7 });
        assert_eq!(
            e.to_string(),
            "a face of loads[1] got no elements, it is probably narrower than the element size, use a smaller element size"
        );
        assert_eq!(
            run(vec![0], vec![load(vec![])]).unwrap_err(),
            SolveError::EmptyLoad { load: 0 }
        );
        // Loads that are not numbers are named as such, not taken for a loose body.
        for kind in [
            LoadKind::Force([f64::NAN, 0.0, 0.0]),
            LoadKind::Force([0.0, f64::INFINITY, 0.0]),
            LoadKind::Pressure(f64::NEG_INFINITY),
        ] {
            let bad = Load {
                faces: vec![1],
                kind,
            };
            let e = run(vec![0], vec![load(vec![3]), bad]).unwrap_err();
            assert_eq!(e, SolveError::InvalidLoad { load: 1 });
        }
        // Finite loads whose displacements overflow.
        let e = solve(
            &Problem {
                mesh: &m,
                material: Material { e: 1e-300, nu: 0.3 },
                fixed: vec![0],
                loads: vec![Load {
                    faces: vec![1],
                    kind: LoadKind::Force([1e300, 0.0, 0.0]),
                }],
            },
            &mut go,
        )
        .unwrap_err();
        assert_eq!(e, SolveError::Overflow);
        let s = run(vec![0, 9], vec![load(vec![1])]).unwrap();
        assert_eq!(s.missing_fixed, vec![9]);
        let bad = solve(
            &Problem {
                mesh: &m,
                material: Material { e: 1000.0, nu: 0.5 },
                fixed: vec![0],
                loads: vec![],
            },
            &mut go,
        );
        assert!(matches!(bad, Err(SolveError::InvalidMaterial(_))));
        let mut calls = 0;
        let mut stop = || {
            calls += 1;
            calls < 3
        };
        let e = solve(
            &Problem {
                mesh: &m,
                material: STEEL,
                fixed: vec![0],
                loads: vec![],
            },
            &mut stop,
        )
        .unwrap_err();
        assert_eq!(e, SolveError::Cancelled);
        // A factor over the memory limit is refused before it is allocated.
        let e = solve_within(
            &Problem {
                mesh: &m,
                material: STEEL,
                fixed: vec![0],
                loads: vec![load(vec![1])],
            },
            &mut go,
            &mut |f| f(),
            1000,
        )
        .unwrap_err();
        let SolveError::TooLarge { needed, limit } = e else {
            panic!("{e:?}");
        };
        assert!(needed > limit && limit == 1000);
        assert!(memory_limit() > 0 && memory_limit() <= FACTOR_MEMORY_CAP);
        let big = SolveError::TooLarge {
            needed: 5_400_000_000,
            limit: 3 << 30,
        };
        assert_eq!(
            big.to_string(),
            "solving this mesh needs about 5.4 GB of memory, more than the 3.2 GB it may use, use a larger element size or fewer elements"
        );
        for e in [
            SolveError::NoFixedFaces,
            SolveError::FixedFacesNotMeshed { faces: vec![1, 2] },
            SolveError::InvalidLoad { load: 0 },
            SolveError::Singular,
            SolveError::Overflow,
            big,
            SolveError::OutOfMemory,
        ] {
            let t = e.to_string();
            assert!(!t.contains('\u{2014}') && !t.contains(" - "), "{t}");
        }
    }

    /// Two meshes side by side, the second's face ids moved up by 6.
    fn join(a: &TetMesh, b: &TetMesh, shift: V3) -> TetMesh {
        let mut m = a.clone();
        let base = a.nodes.len() as u32;
        m.nodes
            .extend(b.nodes.iter().map(|p| [0, 1, 2].map(|k| p[k] + shift[k])));
        m.tets.extend(b.tets.iter().map(|t| t.map(|v| v + base)));
        m.boundary
            .extend(b.boundary.iter().map(|t| t.map(|v| v + base)));
        m.boundary_face
            .extend(b.boundary_face.iter().map(|f| f + 6));
        m
    }

    #[test]
    fn an_unheld_piece_is_an_error() {
        let one = box_mesh([10.0, 10.0, 10.0], [2, 2, 2], 0.0);
        let m = join(&one, &one, [20.0, 0.0, 0.0]);
        let p = Problem {
            mesh: &m,
            material: STEEL,
            fixed: vec![0],
            loads: vec![Load {
                faces: vec![7],
                kind: LoadKind::Force([1.0, 0.0, 0.0]),
            }],
        };
        let e = solve(&p, &mut go).unwrap_err();
        eprintln!("unheld: {e}");
        match e {
            SolveError::NotHeld {
                loose,
                near,
                hinged,
            } => {
                assert_eq!(loose, 1);
                assert!(!hinged);
                assert!((near[0] - 25.0).abs() < 1e-9);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            e.to_string(),
            "the body is not held and can still move, the piece near (25.000, 5.000, 5.000) mm is not connected to a fixed face"
        );
        // Holding both pieces solves.
        let p = Problem {
            fixed: vec![0, 6],
            ..p
        };
        let s = solve(&p, &mut go).unwrap();
        assert!(balance(&s) < 1e-6);
    }

    #[test]
    fn a_piece_hinged_on_an_edge_is_an_error() {
        // Two cubes sharing only the edge x = 10, z = 10 of the first.
        let one = box_mesh([10.0, 10.0, 10.0], [1, 1, 1], 0.0);
        let mut m = join(&one, &one, [10.0, 0.0, 10.0]);
        // Weld the shared edge's nodes.
        let n = one.nodes.len() as u32;
        let mut remap: Vec<u32> = (0..m.nodes.len() as u32).collect();
        for j in n..m.nodes.len() as u32 {
            if let Some(i) =
                (0..n).find(|&i| norm(sub(m.nodes[i as usize], m.nodes[j as usize])) < 1e-9)
            {
                remap[j as usize] = i;
            }
        }
        for t in &mut m.tets {
            *t = t.map(|v| remap[v as usize]);
        }
        for t in &mut m.boundary {
            *t = t.map(|v| remap[v as usize]);
        }
        let p = Problem {
            mesh: &m,
            material: STEEL,
            fixed: vec![0],
            loads: vec![Load {
                faces: vec![7],
                kind: LoadKind::Force([1.0, 0.0, 0.0]),
            }],
        };
        let e = solve(&p, &mut go).unwrap_err();
        eprintln!("hinged: {e}");
        assert!(
            matches!(
                e,
                SolveError::NotHeld {
                    loose: 1,
                    hinged: true,
                    ..
                }
            ),
            "{e:?}"
        );
    }

    /// Run with `cargo test --release -- --ignored --nocapture solve_time`.
    #[test]
    #[ignore]
    fn solve_time_about_50k_tets() {
        let m = box_mesh([120.0, 24.0, 24.0], [60, 12, 12], 0.0);
        let p = Problem {
            mesh: &m,
            material: STEEL,
            fixed: vec![0],
            loads: vec![Load {
                faces: vec![1],
                kind: LoadKind::Force([0.0, 0.0, -1000.0]),
            }],
        };
        let t0 = std::time::Instant::now();
        let mut factor = std::time::Duration::ZERO;
        let s = solve_with(&p, &mut go, &mut |f| {
            let t = std::time::Instant::now();
            f();
            factor = t.elapsed();
        })
        .unwrap();
        let total = t0.elapsed();
        let t1 = std::time::Instant::now();
        let again = solve(&p, &mut go).unwrap();
        eprintln!(
            "{} tets, {} TET10 nodes, {} dofs: total {:.2?} (factorise and solve {:.2?}), second run {:.2?}, identical {}, balance {:.2e}",
            s.elements,
            s.nodes.len(),
            s.dofs,
            total,
            factor,
            t1.elapsed(),
            s == again,
            balance(&s)
        );
    }
}
