//! `printability`: what will go wrong when the part is printed in layers
//! of extruded plastic, found while it is still a model. Overhangs past the
//! angle that prints unsupported, walls and floors too thin for the nozzle
//! and the layer, gaps narrow enough to fuse, long bridges, and shells that
//! are not closed solids.
//!
//! Measured on the triangles of a fine mesh, as `section` is: an STL is
//! triangles too, so this checks what will actually be printed. Thickness
//! and gaps are short rays from points spread over the surface, into the
//! material and out of it, stopping at the first triangle.

pub mod bridge;
pub mod bvh;
pub mod op;

use std::collections::HashMap;

use serde_json::{Map, Value};

use fundacad_protocol::pyjson::g_format;

pub fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn unit(a: [f64; 3]) -> [f64; 3] {
    let l = dot(a, a).sqrt();
    if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0, 0.0, 0.0] }
}

fn add(a: [f64; 3], b: [f64; 3], k: f64) -> [f64; 3] {
    [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
}

/// A mesh point to a hundredth of a micron: the faces of a solid share their
/// edges' points, and this is how a point on one is found on the other.
pub(crate) type Key3 = (i64, i64, i64);
pub(crate) type EdgeKey = (Key3, Key3);

fn key3(p: [f64; 3]) -> Key3 {
    ((p[0] * 1e5).round() as i64, (p[1] * 1e5).round() as i64, (p[2] * 1e5).round() as i64)
}

// --- settings ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Checks {
    pub overhang: bool,
    pub wall: bool,
    pub gap: bool,
    pub bridge: bool,
    pub open: bool,
}

pub const CHECKS: [&str; 5] = ["overhang", "wall", "gap", "bridge", "open"];

#[derive(Debug, Clone)]
pub struct Settings {
    pub nozzle: f64,
    pub layer: f64,
    /// The largest lean from vertical that prints unsupported, degrees.
    pub overhang: f64,
    pub min_gap: f64,
    pub max_bridge: f64,
    pub checks: Checks,
    pub all: bool,
    /// The build direction and how it reads, "+Z".
    pub up: ([f64; 3], String),
    /// `true` or {body: face}, as `export` takes it.
    pub lay_flat: Option<Value>,
}

/// The request's settings, checked. Keys it does not know are left alone,
/// as every op leaves them: the envelope's are in the same map.
pub fn settings_of(args: &Map<String, Value>) -> Result<Settings, String> {
    let num = |k: &str, default: f64, lo: f64, hi: f64| -> Result<f64, String> {
        match args.get(k).filter(|v| !v.is_null()) {
            None => Ok(default),
            Some(v) => match v.as_f64().filter(|x| x.is_finite() && *x > lo && *x < hi) {
                Some(x) => Ok(x),
                None => Err(format!("`{k}` is a number above {} and below {}, got {v}", g_format(lo), g_format(hi))),
            },
        }
    };
    let nozzle = num("nozzle", 0.4, 0.0, 10.0)?;
    let layer = num("layer", 0.2, 0.0, 5.0)?;
    let overhang = num("overhang", 45.0, 0.0, 90.0)?;
    let min_gap = num("minGap", 0.2, 0.0, 50.0)?;
    let max_bridge = num("maxBridge", 10.0, 0.0, 10_000.0)?;
    let checks = match args.get("checks").filter(|v| !v.is_null()) {
        None => Checks { overhang: true, wall: true, gap: true, bridge: true, open: true },
        Some(Value::Array(list)) => {
            let mut c = Checks { overhang: false, wall: false, gap: false, bridge: false, open: false };
            for v in list {
                match v.as_str() {
                    Some("overhang") => c.overhang = true,
                    Some("wall") => c.wall = true,
                    Some("gap") => c.gap = true,
                    Some("bridge") => c.bridge = true,
                    Some("open") => c.open = true,
                    _ => return Err(format!("`checks` takes {}, got {v}", CHECKS.join(", "))),
                }
            }
            c
        }
        Some(v) => return Err(format!("`checks` is a list of {}, got {v}", CHECKS.join(", "))),
    };
    let lay_flat = args.get("layFlat").filter(|v| !v.is_null() && **v != Value::Bool(false)).cloned();
    let up = match args.get("up").filter(|v| !v.is_null()) {
        None => ([0.0, 0.0, 1.0], "+Z".to_string()),
        Some(_) if lay_flat.is_some() => {
            return Err("give `up` or `layFlat`, not both: layFlat picks each part's up itself".into())
        }
        Some(v) => {
            let word = v.as_str().unwrap_or_default().trim().to_ascii_uppercase();
            let word = if word.len() == 1 { format!("+{word}") } else { word };
            let dir = match word.as_str() {
                "+X" => [1.0, 0.0, 0.0],
                "-X" => [-1.0, 0.0, 0.0],
                "+Y" => [0.0, 1.0, 0.0],
                "-Y" => [0.0, -1.0, 0.0],
                "+Z" => [0.0, 0.0, 1.0],
                "-Z" => [0.0, 0.0, -1.0],
                _ => return Err(format!("`up` is +X, -X, +Y, -Y, +Z or -Z, got {v}")),
            };
            (dir, word)
        }
    };
    if let Some(v) = &lay_flat {
        if !matches!(v, Value::Bool(true) | Value::Object(_)) {
            return Err(format!("`layFlat` is true or {{body: face index}}, got {v}"));
        }
    }
    Ok(Settings { nozzle, layer, overhang, min_gap, max_bridge, checks, all: args.get("all").and_then(Value::as_bool).unwrap_or(false), up, lay_flat })
}

