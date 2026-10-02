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
//!
//! A node a slider or a pin holds in only one or two directions keeps its three unknowns, but
//! in a frame of its own whose first axes are the held directions: its block of the matrix is
//! rotated into that frame and the held unknowns become decoupled rows `1 * u = 0`. That is an
//! exact elimination that leaves the system symmetric positive definite and its block layout
//! untouched, so a problem held only by fixed faces assembles exactly as before.

use std::fmt;

use faer::dyn_stack::{MemBuffer, MemStack};
use faer::perm::PermRef;
use faer::sparse::linalg::cholesky::{factorize_symbolic_cholesky, SymmetricOrdering};
use faer::sparse::{SparseColMatRef, SymbolicSparseColMatRef};
use faer::{Conj, MatMut, Par, Side};

#[cfg(test)]
use super::SurfaceMesh;
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

/// A line a pin turns about.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Axis {
    pub origin: V3,
    pub dir: V3,
}

impl Axis {
    fn valid(&self) -> bool {
        norm(self.dir) > 0.0 && self.dir.iter().chain(&self.origin).all(|c| c.is_finite())
    }

    /// The part of `x - origin` square to the axis.
    fn radial(&self, x: V3) -> V3 {
        let along = unit(self.dir);
        let r = sub(x, self.origin);
        sub(r, along.map(|v| v * dot(r, along)))
    }
}

/// The surface of one face of a slider, which gives the direction it holds each node in. A
/// surface with a normal in closed form gives its exact normal at the node, so the slides and
/// turns that the surface allows (along and about a cylinder's axis, about a sphere's centre)
/// stay exactly free; the faceted mesh's own normals lean off the surface and would hold them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SlideFace {
    /// A plane with this normal.
    Plane(V3),
    /// A cylinder about this axis: held towards the axis.
    Cylinder(Axis),
    /// A cone about `axis` whose lines lean `semi_angle` radians off it, widening along
    /// `axis.dir` when the angle is positive.
    Cone { axis: Axis, semi_angle: f64 },
    /// A sphere about this centre: held towards the centre.
    Sphere(V3),
    /// A torus about `axis` whose tube is centred on the circle of radius `major`.
    Torus { axis: Axis, major: f64 },
    /// Any other surface turned about `axis`. Its normal is read off the mesh, less its part
    /// around the axis, which the real surface's normal never has.
    Revolution(Axis),
    /// A free-form surface, its normal read off the mesh.
    Mesh,
}

impl SlideFace {
    fn valid(&self) -> bool {
        match self {
            SlideFace::Plane(n) => norm(*n) > 0.0 && n.iter().all(|c| c.is_finite()),
            SlideFace::Cylinder(a) | SlideFace::Revolution(a) => a.valid(),
            SlideFace::Cone { axis, semi_angle } => axis.valid() && semi_angle.is_finite(),
            SlideFace::Torus { axis, major } => axis.valid() && major.is_finite(),
            SlideFace::Sphere(c) => c.iter().all(|v| v.is_finite()),
            SlideFace::Mesh => true,
        }
    }

    /// Whether the normal is the surface's own, not the mesh's.
    fn exact(&self) -> bool {
        !matches!(self, SlideFace::Revolution(_) | SlideFace::Mesh)
    }

    /// The axis the surface is turned about, for one that is.
    fn axis(&self) -> Option<Axis> {
        match self {
            SlideFace::Cylinder(a) | SlideFace::Revolution(a) => Some(*a),
            SlideFace::Cone { axis, .. } | SlideFace::Torus { axis, .. } => Some(*axis),
            _ => None,
        }
    }

    /// The exact normal, either way round, at `x`: the surface's normal at the point of it
    /// nearest `x`, which for a surface of revolution lies in the plane through the axis and
    /// `x`. None for a normal read off the mesh, and at a point on the axis or the centre,
    /// where there is no one normal.
    fn normal_at(&self, x: V3) -> Option<V3> {
        let radial = |a: &Axis| {
            let r = a.radial(x);
            (norm(r) > 1e-9 * norm(sub(x, a.origin)).max(1.0)).then(|| unit(r))
        };
        match self {
            SlideFace::Plane(n) => Some(unit(*n)),
            SlideFace::Cylinder(a) => radial(a),
            // Across the cone's line through the point: the lines run along
            // sin(angle) e + cos(angle) axis, e the way out from the axis.
            SlideFace::Cone { axis, semi_angle } => radial(axis).map(|e| {
                let along = unit(axis.dir);
                let (s, c) = semi_angle.sin_cos();
                [0, 1, 2].map(|i| c * e[i] - s * along[i])
            }),
            SlideFace::Sphere(c) => {
                let r = sub(x, *c);
                (norm(r) > 0.0).then(|| unit(r))
            }
            // From the centre of the tube's cross-section nearest the point, on the circle
            // of radius `major` in the plane through the origin square to the axis.
            SlideFace::Torus { axis, major } => radial(axis).and_then(|e| {
                let centre = [0, 1, 2].map(|i| axis.origin[i] + major * e[i]);
                let r = sub(x, centre);
                (norm(r) > 0.0).then(|| unit(r))
            }),
            SlideFace::Revolution(_) | SlideFace::Mesh => None,
        }
    }
}

/// How a support holds the faces it names.
#[derive(Debug, Clone, PartialEq)]
pub enum Hold {
    /// Held in every direction.
    Fixed,
    /// Held along the normal only, free to slide in the surface. One entry per face, each
    /// face holding its nodes along its own normal, so a node where two of them meet at an
    /// angle is held along both.
    Slider(Vec<SlideFace>),
    /// Held towards the axis and along it, free to turn about it (a bolt or a pin). One axis
    /// per face, as each face may be a different hole.
    Pinned(Vec<Axis>),
}

/// Faces held the same way. A node a fixed support holds is fixed whatever else holds it;
/// otherwise it is held in every direction any of its supports holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Support {
    pub faces: Vec<u32>,
    pub hold: Hold,
}