// --- the bodies ------------------------------------------------------------------

/// One body's triangles, ready to measure, and which way is up for it.
pub struct Body {
    pub id: String,
    pub name: String,
    pub pts: Vec<[f64; 3]>,
    pub tris: Vec<[usize; 3]>,
    /// Each triangle's outward normal and area.
    pub n: Vec<[f64; 3]>,
    pub area: Vec<f64>,
    /// Each triangle's face, the F index `inspect` and `view` use.
    pub face: Vec<u32>,
    keys: Vec<Key3>,
    pub up: [f64; 3],
    /// The height of the bed along `up`.
    pub bed: f64,
}

/// A body's triangles as the viewport and an STL get them: flat xyz
/// positions, three indices a triangle, and each triangle's face index.
pub struct Mesh<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub positions: &'a [f32],
    pub indices: &'a [u32],
    pub face_ids: &'a [u32],
}

impl Body {
    pub fn new(mesh: &Mesh<'_>, up: [f64; 3]) -> Body {
        let p = mesh.positions;
        let pts: Vec<[f64; 3]> = p.chunks_exact(3).map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]).collect();
        let mut tris: Vec<[usize; 3]> = mesh
            .indices
            .chunks_exact(3)
            .map(|t| [t[0] as usize, t[1] as usize, t[2] as usize])
            .filter(|t| t.iter().all(|&i| i < pts.len()))
            .collect();
        // Outward is the way the tessellation winds a solid; one that comes
        // out inside out is turned round, so "down" means down.
        let volume: f64 = tris.iter().map(|t| dot(pts[t[0]], cross(pts[t[1]], pts[t[2]]))).sum();
        if volume < 0.0 {
            for t in &mut tris {
                t.swap(1, 2);
            }
        }
        let mut n = Vec::with_capacity(tris.len());
        let mut area = Vec::with_capacity(tris.len());
        for t in &tris {
            let c = cross(add(pts[t[1]], pts[t[0]], -1.0), add(pts[t[2]], pts[t[0]], -1.0));
            area.push(dot(c, c).sqrt() / 2.0);
            n.push(unit(c));
        }
        let face = (0..tris.len()).map(|i| mesh.face_ids.get(i).copied().unwrap_or(0)).collect();
        let keys = pts.iter().map(|&q| key3(q)).collect();
        let bed = pts.iter().map(|&q| dot(q, up)).fold(f64::INFINITY, f64::min);
        Body { id: mesh.id.to_string(), name: mesh.name.to_string(), pts, tris, n, area, face, keys, up, bed }
    }

    pub(crate) fn key(&self, i: usize) -> Key3 {
        self.keys[i]
    }

    pub(crate) fn edge_key(&self, i: usize, j: usize) -> EdgeKey {
        let (a, b) = (self.keys[i], self.keys[j]);
        if a <= b { (a, b) } else { (b, a) }
    }

    /// Every edge, by where its ends are, and the triangles that use it.
    fn edges(&self) -> HashMap<EdgeKey, Vec<usize>> {
        let mut m: HashMap<EdgeKey, Vec<usize>> = HashMap::new();
        for (t, [a, b, c]) in self.tris.iter().enumerate() {
            for (i, j) in [(*a, *b), (*b, *c), (*c, *a)] {
                if self.keys[i] != self.keys[j] {
                    m.entry(self.edge_key(i, j)).or_default().push(t);
                }
            }
        }
        m
    }

    /// Whether a face curves round the air rather than round the material,
    /// as a hole does and a rounded edge does not: its normals point in
    /// towards the middle of it.
    pub fn hollow(&self, face: u32) -> bool {
        let tris: Vec<usize> = (0..self.tris.len()).filter(|&t| self.face[t] == face).collect();
        let (c, _) = spread(self, &tris);
        let inward: f64 = tris
            .iter()
            .map(|&t| {
                let p = self.pts[self.tris[t][0]];
                self.area[t] * dot(self.n[t], add(c, p, -1.0))
            })
            .sum();
        inward > 0.0
    }

    /// How far round `axis` a face's normals turn, in degrees: a quarter
    /// round fillet turns 90, a hole's upper half 180, a whole hole 360.
    pub fn turns(&self, face: u32, axis: [f64; 3]) -> f64 {
        let a = unit(axis);
        let pick = if a[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let u = unit(cross(cross(a, pick), a));
        let v = cross(a, u);
        let mut angles: Vec<f64> = (0..self.tris.len())
            .filter(|&t| self.face[t] == face && self.area[t] > 0.0)
            .map(|t| dot(self.n[t], v).atan2(dot(self.n[t], u)).to_degrees())
            .collect();
        if angles.is_empty() {
            return 0.0;
        }
        angles.sort_by(f64::total_cmp);
        // All the way round less the widest gap between neighbours.
        let mut gap = angles[0] + 360.0 - angles[angles.len() - 1];
        for w in angles.windows(2) {
            gap = gap.max(w[1] - w[0]);
        }
        360.0 - gap
    }

    fn height(&self, p: [f64; 3]) -> f64 {
        dot(p, self.up) - self.bed
    }
}

/// Points spread evenly over a triangle, each with the area it stands for:
/// the centres of the n x n smaller triangles it splits into. They never
/// lie on an edge, where a ray could slip between two triangles.
pub(crate) fn sub_samples(a: [f64; 3], b: [f64; 3], c: [f64; 3], area: f64, spacing: f64) -> Vec<([f64; 3], f64)> {
    let n = ((2.0 * area).sqrt() / spacing).ceil().clamp(1.0, 400.0) as usize;
    let (ab, ac) = (add(b, a, -1.0), add(c, a, -1.0));
    let w = area / (n * n) as f64;
    let at = |s: f64, t: f64| add(add(a, ab, s), ac, t);
    let k = 3.0 * n as f64;
    let mut out = Vec::with_capacity(n * n);
    for i in 0..n {
        for j in 0..n - i {
            out.push((at((3 * i + 1) as f64 / k, (3 * j + 1) as f64 / k), w));
            if i + j + 2 <= n {
                out.push((at((3 * i + 2) as f64 / k, (3 * j + 2) as f64 / k), w));
            }
        }
    }
    out
}

// --- findings ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Overhang,
    Bridge,
    Wall,
    Floor,
    Gap,
    /// Between two bodies, as one print.
    Fused,
    MeshHole,
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub kind: Kind,
    pub body: usize,
    pub face: u32,
    pub other: Option<(usize, u32)>,
    /// The lean in degrees, the thickness or gap or span in mm.
    pub value: f64,
    pub area: f64,
    /// Overhangs: the lowest point's height above the bed.
    pub low: f64,
    pub at: [f64; 3],
    pub extent: f64,
    pub note: String,
    /// Walls, floors and gaps: what it was held to, in mm.
    pub limit: f64,
}

/// What the B-rep says about each body that the mesh cannot: open edges,
/// separate solids, the volume's sign. Keyed by body id.
#[derive(Debug, Clone, Default)]
pub struct Topology {
    pub open_edges: usize,
    pub solids: i64,
    pub volume: f64,
}

/// Run the checks. `together` is an as-modelled check, where the bodies
/// print as one object and gaps between them matter. `stop` is asked between
/// bodies; once it says so the findings so far come back.
pub fn run(
    bodies: &[Body],
    s: &Settings,
    together: bool,
    topo: &HashMap<String, Topology>,
    stop: &dyn Fn() -> bool,
) -> Vec<Finding> {
    let mut out = Vec::new();
    let edges: Vec<HashMap<EdgeKey, Vec<usize>>> = bodies.iter().map(Body::edges).collect();
    let (tree, index) = tree_of(bodies);
    if s.checks.overhang || s.checks.bridge {
        // Printed as one, a body can stand on another.
        let others = (together && bodies.len() > 1).then_some(&tree);
        for bi in 0..bodies.len() {
            if stop() {
                return out;
            }
            out.extend(overhangs(bodies, bi, &edges[bi], s, others));
        }
    }
    if s.checks.wall || s.checks.gap {
        out.extend(thickness(bodies, s, together, &tree, &index, stop));
    }
    if s.checks.open {
        for (bi, b) in bodies.iter().enumerate() {
            let closed = topo.get(&b.id).map_or(true, |t| t.open_edges == 0);
            if closed {
                out.extend(mesh_hole(bi, b, &edges[bi]));
            }
        }
    }
    out
}

/// Every body's triangles in one tree, and where each body's are in it.
fn tree_of(bodies: &[Body]) -> (bvh::Bvh, Vec<Vec<usize>>) {
    let mut tris = Vec::new();
    let mut index: Vec<Vec<usize>> = Vec::new();
    for (bi, b) in bodies.iter().enumerate() {
        let mut mine = Vec::with_capacity(b.tris.len());
        for (t, [x, y, z]) in b.tris.iter().enumerate() {
            mine.push(tris.len());
            tris.push(bvh::Tri { p: [b.pts[*x], b.pts[*y], b.pts[*z]], body: bi, tri: t });
        }
        index.push(mine);
    }
    (bvh::Bvh::new(tris), index)
}

/// Whether the point of body `bi` sits on another body: within half a layer
/// below it, or just inside, a face of another body that faces up.
fn rests(bodies: &[Body], bi: usize, tree: &bvh::Bvh, p: [f64; 3], layer: f64) -> bool {
    let up = bodies[bi].up;
    let down = [-up[0], -up[1], -up[2]];
    tree.first_hit(p, down, -layer / 2.0, layer / 2.0, usize::MAX, |o| o != bi)
        .is_some_and(|(h, _)| dot(bodies[h.body].n[h.tri], up) > 0.5)
}