/// A linear static problem: the mesh, its material, the face ids held still, the other
/// supports, the loads, and a force per volume over the whole body (its weight).
#[derive(Debug, Clone)]
pub struct Problem<'a> {
    pub mesh: &'a TetMesh,
    pub material: Material,
    /// Faces held in every direction, the first support when there are any.
    pub fixed: Vec<u32>,
    /// Supports after `fixed`.
    pub supports: Vec<Support>,
    pub loads: Vec<Load>,
    /// N per cubic mm, density times gravity.
    pub body_force: Option<V3>,
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
    /// The sum of the forces the supports exert on the body, N; balances `applied`.
    pub reaction: V3,
    /// The force each support exerts, `fixed` first when it has faces, then `supports` in
    /// order. They sum to `reaction`. A node two supports share gives each the part along
    /// the directions it holds, or all of it to the fixed one.
    pub reactions: Vec<V3>,
    /// The body force summed over the volume, N, part of `applied`.
    pub weight: Option<V3>,
    /// N mm (mJ).
    pub strain_energy: f64,
    /// Unknowns solved for (free nodes times three).
    pub dofs: usize,
    pub elements: usize,
    /// Face ids of the supports that no boundary triangle carries, so they hold nothing.
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
    /// The supports leave the body a way to move without straining, `motion` being one.
    Free {
        motion: Motion,
    },
    /// `supports[support]` (counting `fixed` first when it has faces) has no axis or normal
    /// entry per face, or an axis of no length.
    InvalidSupport {
        support: usize,
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
            SolveError::EmptyLoad { load } => {
                write!(f, "load {} (loads[{load}]) names no faces", load + 1)
            }
            SolveError::InvalidLoad { load } => write!(
                f,
                "the force or pressure of load {} (loads[{load}]) is not a finite number",
                load + 1
            ),
            SolveError::MissingLoadFace { load, .. } => write!(
                f,
                "a face of load {} (loads[{load}]) got no elements, it is probably narrower than the element size, use a smaller element size",
                load + 1
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
            SolveError::Free { motion } => write!(f, "{motion}"),
            SolveError::InvalidSupport { support } => write!(
                f,
                "support {support} does not give one axis or normal for each of its faces"
            ),
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

/// A way a body can still move without straining, as rigid motions go: a slide, or a turn
/// about a line (the slide along the line that may come with it is left unsaid).
#[derive(Debug, Clone, PartialEq)]
pub enum Motion {
    Slide {
        along: V3,
    },
    /// `pivot` names what the body turns about when a support leaves it that turn; a ball's
    /// turn goes `through` its centre.
    Turn {
        about: V3,
        through: V3,
        pivot: Option<Pivot>,
    },
}

/// What a support lets a body turn about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pivot {
    /// A pin's axis.
    Pin,
    /// The axis of a hole a slider holds.
    Hole,
    /// The axis of another round face a slider holds: a shaft, a cone, a torus.
    Round,
    /// The centre of a ball-shaped face a slider holds.
    Ball,
}

impl fmt::Display for Motion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Motion::Slide { along } => write!(
                f,
                "the body can still slide along {}, add a support that holds it that way",
                direction_words(*along)
            ),
            Motion::Turn {
                through,
                pivot: Some(pivot),
                ..
            } => {
                let at = point_words(*through);
                match pivot {
                    Pivot::Pin => write!(
                        f,
                        "the body can still turn about the pin's axis through {at}, add another support"
                    ),
                    Pivot::Hole => write!(
                        f,
                        "the body can still turn about the hole's axis through {at}, a slider leaves a hole free to turn, add another support"
                    ),
                    Pivot::Round => write!(
                        f,
                        "the body can still turn about the axis of its round slider face through {at}, a slider leaves a round face free to turn, add another support"
                    ),
                    Pivot::Ball => write!(
                        f,
                        "the body can still turn about the centre of its ball-shaped slider face at {at}, a slider leaves a ball free to turn every way, add another support"
                    ),
                }
            }
            Motion::Turn { about, through, .. } => write!(
                f,
                "the body can still turn about an axis along {} through {}, add a support that holds it that way",
                direction_words(*about),
                point_words(*through)
            ),
        }
    }
}