/// The rims of other bodies' flat tops at the height `at` along up, which a
/// ceiling of `bi` reaching them is held by, as a bridge between two posts is.
fn tops_at(bodies: &[Body], bi: usize, at: f64, layer: f64) -> Vec<([f64; 3], [f64; 3])> {
    let level = 1f64.to_radians().cos();
    let up = bodies[bi].up;
    let mut out = Vec::new();
    for (o, b) in bodies.iter().enumerate() {
        if o == bi {
            continue;
        }
        let mut count: HashMap<EdgeKey, (usize, usize, usize)> = HashMap::new();
        for (t, &[x, y, z]) in b.tris.iter().enumerate() {
            if b.area[t] <= 0.0 || dot(b.n[t], up) < level || (dot(b.pts[x], up) - at).abs() > layer / 2.0 {
                continue;
            }
            for (i, j) in [(x, y), (y, z), (z, x)] {
                count.entry(b.edge_key(i, j)).and_modify(|e| e.2 += 1).or_insert((i, j, 1));
            }
        }
        out.extend(count.values().filter(|e| e.2 == 1).map(|&(i, j, _)| (b.pts[i], b.pts[j])));
    }
    out
}

/// Faces that lean out further than prints unsupported, one finding a face.
fn overhangs(
    bodies: &[Body],
    bi: usize,
    edges: &HashMap<EdgeKey, Vec<usize>>,
    s: &Settings,
    others: Option<&bvh::Bvh>,
) -> Vec<Finding> {
    let b = &bodies[bi];
    let limit = 90.0 - s.overhang - 0.5;
    let on_other = |p: [f64; 3]| others.is_some_and(|tree| rests(bodies, bi, tree, p, s.layer));
    let mut by_face: HashMap<u32, Vec<(usize, f64)>> = HashMap::new();
    for (t, n) in b.n.iter().enumerate() {
        if b.area[t] <= 0.0 {
            continue;
        }
        // Tilt from facing straight down: 0 is a flat ceiling. A flat one
        // is checked as a bridge whatever angle prints unsupported.
        let tilt = (-dot(*n, b.up)).clamp(-1.0, 1.0).acos().to_degrees();
        if tilt >= limit && !(tilt < 1.0 && s.checks.bridge) {
            continue;
        }
        let top = b.tris[t].iter().map(|&i| b.height(b.pts[i])).fold(f64::NEG_INFINITY, f64::max);
        if top <= s.layer / 2.0 {
            continue; // on the bed
        }
        // Lying on another body all over: held up as well as by the bed.
        if tilt >= 1.0 && others.is_some() {
            let [x, y, z] = b.tris[t];
            let spacing = (2.0 * b.area[t]).sqrt() / 4.0;
            if sub_samples(b.pts[x], b.pts[y], b.pts[z], b.area[t], spacing).into_iter().all(|(p, _)| on_other(p)) {
                continue;
            }
        }
        by_face.entry(b.face[t]).or_default().push((t, tilt));
    }
    let mut out = Vec::new();
    for (face, tris) in by_face {
        let area: f64 = tris.iter().map(|(t, _)| b.area[*t]).sum();
        if area < 1.0 {
            continue;
        }
        let ids: Vec<usize> = tris.iter().map(|(t, _)| *t).collect();
        let flat = tris.iter().all(|(_, tilt)| *tilt < 1.0);
        let mut note = String::new();
        if flat {
            let height = dot(b.pts[b.tris[ids[0]][0]], b.up);
            let posts = if others.is_some() { tops_at(bodies, bi, height, s.layer) } else { Vec::new() };
            match bridge::span(b, &ids, edges, &on_other, &posts) {
                bridge::Span::Bridged(span) if span <= s.max_bridge + 1e-6 => continue,
                bridge::Span::Bridged(span) => {
                    if s.checks.bridge {
                        let (at, extent) = spread(b, &ids);
                        out.push(Finding {
                            kind: Kind::Bridge,
                            body: bi,
                            face,
                            other: None,
                            value: span,
                            area,
                            low: 0.0,
                            at,
                            extent,
                            note: String::new(),
                            limit: s.max_bridge,
                        });
                    }
                    continue;
                }
                bridge::Span::Ledge { partly } => {
                    if partly {
                        note = "partly bridged".into();
                    }
                }
            }
        }
        // A ceiling here only for the bridge check, at an angle that prints.
        if !s.checks.overhang || !tris.iter().any(|(_, tilt)| *tilt < limit) {
            continue;
        }
        let worst = tris.iter().map(|(_, tilt)| 90.0 - tilt).fold(0.0, f64::max);
        let low = ids
            .iter()
            .flat_map(|&t| b.tris[t].iter().map(|&i| b.height(b.pts[i])))
            .fold(f64::INFINITY, f64::min);
        let (at, extent) = spread(b, &ids);
        out.push(Finding { kind: Kind::Overhang, body: bi, face, other: None, value: worst, area, low, at, extent, note, limit: 0.0 });
    }
    out
}

/// The area-weighted centre of some triangles and the size of their box.
fn spread(b: &Body, tris: &[usize]) -> ([f64; 3], f64) {
    let mut c = [0.0; 3];
    let mut w = 0.0;
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for &t in tris {
        let a = b.area[t];
        for &i in &b.tris[t] {
            let p = b.pts[i];
            c = add(c, p, a / 3.0);
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        w += a;
    }
    let at = if w > 0.0 { [c[0] / w, c[1] / w, c[2] / w] } else { lo };
    (at, diag(lo, hi))
}

fn diag(lo: [f64; 3], hi: [f64; 3]) -> f64 {
    let d = add(hi, lo, -1.0);
    dot(d, d).sqrt()
}

/// Several points' worth of one wall, floor or gap between two faces: the
/// area each side, and every point's measure, weight and middle.
#[derive(Default)]
struct Cluster {
    area: [f64; 2],
    /// Each point's measure, weight, middle and the limit it was held to.
    points: Vec<(f64, f64, [f64; 3], f64)>,
}

impl Cluster {
    /// The thinnest measure, and where: the middle of the points within a
    /// hundredth of it, so a wall of one even thickness is pointed at its
    /// middle rather than at whichever point came first.
    fn least(&self) -> (f64, [f64; 3], f64, f64) {
        let least = self.points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let held = self.points.iter().filter(|p| p.0 <= least).map(|p| p.3).fold(0.0, f64::max);
        let mut c = [0.0; 3];
        let mut w = 0.0;
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for (v, pw, m, _) in &self.points {
            for k in 0..3 {
                lo[k] = lo[k].min(m[k]);
                hi[k] = hi[k].max(m[k]);
            }
            if *v <= least + 0.01 {
                c = add(c, *m, *pw);
                w += pw;
            }
        }
        let at = if w > 0.0 { [c[0] / w, c[1] / w, c[2] / w] } else { lo };
        (least, at, diag(lo, hi), held)
    }
}

/// Two faces this close to opposite each other bound a wall or a gap. Any
/// wider and a corner's two sides would count: a 45 degree rim is not a wall.
const FACING: f64 = -0.9;

/// How far under its limit a measure has to be to count: a round wall's
/// facets stand a little closer than its curves, and a part far from the
/// origin carries a few microns of noise, so a wall modelled at the limit
/// must not be reported as under it.
const SLACK: f64 = 0.99;

/// Walls, floors and gaps, by rays from points over every surface.
fn thickness(
    bodies: &[Body],
    s: &Settings,
    together: bool,
    tree: &bvh::Bvh,
    index: &[Vec<usize>],
    stop: &dyn Fn() -> bool,
) -> Vec<Finding> {
    let total: f64 = bodies.iter().flat_map(|b| b.area.iter()).sum();
    let spacing = s.nozzle.max((total / 300_000.0).sqrt());
    let wall_ray = (2.0 * s.nozzle).max(2.0 * s.layer) + 0.05;
    let gap_ray = s.min_gap.max(s.layer) + 0.05;
    let steep = std::f64::consts::FRAC_1_SQRT_2;
    const EPS: f64 = 1e-6;

    let mut clusters: HashMap<(Kind, (usize, u32), (usize, u32)), Cluster> = HashMap::new();
    let mut note = |kind: Kind, from: (usize, u32), to: (usize, u32), w: f64, value: f64, mid: [f64; 3], limit: f64| {
        let (a, b, side) = if from <= to { (from, to, 0) } else { (to, from, 1) };
        let c = clusters.entry((kind, a, b)).or_default();
        c.area[side] += w;
        c.points.push((value, w, mid, limit));
    };

    for (bi, b) in bodies.iter().enumerate() {
        if stop() {
            break;
        }
        for (t, [x, y, z]) in b.tris.iter().enumerate() {
            if b.area[t] <= 0.0 {
                continue;
            }
            let n = b.n[t];
            let me = (bi, b.face[t]);
            let vertical = dot(n, b.up).abs() > steep;
            for (p, w) in sub_samples(b.pts[*x], b.pts[*y], b.pts[*z], b.area[t], spacing) {
                if s.checks.wall {
                    let d = [-n[0], -n[1], -n[2]];
                    // Only this body: a part pressed into it hides nothing.
                    if let Some((h, _)) = tree.first_hit(p, d, EPS, wall_ray, index[bi][t], |o| o == bi) {
                        let facing = dot(bodies[h.body].n[h.tri], n) < FACING;
                        if h.body == bi && facing {
                            let (kind, limit) = if vertical {
                                (Kind::Floor, 2.0 * s.layer)
                            } else {
                                (Kind::Wall, 2.0 * s.nozzle)
                            };
                            if h.t < limit * SLACK {
                                note(kind, me, (bi, b.face[h.tri]), w, h.t, add(p, d, h.t / 2.0), limit);
                            }
                        }
                    }
                }
                if s.checks.gap {
                    // Laid apart, other bodies are not there.
                    if let Some((h, _)) = tree.first_hit(p, n, -1e-5, gap_ray, index[bi][t], |o| together || o == bi) {
                        let o = &bodies[h.body];
                        if dot(o.n[h.tri], n) < FACING {
                            let limit = if vertical { s.min_gap.max(s.layer) } else { s.min_gap };
                            let other = (h.body, o.face[h.tri]);
                            let mid = add(p, n, h.t / 2.0);
                            if h.body == bi {
                                if h.t < limit * SLACK && h.t > EPS {
                                    note(Kind::Gap, me, other, w, h.t, mid, limit);
                                }
                            } else if together && h.t < limit * SLACK {
                                note(Kind::Fused, me, other, w, h.t.max(0.0), mid, limit);
                            }
                        }
                    }
                }
            }
        }
    }
    clusters
        .into_iter()
        .filter_map(|((kind, a, b), c)| {
            let area = c.area[0].max(c.area[1]);
            if area < 0.25 {
                return None;
            }
            let (value, at, extent, limit) = c.least();
            Some(Finding { kind, body: a.0, face: a.1, other: Some(b), value, area, low: 0.0, at, extent, note: String::new(), limit })
        })
        .collect()
}

/// An edge only one triangle uses, on a body the B-rep calls closed: a face
/// that did not triangulate, which an STL export would leave out too.
fn mesh_hole(bi: usize, b: &Body, edges: &HashMap<EdgeKey, Vec<usize>>) -> Option<Finding> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    let mut count = 0;
    let mut face = 0;
    for ((a, c), users) in edges {
        if users.len() != 1 {
            continue;
        }
        count += 1;
        face = b.face[users[0]];
        for p in [a, c] {
            let q = [p.0 as f64 / 1e5, p.1 as f64 / 1e5, p.2 as f64 / 1e5];
            for k in 0..3 {
                lo[k] = lo[k].min(q[k]);
                hi[k] = hi[k].max(q[k]);
            }
        }
    }
    (count > 0).then(|| Finding {
        kind: Kind::MeshHole,
        body: bi,
        face,
        other: None,
        value: count as f64,
        area: 0.0,
        low: 0.0,
        at: [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0],
        extent: diag(lo, hi),
        note: String::new(),
        limit: 0.0,
    })
}