/// Three places, without trailing zeros or a negative zero.
fn short(x: f64) -> String {
    let r = (x * 1000.0).round() / 1000.0 + 0.0;
    let s = format!("{r:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

fn point_words(p: V3) -> String {
    format!("({}, {}, {})", short(p[0]), short(p[1]), short(p[2]))
}

/// X, Y or Z for a line along an axis, which way it points does not matter, else its
/// direction as numbers.
fn direction_words(d: V3) -> String {
    let d = unit(d);
    for (k, name) in ["X", "Y", "Z"].into_iter().enumerate() {
        if d[k].abs() > 1.0 - 1e-6 {
            return name.into();
        }
    }
    // The sign that makes the first component that is not zero positive, a line has no way.
    let s = if d.iter().find(|c| c.abs() > 1e-9).is_some_and(|c| *c < 0.0) {
        -1.0
    } else {
        1.0
    };
    point_words(d.map(|c| c * s))
}

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
    let mut supports: Vec<Support> = Vec::with_capacity(p.supports.len() + 1);
    if !p.fixed.is_empty() {
        supports.push(Support {
            faces: p.fixed.clone(),
            hold: Hold::Fixed,
        });
    }
    supports.extend(p.supports.iter().cloned());
    for (i, s) in supports.iter().enumerate() {
        let fits = match &s.hold {
            Hold::Fixed => true,
            Hold::Slider(faces) => {
                faces.len() == s.faces.len() && faces.iter().all(SlideFace::valid)
            }
            Hold::Pinned(axes) => axes.len() == s.faces.len() && axes.iter().all(Axis::valid),
        };
        if !fits {
            return Err(SolveError::InvalidSupport { support: i });
        }
    }
    let held_faces = sorted(
        &supports
            .iter()
            .flat_map(|s| s.faces.iter().copied())
            .collect::<Vec<_>>(),
    );
    if held_faces.is_empty() {
        return Err(SolveError::NoFixedFaces);
    }
    // A support holds the nodes lying on its faces, so a face no node lies on holds nothing.
    let on = OnFaces::of(mesh);
    let missing_fixed: Vec<u32> = held_faces
        .iter()
        .copied()
        .filter(|&id| !on.meshed(id))
        .collect();
    if missing_fixed.len() == held_faces.len() {
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

    let holds = holds_of(&q, &on, &supports);
    check_held(mesh, &holds, &turnings_of(mesh, &supports))?;
    let prescribed: Vec<Option<V3>> = (0..q.nodes.len())
        .map(|n| holds.full(n).then_some([0.0; 3]))
        .collect();
    let mut f_ext = loads(&q, mesh, &p.loads);
    let weight = p.body_force.map(|b| body_force(&q, &geo, b, &mut f_ext));
    if !tick() {
        return Err(SolveError::Cancelled);
    }

    let fields = analyse(
        &q,
        &geo,
        lame(m),
        &prescribed,
        &holds,
        &f_ext,
        tick,
        long,
        limit,
    )?;
    let reactions = share_reactions(&holds, &fields.residual, supports.len());
    finish(q, fields, reactions, weight, missing_fixed)
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
    if mesh.node_faces.iter().any(|&(i, _)| i as usize >= n) {
        return bad("a face lists a node that does not exist");
    }
    if mesh.node_faces.windows(2).any(|w| w[0] >= w[1]) {
        return bad("the faces of its nodes are not sorted");
    }
    Ok(())
}

/// The faces each corner node lies on: the mesher's list, or for a mesh without one the faces
/// of the boundary triangles the node is a corner of.
struct OnFaces {
    /// Node n's faces are `faces[start[n]..start[n + 1]]`.
    start: Vec<u32>,
    faces: Vec<u32>,
    /// Every face some node lies on, sorted.
    meshed: Vec<u32>,
}

impl OnFaces {
    fn of(mesh: &TetMesh) -> OnFaces {
        let pairs: Vec<(u32, u32)> = if mesh.node_faces.is_empty() {
            let mut v: Vec<(u32, u32)> = mesh
                .boundary
                .iter()
                .zip(&mesh.boundary_face)
                .flat_map(|(t, &f)| t.iter().map(move |&n| (n, f)))
                .collect();
            v.sort_unstable();
            v.dedup();
            v
        } else {
            mesh.node_faces.clone()
        };
        let mut start = vec![0u32; mesh.nodes.len() + 1];
        for &(n, _) in &pairs {
            start[n as usize + 1] += 1;
        }
        for i in 0..mesh.nodes.len() {
            start[i + 1] += start[i];
        }
        let faces: Vec<u32> = pairs.iter().map(|p| p.1).collect();
        OnFaces {
            start,
            meshed: sorted(&faces),
            faces,
        }
    }

    /// The faces node `n` lies on; none for a mid-edge node.
    fn get(&self, n: u32) -> &[u32] {
        match (self.start.get(n as usize), self.start.get(n as usize + 1)) {
            (Some(&a), Some(&b)) => &self.faces[a as usize..b as usize],
            _ => &[],
        }
    }

    fn has(&self, n: u32, face: u32) -> bool {
        self.get(n).contains(&face)
    }

    fn meshed(&self, face: u32) -> bool {
        self.meshed.binary_search(&face).is_ok()
    }
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

/// A direction within this of the span already held at a node adds nothing to it. Normals of
/// two faces meeting at a few hundredths of a degree are one direction, not two.
const INDEPENDENT: f64 = 1e-3;
/// A rigid motion the supports resist less than this share of the stiffest one is free.
const FREE_SHARE: f64 = 1e-9;

/// How the supports hold one node.
#[derive(Debug, Clone, Copy)]
struct NodeHold {
    /// The held directions, independent, as the supports gave them, and whose each is.
    dirs: [V3; 3],
    support: [u32; 3],
    /// How many of `dirs` there are; 3 is fully held.
    held: u8,
    /// An orthonormal frame whose first `held` axes span `dirs`.
    axes: [V3; 3],
}

/// How the supports hold each node: `of[n]` indexes `nodes`, u32::MAX for a free node.
/// Empty when nothing is held, as for a problem whose displacements are all prescribed.
#[derive(Debug, Clone, Default)]
struct Holds {
    of: Vec<u32>,
    nodes: Vec<NodeHold>,
}

impl Holds {
    fn get(&self, n: usize) -> Option<&NodeHold> {
        match self.of.get(n) {
            Some(&i) if i != u32::MAX => Some(&self.nodes[i as usize]),
            _ => None,
        }
    }

    fn full(&self, n: usize) -> bool {
        self.get(n).is_some_and(|h| h.held == 3)
    }

    /// The frame of a node held in one or two directions, with how many.
    fn partial(&self, n: usize) -> Option<(&[V3; 3], usize)> {
        self.get(n)
            .filter(|h| h.held < 3)
            .map(|h| (&h.axes, h.held as usize))
    }
}

const AXES: [V3; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// The directions each support holds each TET10 node in. A support holds the nodes lying on
/// its faces: a corner node the mesher found on the face, a mid-edge node when both ends of
/// its edge are. A node on any face of a fixed support is fixed by the first such support. A
/// slider holds a node along the normal of each of its faces the node lies on, the surface's
/// exact normal when it has one, else the area weighted normal of the boundary triangles
/// lying wholly on that face around the node. A pin holds its nodes towards its axis and
/// along it.
fn holds_of(q: &Quadratic, on: &OnFaces, supports: &[Support]) -> Holds {
    let nn = q.nodes.len();
    let mut fixed_by = vec![u32::MAX; nn];
    // (node, support, direction), each support's in the order it was found.
    let mut rows: Vec<(u32, u32, V3)> = Vec::new();
    for (s, sup) in supports.iter().enumerate() {
        let s = s as u32;
        let index = |face: u32| sup.faces.iter().position(|&f| f == face);
        // (node, index of the support's face it lies on).
        let mut on_face: Vec<(u32, usize)> = Vec::new();
        for t in &q.boundary {
            for i in 0..3 {
                let (a, b, mid) = (t[i], t[(i + 1) % 3], t[3 + i]);
                for &f in on.get(a) {
                    if let Some(k) = index(f) {
                        on_face.push((a, k));
                        if on.has(b, f) {
                            on_face.push((mid, k));
                        }
                    }
                }
            }
        }
        on_face.sort_unstable();
        on_face.dedup();
        match &sup.hold {
            Hold::Fixed => {
                for (n, _) in on_face {
                    fixed_by[n as usize] = fixed_by[n as usize].min(s);
                }
            }
            Hold::Slider(faces) => {
                let meshed = mesh_normals(q, on, &sup.faces, faces);
                for (n, k) in on_face {
                    let x = q.nodes[n as usize];
                    let d = match faces[k] {
                        f if f.exact() => f.normal_at(x),
                        f => meshed
                            .binary_search_by_key(&(n, k), |e| (e.0, e.1))
                            .ok()
                            .map(|i| meshed[i].2)
                            .map(|d| match f.axis() {
                                // Less its part around the axis.
                                Some(a) => {
                                    let r = a.radial(x);
                                    if norm(r) > 0.0 {
                                        let around = unit(cross(a.dir, r));
                                        sub(d, around.map(|v| v * dot(d, around)))
                                    } else {
                                        d
                                    }
                                }
                                None => d,
                            }),
                    };
                    if let Some(d) = d.filter(|d| norm(*d) > 0.0) {
                        rows.push((n, s, unit(d)));
                    }
                }
            }
            Hold::Pinned(axes) => {
                for (n, k) in on_face {
                    let a = axes[k];
                    let along = unit(a.dir);
                    let r = sub(q.nodes[n as usize], a.origin);
                    let radial = a.radial(q.nodes[n as usize]);
                    if norm(radial) > 1e-9 * norm(r).max(1.0) {
                        rows.push((n, s, unit(radial)));
                    }
                    rows.push((n, s, along));
                }
            }
        }
    }
    // Stable, so each support's directions at a node keep the order they were found in.
    rows.sort_by_key(|r| (r.0, r.1));

    let mut holds = Holds {
        of: vec![u32::MAX; nn],
        nodes: Vec::new(),
    };
    let mut at = 0;
    for n in 0..nn {
        let start = at;
        while at < rows.len() && rows[at].0 as usize == n {
            at += 1;
        }
        let h = if fixed_by[n] != u32::MAX {
            NodeHold {
                dirs: AXES,
                support: [fixed_by[n]; 3],
                held: 3,
                axes: AXES,
            }
        } else if at > start {
            let mut h = NodeHold {
                dirs: [[0.0; 3]; 3],
                support: [0; 3],
                held: 0,
                axes: AXES,
            };
            for &(_, s, d) in &rows[start..at] {
                let k = h.held as usize;
                if k == 3 {
                    break;
                }
                let mut r = d;
                for q in &h.axes[..k] {
                    r = sub(r, q.map(|v| v * dot(d, *q)));
                }
                if norm(r) > INDEPENDENT {
                    h.dirs[k] = d;
                    h.support[k] = s;
                    h.axes[k] = unit(r);
                    h.held += 1;
                }
            }
            match h.held {
                0 => continue,
                1 => {
                    let a = h.axes[0];
                    // The world axis least along the held one, crossed, for the second.
                    let k = (0..3)
                        .min_by(|&i, &j| a[i].abs().total_cmp(&a[j].abs()))
                        .unwrap_or(0);
                    h.axes[1] = unit(cross(a, AXES[k]));
                    h.axes[2] = cross(a, h.axes[1]);
                }
                2 => h.axes[2] = unit(cross(h.axes[0], h.axes[1])),
                _ => {}
            }
            h
        } else {
            continue;
        };
        holds.of[n] = holds.nodes.len() as u32;
        holds.nodes.push(h);
    }
    holds
}

/// The area weighted normal at each node of each of a slider's faces whose normal comes from
/// the mesh, as (node, index of the face in `ids`, summed area vector) sorted by node and face.
/// Only the boundary triangles lying wholly on a face count towards its normal, so those that
/// round an edge over do not tilt it towards the face beside it.
fn mesh_normals(
    q: &Quadratic,
    on: &OnFaces,
    ids: &[u32],
    faces: &[SlideFace],
) -> Vec<(u32, usize, V3)> {
    let mut each: Vec<(u32, usize, V3)> = Vec::new();
    if faces.iter().all(SlideFace::exact) {
        return each;
    }
    for t in &q.boundary {
        for &f in on.get(t[0]) {
            let Some(k) = ids.iter().position(|&g| g == f) else {
                continue;
            };
            if faces[k].exact() || !on.has(t[1], f) || !on.has(t[2], f) {
                continue;
            }
            let [a, b, c] = [0, 1, 2].map(|i| q.nodes[t[i] as usize]);
            let area = cross(sub(b, a), sub(c, a)).map(|v| 0.5 * v);
            each.extend(t.iter().map(|&n| (n, k, area)));
        }
    }
    // Stable, so the sums run in the same order every time.
    each.sort_by_key(|e| (e.0, e.1));
    let mut out: Vec<(u32, usize, V3)> = Vec::with_capacity(each.len() / 3);
    for (n, k, v) in each {
        match out.last_mut() {
            Some(last) if last.0 == n && last.1 == k => {
                last.2 = [0, 1, 2].map(|i| last.2[i] + v[i]);
            }
            _ => out.push((n, k, v)),
        }
    }
    out
}

/// A line or a point a support leaves the body free to turn about, to name such a turn by.
#[derive(Debug, Clone, Copy)]
struct Turning {
    pivot: Pivot,
    origin: V3,
    /// None for a ball, which turns about any line through `origin`.
    dir: Option<V3>,
}

/// What the pins, then the round faces of the sliders, leave the body free to turn about.
fn turnings_of(mesh: &TetMesh, supports: &[Support]) -> Vec<Turning> {
    let mut pins = Vec::new();
    let mut round = Vec::new();
    for s in supports {
        match &s.hold {
            Hold::Fixed => {}
            Hold::Pinned(axes) => pins.extend(axes.iter().map(|a| Turning {
                pivot: Pivot::Pin,
                origin: a.origin,
                dir: Some(a.dir),
            })),
            Hold::Slider(faces) => {
                for (&id, face) in s.faces.iter().zip(faces) {
                    if let SlideFace::Sphere(c) = face {
                        round.push(Turning {
                            pivot: Pivot::Ball,
                            origin: *c,
                            dir: None,
                        });
                    } else if let Some(a) = face.axis() {
                        let hole =
                            matches!(face, SlideFace::Cylinder(_)) && faces_axis(mesh, id, &a);
                        round.push(Turning {
                            pivot: if hole { Pivot::Hole } else { Pivot::Round },
                            origin: a.origin,
                            dir: Some(a.dir),
                        });
                    }
                }
            }
        }
    }
    pins.extend(round);
    pins
}

/// Whether the boundary triangles of face `id` face towards `axis` on the whole, as a hole's
/// walls do.
fn faces_axis(mesh: &TetMesh, id: u32, axis: &Axis) -> bool {
    let mut sum = 0.0;
    for (t, &f) in mesh.boundary.iter().zip(&mesh.boundary_face) {
        if f == id {
            let [a, b, c] = t.map(|i| mesh.nodes[i as usize]);
            let centroid = [0, 1, 2].map(|i| (a[i] + b[i] + c[i]) / 3.0);
            sum += dot(cross(sub(b, a), sub(c, a)), axis.radial(centroid));
        }
    }
    sum < 0.0
}

/// Each support's part of the reactions: a node's reaction split along the directions it is
/// held in, each support taking the part along its own, and any rounding left to the first.
fn share_reactions(holds: &Holds, residual: &[(u32, V3)], supports: usize) -> Vec<V3> {
    let mut out = vec![[0.0; 3]; supports];
    for &(n, r) in residual {
        let Some(h) = holds.get(n as usize) else {
            continue;
        };
        let k = h.held as usize;
        let mut add = |s: u32, v: V3| {
            let slot = &mut out[s as usize];
            *slot = [0, 1, 2].map(|i| slot[i] + v[i]);
        };
        if h.support[..k].iter().all(|&s| s == h.support[0]) {
            add(h.support[0], r);
            continue;
        }
        // r = sum c_i d_i over the independent held directions: the Gram system.
        let mut g = [[0.0; 4]; 3];
        for i in 0..k {
            for j in 0..k {
                g[i][j] = dot(h.dirs[i], h.dirs[j]);
            }
            g[i][3] = dot(h.dirs[i], r);
        }
        let c = gauss_solve(&mut g, k);
        let mut left = r;
        for i in 0..k {
            let part = h.dirs[i].map(|v| v * c[i]);
            left = sub(left, part);
            add(h.support[i], part);
        }
        add(h.support[0], left);
    }
    out
}

/// Solves the first `k` rows of the augmented system `g` (k at most 3) by elimination with
/// partial pivoting.
fn gauss_solve(g: &mut [[f64; 4]; 3], k: usize) -> [f64; 3] {
    for c in 0..k {
        let p = (c..k)
            .max_by(|&a, &b| g[a][c].abs().total_cmp(&g[b][c].abs()))
            .unwrap_or(c);
        g.swap(c, p);
        if g[c][c] == 0.0 {
            continue;
        }
        for r in c + 1..k {
            let f = g[r][c] / g[c][c];
            for j in c..4 {
                g[r][j] -= f * g[c][j];
            }
        }
    }
    let mut x = [0.0; 3];
    for c in (0..k).rev() {
        let s: f64 = (c + 1..k).map(|j| g[c][j] * x[j]).sum();
        x[c] = if g[c][c] != 0.0 {
            (g[c][3] - s) / g[c][c]
        } else {
            0.0
        };
    }
    x
}

/// Fails when a piece of the mesh can still move. Elements sharing a face move as one rigid
/// piece. Each direction d a node at x is held in rules out the rigid motions (t, w) with
/// d . (t + w x (x - c)) = 0, a row [d, (x - c) x d] of a 6 by 6 system, and a piece is held
/// when its rows have rank 6. A node shared with a held piece is held in every direction,
/// which catches loose lumps and pieces hinged on an edge or a corner.
fn check_held(mesh: &TetMesh, holds: &Holds, turnings: &[Turning]) -> Result<(), SolveError> {
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
    // A piece's rows about its centroid, the moment arms scaled by its size so the six
    // columns weigh alike.
    let rows_of = |nodes: &[(u32, u32)], on_held: &[bool]| {
        let k = nodes.len().max(1) as f64;
        let mut c = [0.0; 3];
        for (_, n) in nodes {
            let p = mesh.nodes[*n as usize];
            c = [0, 1, 2].map(|i| c[i] + p[i] / k);
        }
        let size = nodes
            .iter()
            .map(|(_, n)| norm(sub(mesh.nodes[*n as usize], c)))
            .fold(0.0, f64::max)
            .max(1e-300);
        let mut m = [[0.0; 6]; 6];
        for (_, n) in nodes {
            let n = *n as usize;
            let dirs: &[V3] = if on_held[n] {
                &AXES
            } else {
                match holds.get(n) {
                    Some(h) => &h.axes[..h.held as usize],
                    None => &[],
                }
            };
            let arm = sub(mesh.nodes[n], c).map(|v| v / size);
            for &d in dirs {
                let w = cross(arm, d);
                let r = [d[0], d[1], d[2], w[0], w[1], w[2]];
                for i in 0..6 {
                    for j in 0..6 {
                        m[i][j] += r[i] * r[j];
                    }
                }
            }
        }
        (m, c, size)
    };
    loop {
        let mut changed = false;
        for c in 0..pieces as usize {
            if done[c] {
                continue;
            }
            let nodes = &pairs[start[c]..start[c + 1]];
            let (m, _, _) = rows_of(nodes, &on_held);
            if free_motion(&m).is_none() {
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
    if pieces == 1 {
        let (m, c, size) = rows_of(nodes, &on_held);
        let v = free_motion(&m).expect("the piece is not held");
        return Err(SolveError::Free {
            motion: motion_of(v, c, size, turnings),
        });
    }
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

/// A rigid motion [t, w] the rows of `m` leave free, None when they hold all six. A slide
/// along a world axis is found first, then any slide, then a turn, as the plainest to read.
fn free_motion(m: &[[f64; 6]; 6]) -> Option<[f64; 6]> {
    let (values, vectors) = jacobi(*m);
    let top = values.iter().copied().fold(0.0, f64::max);
    let tol = FREE_SHARE * top;
    let low = (0..6)
        .min_by(|&a, &b| values[a].total_cmp(&values[b]))
        .unwrap_or(0);
    if top > 0.0 && values[low] > tol {
        return None;
    }
    for k in 0..3 {
        if m[k][k] <= tol {
            let mut v = [0.0; 6];
            v[k] = 1.0;
            return Some(v);
        }
    }
    let block: [[f64; 3]; 3] = std::array::from_fn(|i| std::array::from_fn(|j| m[i][j]));
    let (tv, tw) = jacobi(block);
    let k = (0..3).min_by(|&a, &b| tv[a].total_cmp(&tv[b])).unwrap_or(0);
    if tv[k] <= tol {
        let t: V3 = std::array::from_fn(|i| tw[i][k]);
        return Some([t[0], t[1], t[2], 0.0, 0.0, 0.0]);
    }
    Some(std::array::from_fn(|i| vectors[i][low]))
}

/// The free motion `v` (moment arms scaled by `size` about `c`) in words, a turn named for the
/// pin or the round slider face it turns about when there is one.
fn motion_of(v: [f64; 6], c: V3, size: f64, turnings: &[Turning]) -> Motion {
    let t = [v[0], v[1], v[2]];
    let w = [v[3], v[4], v[5]].map(|x| x / size);
    if norm(w) * size <= 1e-9 * norm(t) {
        return Motion::Slide { along: t };
    }
    // The axis passes through c + w x t / |w|^2, its point nearest the centroid.
    let through = [0, 1, 2].map(|i| c[i] + cross(w, t)[i] / dot(w, w));
    let about = unit(w);
    let close = 1e-6 * size.max(1.0);
    let found = turnings.iter().find(|p| {
        let off = sub(through, p.origin);
        // The gap between the turn's axis and the pivot's line or point.
        let line = p.dir.map_or(about, unit);
        let gap = norm(sub(off, line.map(|x| x * dot(off, line))));
        let parallel = p.dir.is_none_or(|d| norm(cross(unit(d), about)) < 1e-6);
        parallel && gap < close
    });
    Motion::Turn {
        about,
        through: match found {
            Some(p) if p.pivot == Pivot::Ball => p.origin,
            _ => through,
        },
        pivot: found.map(|p| p.pivot),
    }
}

/// The eigenvalues of the symmetric matrix `a` and its eigenvectors as the columns of the
/// second, by cyclic Jacobi rotations.
fn jacobi<const N: usize>(mut a: [[f64; N]; N]) -> ([f64; N], [[f64; N]; N]) {
    let mut v = [[0.0; N]; N];
    for (i, row) in v.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for _ in 0..100 {
        let off: f64 = (0..N)
            .flat_map(|i| (0..N).filter(move |&j| j != i).map(move |j| (i, j)))
            .map(|(i, j)| a[i][j] * a[i][j])
            .sum();
        let scale: f64 = (0..N).map(|i| a[i][i] * a[i][i]).sum();
        if off <= 1e-30 * scale || off == 0.0 {
            break;
        }
        for p in 0..N {
            for q in p + 1..N {
                if a[p][q] == 0.0 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..N {
                    let (akp, akq) = (a[k][p], a[k][q]);
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..N {
                    let (apk, aqk) = (a[p][k], a[q][k]);
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for row in v.iter_mut() {
                    let (vp, vq) = (row[p], row[q]);
                    row[p] = c * vp - s * vq;
                    row[q] = s * vp + c * vq;
                }
            }
        }
    }
    (std::array::from_fn(|i| a[i][i]), v)
}

/// Adds the consistent nodal forces of the body force `b` (N per cubic mm), integrated over
/// each element with the 4-point rule, exact for the quadratic shape functions, and returns
/// their sum. A corner of an element takes minus a twentieth of its share and a mid-edge
/// node a fifth, so the weight goes mostly to the mid-edge nodes.
fn body_force(q: &Quadratic, geo: &[Geometry], b: V3, f: &mut [V3]) -> V3 {
    let mut total = [0.0; 3];
    for (t, g) in q.tets.iter().zip(geo) {
        let w = g.volume / 4.0;
        for l in GAUSS {
            let n = shape_values(l);
            for (a, &node) in t.iter().enumerate() {
                for k in 0..3 {
                    f[node as usize][k] += w * n[a] * b[k];
                }
            }
        }
        for k in 0..3 {
            total[k] += g.volume * b[k];
        }
    }
    total
}

/// TET10 shape functions at barycentric point `l`.
fn shape_values(l: [f64; 4]) -> [f64; 10] {
    let mut n = [0.0; 10];
    for i in 0..4 {
        n[i] = l[i] * (2.0 * l[i] - 1.0);
    }
    for (k, &[i, j]) in EDGES.iter().enumerate() {
        n[4 + k] = 4.0 * l[i] * l[j];
    }
    n
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
    /// Internal less external force at every node the supports hold, in node order.
    residual: Vec<(u32, V3)>,
    strain_energy: f64,
    dofs: usize,
}

/// Solves K u = f with the displacements of `prescribed` nodes given and those `holds` holds
/// in one or two directions kept from moving that way, then recovers the smoothed stress,
/// the reactions and the strain energy.
#[allow(clippy::too_many_arguments)]
fn analyse(
    q: &Quadratic,
    geo: &[Geometry],
    lame: (f64, f64),
    prescribed: &[Option<V3>],
    holds: &Holds,
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
            let at = 3 * free[n] as usize;
            match holds.partial(n) {
                None => rhs[at..at + 3].copy_from_slice(f),
                Some((axes, held)) => {
                    for i in held..3 {
                        rhs[at + i] = dot(axes[i], *f);
                    }
                }
            }
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
            let frame_a = holds.partial(a as usize);
            for (r, &b) in t.iter().enumerate() {
                let fb = free[b as usize];
                if fb == FIXED {
                    if let Some(ub) = prescribed[b as usize] {
                        let ku: V3 = std::array::from_fn(|i| {
                            let row = &k[3 * p + i];
                            row[3 * r] * ub[0] + row[3 * r + 1] * ub[1] + row[3 * r + 2] * ub[2]
                        });
                        let at = 3 * fa as usize;
                        match frame_a {
                            None => {
                                for i in 0..3 {
                                    rhs[at + i] -= ku[i];
                                }
                            }
                            Some((axes, held)) => {
                                for i in held..3 {
                                    rhs[at + i] -= dot(axes[i], ku);
                                }
                            }
                        }
                    }
                    continue;
                }
                if fa < fb {
                    continue;
                }
                let frame_b = holds.partial(b as usize);
                // The block in the nodes' own frames, the held rows and columns left out.
                let rotated = (frame_a.is_some() || frame_b.is_some())
                    .then(|| rotate_block(&k, p, r, frame_a, frame_b));
                let kab = |i: usize, j: usize| match &rotated {
                    None => k[3 * p + i][3 * r + j],
                    Some(m) => m[i][j],
                };
                let (fa, fb) = (fa as usize, fb as usize);
                let around = &nb[nb_start[fb]..nb_start[fb + 1]];
                for j in 0..3 {
                    let start = col_ptr[3 * fb + j];
                    if fa == fb {
                        for i in j..3 {
                            values[start + i - j] += kab(i, j);
                        }
                    } else {
                        let at = around.binary_search(&(fa as u32)).expect("pair listed");
                        let base = start + (3 - j) + 3 * (at - 1);
                        for i in 0..3 {
                            values[base + i] += kab(i, j);
                        }
                    }
                }
            }
        }
    }
    // A held direction of a node in its own frame is the decoupled row 1 * u = 0.
    for (n, &fnode) in free.iter().enumerate() {
        if fnode == FIXED {
            continue;
        }
        if let Some((_, held)) = holds.partial(n) {
            for i in 0..held {
                values[col_ptr[3 * fnode as usize + i]] = 1.0;
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
                match holds.partial(n) {
                    None => [rhs[f], rhs[f + 1], rhs[f + 2]],
                    Some((axes, held)) => {
                        let mut u = [0.0; 3];
                        for i in held..3 {
                            u = [0, 1, 2].map(|c| u[c] + axes[i][c] * rhs[f + i]);
                        }
                        u
                    }
                }
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
    let mut residual = Vec::new();
    let mut energy = 0.0;
    for n in 0..nn {
        let partial = holds.partial(n).is_some();
        for k in 0..3 {
            applied[k] += f_ext[n][k];
            if free[n] == FIXED || partial {
                reaction[k] += f_int[n][k] - f_ext[n][k];
            }
        }
        if holds.get(n).is_some() {
            residual.push((n as u32, [0, 1, 2].map(|k| f_int[n][k] - f_ext[n][k])));
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
        residual,
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

/// Element block (p, r) of `k` as Q_a K_ab Q_b^T, Q holding a node's frame axes as rows (the
/// identity for a node without one), its held rows and columns zero.
fn rotate_block(
    k: &Ke,
    p: usize,
    r: usize,
    frame_a: Option<(&[V3; 3], usize)>,
    frame_b: Option<(&[V3; 3], usize)>,
) -> [[f64; 3]; 3] {
    let mut m: [[f64; 3]; 3] =
        std::array::from_fn(|i| std::array::from_fn(|j| k[3 * p + i][3 * r + j]));
    if let Some((axes, _)) = frame_b {
        // M Q_b^T: column j is M times axis j.
        m = std::array::from_fn(|i| std::array::from_fn(|j| dot(m[i], axes[j])));
    }
    if let Some((axes, _)) = frame_a {
        // Q_a M: row i is axis i times M.
        m = std::array::from_fn(|i| {
            std::array::from_fn(|j| (0..3).map(|c| axes[i][c] * m[c][j]).sum())
        });
    }
    let (held_a, held_b) = (frame_a.map_or(0, |f| f.1), frame_b.map_or(0, |f| f.1));
    for (i, row) in m.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            if i < held_a || j < held_b {
                *v = 0.0;
            }
        }
    }
    m
}

fn finish(
    q: Quadratic,
    f: Fields,
    reactions: Vec<V3>,
    weight: Option<V3>,
    missing_fixed: Vec<u32>,
) -> Result<Solution, SolveError> {
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
        reactions,
        weight,
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

fn unit(a: V3) -> V3 {
    let n = norm(a);
    if n > 0.0 {
        a.map(|v| v / n)
    } else {
        a
    }
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
            node_faces: Vec::new(),
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
            &Holds::default(),
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
            supports: vec![],
            body_force: None,
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
            supports: vec![],
            body_force: None,
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
                supports: vec![],
                body_force: None,
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
            supports: vec![],
            body_force: None,
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
                    supports: vec![],
                    body_force: None,
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
            "a face of load 2 (loads[1]) got no elements, it is probably narrower than the element size, use a smaller element size"
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
                supports: vec![],
                body_force: None,
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
                supports: vec![],
                body_force: None,
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
                supports: vec![],
                body_force: None,
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
                supports: vec![],
                body_force: None,
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
            supports: vec![],
            body_force: None,
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
            supports: vec![],
            body_force: None,
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

    fn slider(faces: Vec<u32>) -> Support {
        Support {
            hold: Hold::Slider(vec![SlideFace::Mesh; faces.len()]),
            faces,
        }
    }

    fn sum_of(v: &[V3]) -> V3 {
        v.iter()
            .fold([0.0; 3], |s, r| [0, 1, 2].map(|k| s[k] + r[k]))
    }

    #[test]
    fn a_slider_beside_a_fixed_face_holds_only_along_its_normal() {
        // A bar glued to a wall at x = 0 and resting on a frictionless floor at z = 0, pulled
        // at its far end. The nodes on the edge both share are simply fixed.
        let m = box_mesh([60.0, 10.0, 10.0], [12, 2, 2], 0.0);
        let force = [5.0, 3.0, -40.0];
        let p = Problem {
            mesh: &m,
            supports: vec![slider(vec![4])],
            body_force: None,
            material: STEEL,
            fixed: vec![0],
            loads: vec![Load {
                faces: vec![1],
                kind: LoadKind::Force(force),
            }],
        };
        let s = solve(&p, &mut go).unwrap();
        let total = sum_of(&s.reactions);
        eprintln!(
            "slider and fixed: reactions {:?}, sum {total:?}, reaction {:?}, balance {:.2e}",
            s.reactions,
            s.reaction,
            balance(&s)
        );
        assert!(balance(&s) < 1e-6);
        assert_eq!(s.reactions.len(), 2);
        assert!(norm(sub(total, s.reaction)) < 1e-9 * norm(force));
        // The floor only pushes up.
        let floor = s.reactions[1];
        assert!(floor[0].abs() < 1e-6 * norm(force) && floor[1].abs() < 1e-6 * norm(force));
        assert!(floor[2] > 0.0, "{floor:?}");
        // Its nodes away from the wall slide along it but never through it.
        let bottom = face_nodes(&m, &s, 4);
        let wall = face_nodes(&m, &s, 0);
        let mut slid: f64 = 0.0;
        for n in bottom.iter().filter(|n| wall.binary_search(n).is_err()) {
            let u = s.displacement[*n as usize];
            assert_eq!(u[2], 0.0, "{u:?}");
            slid = slid.max(u[0].abs());
        }
        assert!(slid > 1e-6, "{slid}");
        for n in &wall {
            assert_eq!(s.displacement[*n as usize], [0.0; 3]);
        }
    }

    #[test]
    fn sliders_alone_hold_a_plate_only_when_they_stop_every_slide_and_turn() {
        let m = box_mesh([40.0, 40.0, 4.0], [8, 8, 1], 0.0);
        let p = |supports: Vec<Support>| Problem {
            mesh: &m,
            supports,
            body_force: None,
            material: STEEL,
            fixed: vec![],
            loads: vec![Load {
                faces: vec![5],
                kind: LoadKind::Pressure(0.01),
            }],
        };
        // On the floor alone it can still slide about.
        let e = solve(&p(vec![slider(vec![4])]), &mut go).unwrap_err();
        assert_eq!(
            e.to_string(),
            "the body can still slide along X, add a support that holds it that way"
        );
        // Against a wall too, it can slide along the wall.
        let e = solve(&p(vec![slider(vec![4]), slider(vec![0])]), &mut go).unwrap_err();
        assert_eq!(
            e,
            SolveError::Free {
                motion: Motion::Slide {
                    along: [0.0, 1.0, 0.0]
                }
            },
            "{e}"
        );
        // In a corner it is held, by three sliders or by one slider on three faces.
        for supports in [
            vec![slider(vec![4]), slider(vec![0]), slider(vec![2])],
            vec![slider(vec![0, 2, 4])],
        ] {
            let n = supports.len();
            let s = solve(&p(supports), &mut go).unwrap();
            assert!(balance(&s) < 1e-6, "{}", balance(&s));
            assert_eq!(s.reactions.len(), n);
            assert!(norm(sub(sum_of(&s.reactions), s.reaction)) < 1e-9 * norm(s.applied));
        }
        let none = solve(&p(vec![]), &mut go).unwrap_err();
        assert_eq!(none, SolveError::NoFixedFaces);
    }

    #[test]
    fn one_slider_on_three_faces_holds_a_corner_as_three_sliders_do() {
        // A cube in a corner, its weight and a push into the x = 0 wall. One slider over the
        // floor and both walls holds each node along the normal of every face it lies on, as
        // three separate sliders do; one direction averaged over the faces would let the
        // corner node sink into one wall and lift off the floor.
        let m = box_mesh([20.0, 20.0, 20.0], [4, 4, 4], 0.0);
        let p = |supports: Vec<Support>| Problem {
            mesh: &m,
            supports,
            body_force: Some([0.0, 0.0, -7.85 * 9.81e-6]),
            material: STEEL,
            fixed: vec![],
            loads: vec![Load {
                faces: vec![1],
                kind: LoadKind::Force([-3.0, 0.0, 0.0]),
            }],
        };
        let three = solve(
            &p(vec![slider(vec![4]), slider(vec![0]), slider(vec![2])]),
            &mut go,
        )
        .unwrap();
        let one = solve(&p(vec![slider(vec![4, 0, 2])]), &mut go).unwrap();
        let top = three.max_displacement;
        assert!(top > 0.0);
        for (a, b) in three.displacement.iter().zip(&one.displacement) {
            assert!(norm(sub(*a, *b)) < 1e-9 * top, "{a:?} vs {b:?}");
        }
        assert_eq!(one.displacement[0], [0.0; 3], "the corner at the origin");
        for (face, axis) in [(4, 2), (0, 0), (2, 1)] {
            for n in face_nodes(&m, &one, face) {
                assert_eq!(one.displacement[n as usize][axis], 0.0);
            }
        }
        assert!(norm(sub(sum_of(&three.reactions), one.reactions[0])) < 1e-9 * 3.0);
    }

    /// A closed box surface [0, size] moved by `off`, two triangles per side, wound outward,
    /// tagged 0 to 5 for the -x, +x, -y, +y, -z, +z sides.
    fn box_surface(size: V3, off: V3) -> SurfaceMesh {
        let corner =
            |i: usize| [0, 1, 2].map(|a| off[a] + if i >> a & 1 == 1 { size[a] } else { 0.0 });
        let mut s = SurfaceMesh {
            positions: (0..8).map(corner).collect(),
            ..SurfaceMesh::default()
        };
        // Each side's corners in order round it, then its outward normal.
        let sides: [([u32; 4], V3); 6] = [
            ([0, 2, 6, 4], [-1.0, 0.0, 0.0]),
            ([1, 3, 7, 5], [1.0, 0.0, 0.0]),
            ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
            ([2, 3, 7, 6], [0.0, 1.0, 0.0]),
            ([0, 1, 3, 2], [0.0, 0.0, -1.0]),
            ([4, 5, 7, 6], [0.0, 0.0, 1.0]),
        ];
        for (id, (q, out)) in sides.into_iter().enumerate() {
            for t in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
                let [a, b, c] = t.map(|i| s.positions[i as usize]);
                let wound = dot(cross(sub(b, a), sub(c, a)), out) > 0.0;
                s.triangles.push(if wound { t } else { [t[0], t[2], t[1]] });
                s.face_ids.push(id as u32);
            }
        }
        s
    }

    #[test]
    fn a_support_holds_only_the_nodes_on_its_faces() {
        // The lattice starts at the box's low corner, so its +x, +y and +z sides fall between
        // lattice planes, where the mesher rounds the edges over and some triangles tagged
        // with the top have a corner down the side beside it. The top's slider and the +x
        // wall's fixed support hold the nodes on their own planes and no others.
        let (size, off) = ([30.0, 8.0, 6.0], [0.37, 0.21, 0.13]);
        let (m, _) = super::super::tetmesh::tetrahedralize(
            &box_surface(size, off),
            &crate::fem::MeshOptions {
                size: 1.3,
                max_tets: 0,
            },
            &mut || true,
        )
        .unwrap();
        let q = promote(&m).unwrap();
        let on = OnFaces::of(&m);
        let supports = [
            Support {
                faces: vec![1],
                hold: Hold::Fixed,
            },
            Support {
                faces: vec![5],
                hold: Hold::Slider(vec![SlideFace::Plane([0.0, 0.0, 1.0])]),
            },
        ];
        let holds = holds_of(&q, &on, &supports);
        let on_plane = |n: usize, a: usize, c: f64| (q.nodes[n][a] - c).abs() < 1e-9;
        let wall = |n| on_plane(n, 0, off[0] + size[0]);
        let top = |n| on_plane(n, 2, off[2] + size[2]);
        let mut bevelled = 0;
        for (t, &f) in m.boundary.iter().zip(&m.boundary_face) {
            bevelled += usize::from(f == 5 && t.iter().any(|&n| !top(n as usize)));
        }
        assert!(bevelled > 0, "no triangle of the top reaches down a side");
        let mut boundary: Vec<u32> = q.boundary.iter().flatten().copied().collect();
        boundary.sort_unstable();
        boundary.dedup();
        for n in boundary {
            let n = n as usize;
            let want = if wall(n) {
                3
            } else if top(n) {
                1
            } else {
                0
            };
            let got = holds.get(n).map_or(0, |h| h.held);
            assert_eq!(got, want, "node {n} at {:?}", q.nodes[n]);
            if want == 1 {
                assert_eq!(holds.get(n).unwrap().dirs[0], [0.0, 0.0, 1.0]);
            }
        }
    }

    #[test]
    fn a_curved_slider_face_holds_along_its_exact_normal() {
        let z = Axis {
            origin: [1.0, 2.0, 3.0],
            dir: [0.0, 0.0, 2.0],
        };
        // A cylinder holds towards its axis, a sphere towards its centre.
        let n = SlideFace::Cylinder(z).normal_at([4.0, 6.0, -7.0]).unwrap();
        assert!(norm(sub(n, [0.6, 0.8, 0.0])) < 1e-15, "{n:?}");
        let n = SlideFace::Sphere([1.0, 2.0, 3.0])
            .normal_at([1.0, 2.0, 5.0])
            .unwrap();
        assert_eq!(n, [0.0, 0.0, 1.0]);
        assert_eq!(SlideFace::Cylinder(z).normal_at([1.0, 2.0, 9.0]), None);
        // A cone and a torus: square to the surface's two directions at a point on it, and the
        // same off it along that normal.
        let (r, alpha, theta) = (4.0, 0.3_f64, 0.7_f64);
        let e = [theta.cos(), theta.sin(), 0.0];
        let around = [-theta.sin(), theta.cos(), 0.0];
        let at = |radius: f64, h: f64| [1.0 + radius * e[0], 2.0 + radius * e[1], 3.0 + h];
        let cone = SlideFace::Cone {
            axis: z,
            semi_angle: alpha,
        };
        let v = 2.5;
        let x = at(r + v * alpha.sin(), v * alpha.cos());
        let n = cone.normal_at(x).unwrap();
        let line = [alpha.sin() * e[0], alpha.sin() * e[1], alpha.cos()];
        assert!(
            dot(n, line).abs() < 1e-15 && dot(n, around).abs() < 1e-15,
            "{n:?}"
        );
        let pushed = [0, 1, 2].map(|i| x[i] + 0.1 * n[i]);
        assert!(norm(sub(cone.normal_at(pushed).unwrap(), n)) < 1e-12);
        let torus = SlideFace::Torus {
            axis: z,
            major: 10.0,
        };
        let phi = 1.1_f64;
        let x = at(10.0 + 2.0 * phi.cos(), 2.0 * phi.sin());
        let n = torus.normal_at(x).unwrap();
        let want = [phi.cos() * e[0], phi.cos() * e[1], phi.sin()];
        assert!(norm(sub(n, want)) < 1e-12, "{n:?} vs {want:?}");
    }

    #[test]
    fn a_pin_leaves_the_turn_about_its_axis_free() {
        // A pin through the bar's -x end along X, as a hole's walls would take it.
        let m = box_mesh([30.0, 10.0, 10.0], [6, 2, 2], 0.0);
        let pin = Support {
            faces: vec![0],
            hold: Hold::Pinned(vec![Axis {
                origin: [-3.0, 5.0, 5.0],
                dir: [2.0, 0.0, 0.0],
            }]),
        };
        let p = |supports: Vec<Support>| Problem {
            mesh: &m,
            supports,
            body_force: None,
            material: STEEL,
            fixed: vec![],
            loads: vec![Load {
                faces: vec![1],
                kind: LoadKind::Force([0.0, 0.0, -10.0]),
            }],
        };
        let e = solve(&p(vec![pin.clone()]), &mut go).unwrap_err();
        eprintln!("pin alone: {e}");
        let SolveError::Free {
            motion:
                Motion::Turn {
                    about,
                    through,
                    pivot: Some(Pivot::Pin),
                },
        } = &e
        else {
            panic!("{e:?}");
        };
        assert!(norm(cross(*about, [1.0, 0.0, 0.0])) < 1e-9, "{about:?}");
        assert!(norm(sub(*through, [15.0, 5.0, 5.0])) < 1e-6, "{through:?}");
        assert_eq!(
            e.to_string(),
            "the body can still turn about the pin's axis through (15, 5, 5), add another support"
        );
        // A slider on the side stops the turn.
        let s = solve(&p(vec![pin, slider(vec![2])]), &mut go).unwrap();
        assert!(balance(&s) < 1e-6, "{}", balance(&s));
        assert!(norm(sub(sum_of(&s.reactions), s.reaction)) < 1e-9 * 10.0);
        // The pin's face moves only by turning, so not along X or towards the axis.
        for n in face_nodes(&m, &s, 0) {
            let x = s.nodes[n as usize];
            let u = s.displacement[n as usize];
            let radial = [0.0, x[1] - 5.0, x[2] - 5.0];
            assert!(
                u[0].abs() < 1e-15 && dot(u, radial).abs() < 1e-12,
                "{u:?} at {x:?}"
            );
        }
        // An axis of no length is refused.
        let bad = Support {
            faces: vec![0],
            hold: Hold::Pinned(vec![Axis {
                origin: [0.0; 3],
                dir: [0.0; 3],
            }]),
        };
        assert_eq!(
            solve(&p(vec![bad]), &mut go).unwrap_err(),
            SolveError::InvalidSupport { support: 0 }
        );
    }

    #[test]
    fn a_turn_off_any_pin_names_its_axis() {
        // A square bar in a square sleeve slides along it, and once its end is held too it
        // cannot turn either, as a square does not turn in a square.
        let m = box_mesh([30.0, 10.0, 10.0], [6, 2, 2], 0.0);
        let p = Problem {
            mesh: &m,
            supports: vec![slider(vec![2, 3, 4, 5])],
            body_force: None,
            material: STEEL,
            fixed: vec![],
            loads: vec![],
        };
        let e = solve(&p, &mut go).unwrap_err();
        assert!(e.to_string().contains("slide along X"), "{e}");
        let p = Problem {
            supports: vec![slider(vec![2, 3, 4, 5]), slider(vec![0])],
            ..p
        };
        assert!(solve(&p, &mut go).is_ok());

        // Points held in every direction along the line y = 5, z = 5 leave the turn about it.
        let mut rows = [[0.0; 6]; 6];
        let pts: Vec<V3> = (0..=6).map(|i| [5.0 * i as f64, 5.0, 5.0]).collect();
        let (c, size) = ([15.0, 5.0, 5.0], 15.0);
        for x in &pts {
            let arm = sub(*x, c).map(|v| v / size);
            for d in AXES {
                let w = cross(arm, d);
                let r = [d[0], d[1], d[2], w[0], w[1], w[2]];
                for i in 0..6 {
                    for j in 0..6 {
                        rows[i][j] += r[i] * r[j];
                    }
                }
            }
        }
        let v = free_motion(&rows).expect("free to turn");
        let motion = motion_of(v, c, size, &[]);
        assert_eq!(
            motion.to_string(),
            "the body can still turn about an axis along X through (15, 5, 5), add a support that holds it that way"
        );
        // The same line as a pin's axis is named as the pin.
        let pin = Turning {
            pivot: Pivot::Pin,
            origin: [100.0, 5.0, 5.0],
            dir: Some([-1.0, 0.0, 0.0]),
        };
        assert!(matches!(
            motion_of(v, c, size, &[pin]),
            Motion::Turn {
                pivot: Some(Pivot::Pin),
                ..
            }
        ));
        assert_eq!(direction_words([0.0, -0.6, 0.8]), "(0, 0.6, -0.8)");
        assert_eq!(point_words([1.23456, -0.0, 2.5]), "(1.235, 0, 2.5)");
        // The eigenvalues of a small symmetric matrix.
        let (values, _) = jacobi([[2.0, 1.0], [1.0, 2.0]]);
        let mut values = values.to_vec();
        values.sort_by(f64::total_cmp);
        assert!((values[0] - 1.0).abs() < 1e-12 && (values[1] - 3.0).abs() < 1e-12);
    }

    #[test]
    fn gravity_bends_a_cantilever_by_its_weight() {
        let (l, b, h) = (100.0, 10.0, 10.0);
        let m = box_mesh([l, b, h], [40, 4, 4], 0.0);
        // Steel, 7.85 g/cm3, under 9.81 m/s2 along -Z, in N per cubic mm.
        let rho_g = 7.85 * 9.81e-6;
        let p = Problem {
            mesh: &m,
            supports: vec![],
            body_force: Some([0.0, 0.0, -rho_g]),
            material: STEEL,
            fixed: vec![0],
            loads: vec![],
        };
        let s = solve(&p, &mut go).unwrap();
        let weight = s.weight.expect("a weight");
        let want = -rho_g * l * b * h;
        assert!((weight[2] - want).abs() < 1e-12 * want.abs(), "{weight:?}");
        assert!(norm(sub(s.applied, weight)) < 1e-12 * want.abs());
        assert!(balance(&s) < 1e-6);
        // q L^4 / 8 E I with the shear term q L^2 / 2 k G A.
        let q = rho_g * b * h;
        let i = b * h * h * h / 12.0;
        let g = STEEL.e / (2.0 * (1.0 + STEEL.nu));
        let tip_want =
            q * l.powi(4) / (8.0 * STEEL.e * i) + q * l * l / (2.0 * 5.0 / 6.0 * g * b * h);
        let end = face_nodes(&m, &s, 1);
        let tip = -end
            .iter()
            .map(|&n| s.displacement[n as usize][2])
            .sum::<f64>()
            / end.len() as f64;
        eprintln!("gravity: weight {weight:?}, tip {tip:.6e} vs {tip_want:.6e}");
        assert!(
            (tip - tip_want).abs() < 0.03 * tip_want,
            "{tip} vs {tip_want}"
        );
        // The weight adds to the loads.
        let with_load = solve(
            &Problem {
                loads: vec![Load {
                    faces: vec![1],
                    kind: LoadKind::Force([0.0, 0.0, -1.0]),
                }],
                ..p
            },
            &mut go,
        )
        .unwrap();
        assert!((with_load.applied[2] - (want - 1.0)).abs() < 1e-9);
    }

    #[test]
    fn a_body_force_sums_to_the_volume_times_it() {
        let m = box_mesh([3.0, 2.0, 1.0], [3, 2, 2], 0.2);
        let q = promote(&m).unwrap();
        let geo: Vec<Geometry> = q
            .tets
            .iter()
            .map(|t| geometry([0, 1, 2, 3].map(|k| q.nodes[t[k] as usize])).unwrap())
            .collect();
        let mut f = vec![[0.0; 3]; q.nodes.len()];
        let total = body_force(&q, &geo, [1.0, -2.0, 0.5], &mut f);
        let sum = sum_of(&f);
        assert!(norm(sub(sum, [6.0, -12.0, 3.0])) < 1e-12, "{sum:?}");
        assert!(norm(sub(total, sum)) < 1e-12);
        // A corner takes minus a twentieth of an element's share, a mid-edge node a fifth.
        let n = shape_values([0.25; 4]);
        assert!((n.iter().sum::<f64>() - 1.0).abs() < 1e-15);
    }

    /// Run with `cargo test --release -- --ignored --nocapture solve_time`.
    #[test]
    #[ignore]
    fn solve_time_about_50k_tets() {
        let m = box_mesh([120.0, 24.0, 24.0], [60, 12, 12], 0.0);
        let p = Problem {
            mesh: &m,
            supports: vec![],
            body_force: None,
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