// --- the reply ------------------------------------------------------------------

/// How many of each kind a body lists before the rest are only counted.
const SHOWN: usize = 5;

fn mm(v: f64) -> String {
    let r = (v * 1000.0).round() / 1000.0;
    g_format(if r == 0.0 { 0.0 } else { r })
}

/// Four significant figures, for areas.
fn sig4(v: f64) -> String {
    if v.abs() < 1e-9 {
        return "0".into();
    }
    let digits = (4 - v.abs().log10().floor() as i32 - 1).max(0);
    let k = 10f64.powi(digits);
    g_format((v * k).round() / k)
}

fn who(b: &Body) -> String {
    if b.name.is_empty() || b.name == b.id { b.id.clone() } else { format!("{} \"{}\"", b.id, b.name) }
}

fn focus(f: &Finding) -> String {
    let size = (2.0 * f.extent).round().max(5.0);
    format!("focus {{at: [{}, {}, {}], size: {}}}", mm(f.at[0]), mm(f.at[1]), mm(f.at[2]), g_format(size))
}

fn noun(kind: Kind, n: usize) -> String {
    let (one, many) = match kind {
        Kind::Overhang => ("overhang", "overhangs"),
        Kind::Bridge => ("long bridge", "long bridges"),
        Kind::Wall => ("thin wall", "thin walls"),
        Kind::Floor => ("thin floor", "thin floors"),
        Kind::Gap => ("narrow gap", "narrow gaps"),
        Kind::Fused => ("fused pair", "fused pairs"),
        Kind::MeshHole => ("mesh hole", "mesh holes"),
    };
    format!("{n} {}", if n == 1 { one } else { many })
}

fn line(f: &Finding, bodies: &[Body], s: &Settings) -> String {
    let faces = match f.other {
        Some((_, o)) if o != f.face => format!("F{}|F{o}", f.face),
        _ => format!("F{}", f.face),
    };
    let tail = if f.note.is_empty() { String::new() } else { format!(", {}", f.note) };
    match f.kind {
        Kind::Overhang => format!(
            "overhang {faces}: {} mm2 needs support, leaning up to {} deg, {}{tail}. {}",
            sig4(f.area),
            g_format(f.value.round()),
            if f.low <= s.layer { "from the bed up".to_string() } else { format!("from {} mm above the bed", mm(f.low)) },
            focus(f)
        ),
        Kind::Bridge => format!(
            "bridge {faces}: {} mm span (over {}){tail}. {}",
            mm(f.value),
            g_format(s.max_bridge),
            focus(f)
        ),
        Kind::Wall => format!(
            "wall {faces}: {} mm over {} mm2, {}{tail}. {}",
            mm(f.value),
            sig4(f.area),
            if f.value < s.nozzle - 1e-6 {
                format!("will not print (under the {} mm nozzle)", g_format(s.nozzle))
            } else {
                format!("one perimeter (under {})", mm(2.0 * s.nozzle))
            },
            focus(f)
        ),
        Kind::Floor => format!(
            "floor {faces}: {} mm over {} mm2, {}{tail}. {}",
            mm(f.value),
            sig4(f.area),
            if f.value < s.layer - 1e-6 {
                format!("under one {} mm layer, slices away", g_format(s.layer))
            } else {
                format!("under two layers ({})", mm(2.0 * s.layer))
            },
            focus(f)
        ),
        Kind::Gap => format!(
            "gap {faces}: {} mm over {} mm2, will fuse shut (under {}){tail}. {}",
            mm(f.value),
            sig4(f.area),
            if f.limit > s.min_gap + 1e-9 {
                format!("{}, one layer, as it lies flat", g_format(f.limit))
            } else {
                g_format(s.min_gap)
            },
            focus(f)
        ),
        Kind::Fused => {
            let (ob, of) = f.other.unwrap_or((f.body, f.face));
            let gap = if f.value < 1e-3 { "touching".to_string() } else { format!("{} mm gap", mm(f.value)) };
            format!(
                "{} F{} | {} F{of}: {gap} over {} mm2, will print fused. {}",
                bodies[f.body].id,
                f.face,
                bodies[ob].id,
                sig4(f.area),
                focus(f)
            )
        }
        Kind::MeshHole => format!(
            "the mesh has a hole near F{}: {} edges of it bound one triangle, a face did not triangulate and an STL export will have the hole too. {}",
            f.face,
            g_format(f.value),
            focus(f)
        ),
    }
}

/// The whole reply. `header` says how the parts sit; `topo` adds what the
/// B-rep knows about open shells.
pub fn report(bodies: &[Body], findings: &[Finding], s: &Settings, header: &str, topo: &HashMap<String, Topology>) -> String {
    let mut out = vec![format!(
        "Printability, {header}; nozzle {}, layer {}, overhang {} deg, gap {}, bridge {} mm:",
        g_format(s.nozzle),
        g_format(s.layer),
        g_format(s.overhang),
        g_format(s.min_gap),
        g_format(s.max_bridge)
    )];
    let mut hidden = 0;
    let mut quiet = 0;
    let many = bodies.len() > 20;
    for (bi, b) in bodies.iter().enumerate() {
        let mut lines = Vec::new();
        let mut counts: Vec<String> = Vec::new();
        if s.checks.open {
            if let Some(t) = topo.get(&b.id) {
                if t.open_edges > 0 {
                    counts.push("open shell".into());
                    lines.push(format!(
                        "open: {} edge{} bound one face, not a closed solid; it may print filled in or not at all",
                        t.open_edges,
                        if t.open_edges == 1 { "" } else { "s" }
                    ));
                }
                if t.solids > 1 {
                    counts.push(format!("{} pieces", t.solids));
                    lines.push(format!("{} separate pieces in one body, each prints on its own", t.solids));
                }
                if t.volume < 0.0 {
                    counts.push("inside out".into());
                    lines.push("inside out: its volume is negative, it may print hollow or not at all".into());
                }
            }
        }
        let mine: Vec<&Finding> = findings.iter().filter(|f| f.body == bi && f.kind != Kind::Fused).collect();
        for kind in [Kind::Overhang, Kind::Bridge, Kind::Wall, Kind::Floor, Kind::Gap, Kind::MeshHole] {
            let mut of: Vec<&&Finding> = mine.iter().filter(|f| f.kind == kind).collect();
            if of.is_empty() {
                continue;
            }
            match kind {
                Kind::Overhang => of.sort_by(|a, b| b.area.total_cmp(&a.area)),
                Kind::Bridge => of.sort_by(|a, b| b.value.total_cmp(&a.value)),
                _ => of.sort_by(|a, b| a.value.total_cmp(&b.value)),
            }
            counts.push(noun(kind, of.len()));
            let keep = if s.all { of.len() } else { of.len().min(SHOWN) };
            hidden += of.len() - keep;
            for f in &of[..keep] {
                lines.push(line(f, bodies, s));
            }
        }
        if lines.is_empty() {
            if many {
                quiet += 1;
            } else {
                out.push(format!("{}: nothing found", who(b)));
            }
            continue;
        }
        out.push(format!("{}: {}", who(b), counts.join(", ")));
        for l in lines {
            out.push(format!("  {l}"));
        }
    }
    if quiet > 0 {
        out.push(format!("{quiet} other bodies: nothing found"));
    }
    let mut fused: Vec<&Finding> = findings.iter().filter(|f| f.kind == Kind::Fused).collect();
    fused.sort_by(|a, b| a.value.total_cmp(&b.value));
    if !fused.is_empty() {
        let keep = if s.all { fused.len() } else { fused.len().min(SHOWN) };
        hidden += fused.len() - keep;
        out.push("Between bodies:".into());
        for f in &fused[..keep] {
            out.push(format!("  {}", line(f, bodies, s)));
        }
    }
    if hidden > 0 {
        out.push(format!("{hidden} more finding{} not shown; all:true lists them.", if hidden == 1 { "" } else { "s" }));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A closed box's positions, indices and face ids, two triangles a
    /// side, each side its own face.
    type Raw = (Vec<f32>, Vec<u32>, Vec<u32>);

    fn box_raw(lo: [f64; 3], hi: [f64; 3]) -> Raw {
        let c = |i: usize| -> [f64; 3] {
            [if i & 1 == 0 { lo[0] } else { hi[0] }, if i & 2 == 0 { lo[1] } else { hi[1] }, if i & 4 == 0 { lo[2] } else { hi[2] }]
        };
        // Outward-wound quads: -X, +X, -Y, +Y, -Z, +Z.
        let quads = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        let mut face_ids = Vec::new();
        for (f, q) in quads.iter().enumerate() {
            let base = (positions.len() / 3) as u32;
            for &i in q {
                positions.extend(c(i).iter().map(|&x| x as f32));
            }
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
            face_ids.extend([f as u32, f as u32]);
        }
        (positions, indices, face_ids)
    }

    fn box_body(id: &str, lo: [f64; 3], hi: [f64; 3]) -> Body {
        let (positions, indices, face_ids) = box_raw(lo, hi);
        Body::new(&Mesh { id, name: "", positions: &positions, indices: &indices, face_ids: &face_ids }, [0.0, 0.0, 1.0])
    }

    fn defaults() -> Settings {
        settings_of(&Map::new()).unwrap()
    }

    #[test]
    fn settings_refuse_values_they_cannot_use() {
        let m = |v: Value| v.as_object().cloned().unwrap();
        assert!(settings_of(&m(json!({"nozzle": -1}))).is_err());
        assert!(settings_of(&m(json!({"up": "+Z", "layFlat": true}))).is_err());
        assert!(settings_of(&m(json!({"checks": ["walls"]}))).is_err());
        let s = settings_of(&m(json!({"up": "-y", "checks": ["gap"]}))).unwrap();
        assert_eq!(s.up.1, "-Y");
        assert!(s.checks.gap && !s.checks.wall);
    }

    #[test]
    fn samples_cover_the_triangle_once() {
        let s = sub_samples([0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0], 8.0, 1.0);
        let total: f64 = s.iter().map(|(_, w)| w).sum();
        assert!((total - 8.0).abs() < 1e-9);
        assert!(s.iter().all(|(p, _)| p[0] > 0.0 && p[1] > 0.0 && p[0] + p[1] < 4.0));
    }

    #[test]
    fn a_box_on_the_bed_is_fine() {
        let b = box_body("body1", [0.0; 3], [20.0, 20.0, 10.0]);
        let f = run(&[b], &defaults(), true, &HashMap::new(), &|| false);
        assert!(f.is_empty(), "{f:?}");
    }

    #[test]
    fn a_thin_fin_is_one_perimeter_and_counted_once() {
        let b = box_body("body1", [0.0; 3], [0.6, 20.0, 10.0]);
        let f = run(&[b], &defaults(), true, &HashMap::new(), &|| false);
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].kind, Kind::Wall);
        assert!((f[0].value - 0.6).abs() < 1e-6 && (f[0].area - 200.0).abs() < 1e-6, "{f:?}");
    }

    #[test]
    fn two_boxes_a_tenth_apart_print_fused_unless_laid_apart() {
        let a = box_body("body1", [0.0; 3], [10.0; 3]);
        let b = box_body("body2", [10.1, 0.0, 0.0], [20.1, 10.0, 10.0]);
        let f = run(&[a, b], &defaults(), true, &HashMap::new(), &|| false);
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].kind, Kind::Fused);
        assert!((f[0].value - 0.1).abs() < 1e-5, "{f:?}");
        let a = box_body("body1", [0.0; 3], [10.0; 3]);
        let b = box_body("body2", [10.1, 0.0, 0.0], [20.1, 10.0, 10.0]);
        assert!(run(&[a, b], &defaults(), false, &HashMap::new(), &|| false).is_empty());
    }

    #[test]
    fn a_box_in_the_air_has_its_bottom_as_an_overhang_but_not_on_the_bed() {
        // Two boxes as one print: the high one's bottom hangs over nothing.
        let low = box_body("body1", [0.0; 3], [5.0; 3]);
        let mut high = box_body("body2", [20.0, 0.0, 10.0], [30.0, 10.0, 12.0]);
        high.bed = 0.0;
        let f = run(&[low, high], &defaults(), true, &HashMap::new(), &|| false);
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!((f[0].kind, f[0].body, f[0].face), (Kind::Overhang, 1, 4));
        assert_eq!(f[0].value, 90.0);
        assert_eq!(f[0].low, 10.0);
    }
}
