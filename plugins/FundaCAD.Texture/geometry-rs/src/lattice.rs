//! texture_mesh.py's refinement: getting a triangulation fine enough, and
//! aligned enough, to carry a texture. A lattice lays its sample lines on the
//! pattern's own creases, a cellular kind brings its own vertices, a planar or
//! revolved face is re-triangulated in its mm chart, and anything else is
//! subdivided on the true surface.
//!
//! scipy's Delaunay (Qhull) is replaced by delaunator. Both give the Delaunay
//! triangulation of the same points, which is unique except inside a cell
//! whose corners are co-circular, where Qhull breaks the tie by its insertion
//! order. Where that diagonal decides the surface, `force_cell_diagonals` and
//! `flip_to_creases` pick it from the height field on both engines; where it
//! does not, both diagonals lie in one plane.

use std::collections::HashMap;

use crate::chart::{self, Surf};
use crate::height::{hex_corners, hex_wall_width, wave_levels};
use crate::nearest::Tree;
use crate::np;
use crate::spec::Spec;
use crate::v3::{self, V};

pub type Tri = [usize; 3];
pub type P2 = [f64; 2];

/// `_boundary_edges`: every edge with its triangle count, in the order the
/// triangles first reach it (a Counter keeps insertion order).
pub struct EdgeCount {
    pub order: Vec<(usize, usize)>,
    pub count: HashMap<(usize, usize), usize>,
}

pub fn edge_count(tris: &[Tri]) -> EdgeCount {
    let mut order = Vec::new();
    let mut count: HashMap<(usize, usize), usize> = HashMap::new();
    for t in tris {
        for (i, j) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let key = if i < j { (i, j) } else { (j, i) };
            let c = count.entry(key).or_insert(0);
            if *c == 0 {
                order.push(key);
            }
            *c += 1;
        }
    }
    EdgeCount { order, count }
}

impl EdgeCount {
    pub fn boundary(&self) -> Vec<(usize, usize)> {
        self.order.iter().copied().filter(|k| self.count[k] == 1).collect()
    }
}

/// `_points_in_polygon`: even-odd ray cast along +x against edge segments.
pub fn points_in_polygon(pts: &[P2], ring_a: &[P2], ring_b: &[P2]) -> Vec<bool> {
    pts.iter()
        .map(|p| {
            let mut hits = 0usize;
            for (a, b) in ring_a.iter().zip(ring_b) {
                let straddles = (a[1] <= p[1]) != (b[1] <= p[1]);
                if !straddles {
                    continue;
                }
                let dy = if (b[1] - a[1]).abs() < 1e-30 { 1e-30 } else { b[1] - a[1] };
                let t = (p[1] - a[1]) / dy;
                let xint = a[0] + t * (b[0] - a[0]);
                if xint > p[0] {
                    hits += 1;
                }
            }
            hits % 2 == 1
        })
        .collect()
}

/// `_cell_lattice_points`: the explicit vertex set of the cellular kinds, in
/// mm chart coordinates; only hex has one.
#[allow(clippy::too_many_arguments)]
pub fn cell_lattice_points(
    kind: &str,
    spec: &Spec,
    scale: f64,
    lo_u: f64,
    hi_u: f64,
    lo_v: f64,
    hi_v: f64,
    wrap_u: Option<f64>,
) -> Option<Vec<P2>> {
    if kind != "hex" {
        return None;
    }
    let a = scale;
    let root3 = 3f64.sqrt();
    let w = hex_wall_width(a, spec.sharpness);
    let r_out = a / root3;
    let r_in = (a * 0.5 - w).max(1e-6) * 2.0 / root3;
    let pad = a;
    let j0 = ((lo_v - pad) / (a * root3 * 0.5)).floor() as i64;
    let j1 = ((hi_v + pad) / (a * root3 * 0.5)).ceil() as i64;
    let mut sites: Vec<P2> = Vec::new();
    for j in j0..=j1 {
        let sy = j as f64 * a * root3 * 0.5;
        let i0 = ((lo_u - pad) / a - j as f64 * 0.5).floor() as i64;
        let i1 = ((hi_u + pad) / a - j as f64 * 0.5).ceil() as i64;
        if i1 < i0 {
            continue;
        }
        for i in i0..=i1 {
            sites.push([i as f64 * a + j as f64 * a * 0.5, sy]);
        }
    }
    if sites.is_empty() {
        return None;
    }
    let corners = hex_corners();
    let edge_len = r_out;
    let frac = (0.5 * w / edge_len.max(1e-9)).max(0.015).min(0.4);
    let mut outer: Vec<[P2; 6]> = Vec::with_capacity(sites.len());
    let mut inner: Vec<[P2; 6]> = Vec::with_capacity(sites.len());
    for s in &sites {
        let mut o = [[0.0; 2]; 6];
        let mut n = [[0.0; 2]; 6];
        for k in 0..6 {
            o[k] = [s[0] + r_out * corners[k][0], s[1] + r_out * corners[k][1]];
            n[k] = [s[0] + r_in * corners[k][0], s[1] + r_in * corners[k][1]];
        }
        outer.push(o);
        inner.push(n);
    }
    let mut pts: Vec<P2> = Vec::new();
    for o in &outer {
        pts.extend_from_slice(o);
    }
    for n in &inner {
        pts.extend_from_slice(n);
    }
    for f in [frac, 0.5, 1.0 - frac] {
        for o in &outer {
            for k in 0..6 {
                let nx = o[(k + 1) % 6];
                let step = [nx[0] - o[k][0], nx[1] - o[k][1]];
                pts.push([o[k][0] + step[0] * f, o[k][1] + step[1] * f]);
            }
        }
    }
    if let Some(turn) = wrap_u {
        let folded = np::unique_rows(
            pts.iter()
                .map(|p| [np::round(np::fmod(p[0], turn), 9), np::round(p[1], 9)])
                .collect(),
        );
        let mut both = Vec::with_capacity(folded.len() * 3);
        for shift in [-turn, 0.0, turn] {
            both.extend(folded.iter().map(|p| [p[0] + shift, p[1]]));
        }
        pts = both.into_iter().filter(|p| p[0] >= lo_u && p[0] <= hi_u).collect();
    }
    Some(np::unique_rows(pts.iter().map(|p| [np::round(p[0], 9), np::round(p[1], 9)]).collect()))
}

/// `_crease_phases`: the trapezoid's gradient breakpoints in one period.
pub fn crease_phases(land: f64) -> Vec<f64> {
    let k = land.clamp(0.0, 0.98);
    if k <= 1e-9 {
        return vec![0.0, 0.5];
    }
    vec![k / 4.0, 0.5 - k / 4.0, 0.5 + k / 4.0, 1.0 - k / 4.0]
}

pub fn wave_phases() -> Vec<f64> {
    let _ = wave_levels();
    crate::height::wave_phases()
}

pub enum Axes {
    None,
    Lines(Option<Vec<f64>>, Option<Vec<f64>>),
    Cells,
}

/// `_pattern_axes`.
pub fn pattern_axes(kind: &str, spec: &Spec) -> Axes {
    if !spec.facet() {
        return Axes::None;
    }
    let land = spec.sharpness;
    match kind {
        "ribs" => Axes::Lines(Some(crease_phases(land)), None),
        "waves" => Axes::Lines(Some(wave_phases()), None),
        "knurl" => Axes::Lines(Some(crease_phases(land)), Some(crease_phases(land))),
        "hex" => Axes::Cells,
        _ => Axes::None,
    }
}

/// `_axis_lines`.
pub fn axis_lines(phases: Option<&[f64]>, period: f64, lo: f64, hi: f64) -> Vec<f64> {
    let zero = [0.0];
    let phases = phases.unwrap_or(&zero);
    let n0 = (lo / period).floor() as i64 - 1;
    let n1 = (hi / period).ceil() as i64 + 1;
    let mut vals = Vec::new();
    for n in n0..=n1 {
        for t in phases {
            vals.push(np::round((n as f64 + t) * period, 9));
        }
    }
    np::unique(vals).into_iter().filter(|&v| v >= lo && v <= hi).collect()
}

/// `_segment_crossings`.
pub fn segment_crossings(a: f64, b: f64, phases: Option<&[f64]>, period: f64) -> Vec<f64> {
    let Some(phases) = phases else {
        return Vec::new();
    };
    if period <= 0.0 {
        return Vec::new();
    }
    let span = b - a;
    if span.abs() < 1e-12 {
        return Vec::new();
    }
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    let mut out = Vec::new();
    for n in ((lo / period).floor() as i64 - 1)..((hi / period).ceil() as i64 + 2) {
        for ph in phases {
            let c = (n as f64 + ph) * period;
            if lo < c && c < hi {
                out.push((c - a) / span);
            }
        }
    }
    out
}

const FLIP_BARY: [[f64; 3]; 7] = [
    [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
    [0.60, 0.20, 0.20],
    [0.20, 0.60, 0.20],
    [0.20, 0.20, 0.60],
    [0.45, 0.45, 0.10],
    [0.10, 0.45, 0.45],
    [0.45, 0.10, 0.45],
];

fn edge_map(tris: &[Tri]) -> HashMap<(usize, usize), Vec<usize>> {
    let mut m: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for (ti, t) in tris.iter().enumerate() {
        for (i, j) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            m.entry(if i < j { (i, j) } else { (j, i) }).or_default().push(ti);
        }
    }
    m
}

/// `_force_cell_diagonals`: each complete lattice cell gets the diagonal the
/// pattern needs.
pub fn force_cell_diagonals(mut tris: Vec<Tri>, quads: &[[usize; 4]], want_main: &[bool]) -> Vec<Tri> {
    // read, never rewritten, as the Python loop reads the map it built first
    let where_ = edge_map(&tris);
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };
    for (q, &main) in quads.iter().zip(want_main) {
        let [a, b, c, d] = *q;
        let (have, want) = if main { ((b, d), (a, c)) } else { ((a, c), (b, d)) };
        if where_.get(&key(want.0, want.1)).map_or(0, Vec::len) == 2 {
            continue;
        }
        let share = where_.get(&key(have.0, have.1)).cloned().unwrap_or_default();
        if share.len() != 2 {
            continue;
        }
        let (t0, t1) = (share[0], share[1]);
        let mut verts: Vec<usize> = tris[t0].iter().chain(tris[t1].iter()).copied().collect();
        verts.sort_unstable();
        verts.dedup();
        let mut quad = vec![a, b, c, d];
        quad.sort_unstable();
        if verts != quad {
            continue;
        }
        tris[t0] = [want.0, want.1, have.0];
        tris[t1] = [want.0, want.1, have.1];
    }
    tris
}

fn segments_cross(p_: &[P2], p: usize, q: usize, r: usize, s: usize) -> bool {
    let side = |a: usize, b: usize, c: usize| {
        (p_[b][0] - p_[a][0]) * (p_[c][1] - p_[a][1]) - (p_[b][1] - p_[a][1]) * (p_[c][0] - p_[a][0])
    };
    side(p, q, r) * side(p, q, s) < 0.0 && side(r, s, p) * side(r, s, q) < 0.0
}

/// `_flip_to_creases`: flip a shared edge wherever that strictly lowers the
/// worst deviation from the true field inside the two triangles.
pub fn flip_to_creases(
    mut tris: Vec<Tri>,
    vmm: &[P2],
    field: &dyn Fn(&[P2]) -> Result<Vec<f64>, String>,
    n_ring: usize,
    ring_fixable: Option<&[bool]>,
) -> Result<Vec<Tri>, String> {
    let tol = 1e-9;
    let hv = field(vmm)?;
    let fixable_full: Option<Vec<bool>> = ring_fixable.filter(|_| n_ring > 0).map(|rf| {
        let mut f = vec![false; vmm.len()];
        f[..n_ring].copy_from_slice(&rf[..n_ring]);
        f
    });
    let err_of = |ts: &[Tri]| -> Result<Vec<f64>, String> {
        let mut pts = Vec::with_capacity(ts.len() * 7);
        for t in ts {
            for b in FLIP_BARY {
                pts.push([
                    b[0] * vmm[t[0]][0] + b[1] * vmm[t[1]][0] + b[2] * vmm[t[2]][0],
                    b[0] * vmm[t[0]][1] + b[1] * vmm[t[1]][1] + b[2] * vmm[t[2]][1],
                ]);
            }
        }
        let f = field(&pts)?;
        Ok(ts
            .iter()
            .enumerate()
            .map(|(k, t)| {
                let mut worst: f64 = 0.0;
                for (s, b) in FLIP_BARY.iter().enumerate() {
                    let interp = hv[t[0]] * b[0] + hv[t[1]] * b[1] + hv[t[2]] * b[2];
                    let e = (interp - f[k * 7 + s]).abs();
                    if e > worst || e.is_nan() {
                        worst = e;
                    }
                }
                worst
            })
            .collect())
    };
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };
    for _ in 0..8 {
        let mut scored = err_of(&tris)?;
        for (ti, t) in tris.iter().enumerate() {
            let excluded = t.iter().any(|&v| {
                v < n_ring && !fixable_full.as_ref().is_some_and(|f| f[v])
            });
            if excluded {
                scored[ti] = 0.0;
            }
        }
        let bad: Vec<usize> = (0..tris.len()).filter(|&i| scored[i] > tol).collect();
        if bad.is_empty() {
            break;
        }
        let edges = edge_map(&tris);
        let mut settled = vec![false; tris.len()];
        let mut flipped = false;
        for ti in bad {
            if settled[ti] {
                continue;
            }
            let [a, b, c] = tris[ti];
            for (i, j, opp) in [(a, b, c), (b, c, a), (c, a, b)] {
                let share = edges.get(&key(i, j)).map(Vec::as_slice).unwrap_or(&[]);
                if share.len() != 2 {
                    continue;
                }
                let tj = if share[1] == ti { share[0] } else { share[1] };
                if settled[tj] {
                    continue;
                }
                let rest: Vec<usize> = tris[tj].iter().copied().filter(|&v| v != i && v != j).collect();
                if rest.len() != 1 || !segments_cross(vmm, i, j, opp, rest[0]) {
                    continue;
                }
                let cand = [[opp, rest[0], i], [rest[0], opp, j]];
                let now = err_of(&[tris[ti], tris[tj]])?;
                let then = err_of(&cand)?;
                if then[0] + then[1] < (now[0] + now[1]) - 1e-15 {
                    tris[ti] = cand[0];
                    tris[tj] = cand[1];
                    settled[ti] = true;
                    settled[tj] = true;
                    flipped = true;
                    break;
                }
            }
        }
        if !flipped {
            break;
        }
    }
    Ok(tris)
}

fn delaunay(pts: &[P2]) -> Vec<Tri> {
    let p: Vec<delaunator::Point> = pts.iter().map(|q| delaunator::Point { x: q[0], y: q[1] }).collect();
    let t = delaunator::triangulate(&p);
    t.triangles.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

pub struct Refined {
    pub pts: Vec<V>,
    pub uv: Vec<P2>,
    pub tris: Vec<Tri>,
}

pub struct LatticeArgs<'a> {
    pub base_pts: &'a [V],
    pub base_uv: &'a [P2],
    pub base_tris: &'a [Tri],
    pub u_mm: &'a [f64],
    pub v_mm: &'a [f64],
    pub angle_deg: f64,
    pub target_edge_mm: f64,
    pub max_tris: usize,
    pub pattern_period: f64,
    pub phases: Option<(Option<Vec<f64>>, Option<Vec<f64>>)>,
    pub offset: f64,
    pub field: Option<&'a dyn Fn(&[P2]) -> Result<Vec<f64>, String>>,
    pub surf: &'a Surf<'a>,
    pub u_period: f64,
    pub cell_points: Option<Vec<P2>>,
    pub wrap_u: Option<f64>,
}

/// `_aligned_grid_triangulation`: a planar, cylindrical or conical face
/// re-triangulated in its mm chart on a grid rotated to the pattern, or on the
/// pattern's own crease lattice. An error means the caller falls back to
/// `refine_face_triangulation`.
pub fn aligned_grid_triangulation(a: &LatticeArgs) -> Result<Refined, String> {
    let ec = edge_count(a.base_tris);
    let boundary = ec.boundary();
    if boundary.len() < 3 {
        return Err("degenerate boundary".into());
    }
    let p_mm: Vec<P2> = a.u_mm.iter().zip(a.v_mm).map(|(&u, &v)| [u, v]).collect();
    let ring_a: Vec<P2> = boundary.iter().map(|e| p_mm[e.0]).collect();
    let ring_b: Vec<P2> = boundary.iter().map(|e| p_mm[e.1]).collect();

    let areas: Vec<f64> = a
        .base_tris
        .iter()
        .map(|t| {
            let e1 = [p_mm[t[1]][0] - p_mm[t[0]][0], p_mm[t[1]][1] - p_mm[t[0]][1]];
            let e2 = [p_mm[t[2]][0] - p_mm[t[0]][0], p_mm[t[2]][1] - p_mm[t[0]][1]];
            (e1[0] * e2[1] - e1[1] * e2[0]).abs()
        })
        .collect();
    let area = crate::height::pairwise_sum(&areas) * 0.5;
    let mut spacing = a.target_edge_mm.max((2.2 * area / a.max_tris.max(100) as f64).sqrt());
    let period = a.pattern_period;
    if period > 0.0 && spacing <= period * 0.5 {
        spacing = period / ((period / spacing).round_ties_even()).max(2.0);
    }

    let ang = a.angle_deg.to_radians();
    let (ca, sa) = (ang.cos(), ang.sin());
    let rp_u: Vec<f64> = p_mm.iter().map(|p| (p[0] + a.offset) * ca - p[1] * sa).collect();
    let rp_v: Vec<f64> = p_mm.iter().map(|p| (p[0] + a.offset) * sa + p[1] * ca).collect();

    let mut bnd_ids: Vec<usize> = boundary.iter().flat_map(|e| [e.0, e.1]).collect();
    bnd_ids.sort_unstable();
    bnd_ids.dedup();
    let mut ring_mm: Vec<P2> = bnd_ids.iter().map(|&i| p_mm[i]).collect();
    let mut ring_uv: Vec<P2> = bnd_ids.iter().map(|&i| a.base_uv[i]).collect();
    let mut ring_xyz: Vec<V> = bnd_ids.iter().map(|&i| a.base_pts[i]).collect();
    let cells_mode = a.cell_points.as_ref().is_some_and(|c| c.len() >= 4);
    let lattice = (a.phases.is_some() || cells_mode) && period > 0.0;
    let mut seam_vs: Option<Vec<f64>> = None;
    if let (true, Some(turn)) = (cells_mode, a.wrap_u) {
        let cp = a.cell_points.as_ref().expect("cells mode has points");
        let on: Vec<f64> = cp
            .iter()
            .filter(|p| p[0].abs() < 1e-9 || (p[0] - turn).abs() < 1e-9)
            .map(|p| p[1])
            .collect();
        if !on.is_empty() {
            seam_vs = Some(np::unique(on));
        }
    }
    let wrap = a.wrap_u.unwrap_or(f64::NAN);
    for &(i0, i1) in &boundary {
        let (u0p, u1p) = (p_mm[i0][0], p_mm[i1][0]);
        let seam_seg = seam_vs.is_some()
            && ((u0p.abs() < 1e-6 && u1p.abs() < 1e-6) || ((u0p - wrap).abs() < 1e-6 && (u1p - wrap).abs() < 1e-6));
        let mut ts: Vec<f64> = Vec::new();
        if seam_seg {
            let (va, vb) = (p_mm[i0][1], p_mm[i1][1]);
            let (lo_s, hi_s) = if va <= vb { (va, vb) } else { (vb, va) };
            for &v in seam_vs.as_ref().expect("seam values") {
                if v > lo_s + 1e-9 && v < hi_s - 1e-9 {
                    ts.push((v - va) / (vb - va));
                }
            }
        } else {
            let seg_len = (p_mm[i1][0] - p_mm[i0][0]).hypot(p_mm[i1][1] - p_mm[i0][1]);
            let n_sub = (seg_len / spacing).ceil() as i64;
            if n_sub >= 2 {
                for k in 1..n_sub {
                    ts.push(k as f64 / n_sub as f64);
                }
            }
            if let (true, Some((pu, pv))) = (lattice, a.phases.as_ref()) {
                ts.extend(segment_crossings(rp_u[i0], rp_u[i1], pu.as_deref(), period));
                ts.extend(segment_crossings(rp_v[i0], rp_v[i1], pv.as_deref(), period));
            }
        }
        if ts.is_empty() {
            continue;
        }
        let t: Vec<f64> = np::unique(ts.into_iter().map(|x| np::round(x, 12)).collect())
            .into_iter()
            .filter(|&x| x > 1e-12 && x < 1.0 - 1e-12)
            .collect();
        for &x in &t {
            ring_mm.push([
                p_mm[i0][0] + (p_mm[i1][0] - p_mm[i0][0]) * x,
                p_mm[i0][1] + (p_mm[i1][1] - p_mm[i0][1]) * x,
            ]);
            let (ua, ub) = (a.base_uv[i0], a.base_uv[i1]);
            ring_uv.push([ua[0] + (ub[0] - ua[0]) * x, ua[1] + (ub[1] - ua[1]) * x]);
            let (xa, xb) = (a.base_pts[i0], a.base_pts[i1]);
            ring_xyz.push([
                xa[0] + (xb[0] - xa[0]) * x,
                xa[1] + (xb[1] - xa[1]) * x,
                xa[2] + (xb[2] - xa[2]) * x,
            ]);
        }
    }

    let (rlo_u, rhi_u) = np::min_max(rp_u.iter().copied());
    let (rlo_v, rhi_v) = np::min_max(rp_v.iter().copied());
    let (lo_u, hi_u) = (rlo_u - spacing, rhi_u + spacing);
    let (lo_v, hi_v) = (rlo_v - spacing, rhi_v + spacing);
    let budget = 4 * a.max_tris.max(100);
    let (g_all, gx, gy): (Vec<P2>, Vec<f64>, Vec<f64>) = if cells_mode {
        let g = a.cell_points.clone().expect("cells mode has points");
        if g.len() > budget {
            return Err("cell lattice overshoots budget".into());
        }
        (g, Vec::new(), Vec::new())
    } else {
        let (gx, gy) = match (lattice, a.phases.as_ref()) {
            (true, Some((pu, pv))) => (
                axis_lines(pu.as_deref(), period, lo_u, hi_u),
                axis_lines(pv.as_deref(), period, lo_v, hi_v),
            ),
            _ => (np::arange(lo_u, hi_u, spacing), np::arange(lo_v, hi_v, spacing)),
        };
        if gx.len() < 2 || gy.len() < 2 {
            return Err("too few sample lines".into());
        }
        if gx.len() * gy.len() > budget {
            return Err("grid overshoots budget".into());
        }
        let mut g = Vec::with_capacity(gx.len() * gy.len());
        for &gu in &gx {
            for &gv in &gy {
                g.push([gu * ca + gv * sa - a.offset, -gu * sa + gv * ca]);
            }
        }
        (g, gx, gy)
    };
    let (ni, nj) = (gx.len(), gy.len());
    let mut inside = points_in_polygon(&g_all, &ring_a, &ring_b);
    if let Some(turn) = a.wrap_u {
        let (v_lo, v_hi) = np::min_max(ring_mm.iter().map(|p| p[1]));
        for (k, g) in g_all.iter().enumerate() {
            let on_seam = g[0].abs() < 1e-6 || (g[0] - turn).abs() < 1e-6;
            if seam_vs.is_some() {
                inside[k] &= !on_seam;
            } else if cells_mode {
                inside[k] |= on_seam && g[1] > v_lo - 1e-9 && g[1] < v_hi + 1e-9;
            }
        }
    }
    let mut cull_ref: Vec<P2> = ring_mm.clone();
    if let (Some(_), Some(turn)) = (&seam_vs, a.wrap_u) {
        let off: Vec<P2> = ring_mm
            .iter()
            .copied()
            .filter(|p| !(p[0].abs() < 1e-6 || (p[0] - turn).abs() < 1e-6))
            .collect();
        if !off.is_empty() {
            cull_ref = off;
        }
    }
    let tree = Tree::new(cull_ref.iter().map(|p| vec![p[0], p[1]]).collect());
    let cull = if lattice { 0.15 } else { 0.6 };
    let keep_pt: Vec<bool> = g_all
        .iter()
        .zip(&inside)
        .map(|(g, &ins)| ins && tree.nearest(g) > cull * spacing)
        .collect();
    let n_ring = ring_mm.len();
    let mut kept = vec![false; ni * nj];
    let mut gidx = vec![usize::MAX; ni * nj];
    let mut grid_pts: Vec<P2> = Vec::new();
    if cells_mode {
        grid_pts = g_all.iter().zip(&keep_pt).filter(|(_, &k)| k).map(|(g, _)| *g).collect();
    } else {
        for i in 0..ni {
            for j in 0..nj {
                let k = i * nj + j;
                if keep_pt[k] {
                    kept[k] = true;
                    gidx[k] = n_ring + grid_pts.len();
                    grid_pts.push(g_all[k]);
                }
            }
        }
    }
    let mut vmm: Vec<P2> = ring_mm.clone();
    vmm.extend_from_slice(&grid_pts);
    if vmm.len() < 4 {
        return Err("too few vertices".into());
    }
    let kk = |i: usize, j: usize| kept[i * nj + j];
    let gi = |i: usize, j: usize| gidx[i * nj + j];

    let full_cells = |i: usize, j: usize| kk(i, j) && kk(i + 1, j) && kk(i + 1, j + 1) && kk(i, j + 1);
    let drop_outside = |t: Vec<Tri>, cells: bool| -> Vec<Tri> {
        let centroids: Vec<P2> = t
            .iter()
            .map(|tr| {
                let s0 = vmm[tr[0]][0] + vmm[tr[1]][0] + vmm[tr[2]][0];
                let s1 = vmm[tr[0]][1] + vmm[tr[1]][1] + vmm[tr[2]][1];
                [s0 / 3.0, s1 / 3.0]
            })
            .collect();
        let inpoly = points_in_polygon(&centroids, &ring_a, &ring_b);
        t.into_iter()
            .zip(centroids)
            .zip(inpoly)
            .filter(|((tr, c), inp)| {
                let f1 = [vmm[tr[1]][0] - vmm[tr[0]][0], vmm[tr[1]][1] - vmm[tr[0]][1]];
                let f2 = [vmm[tr[2]][0] - vmm[tr[0]][0], vmm[tr[2]][1] - vmm[tr[0]][1]];
                let mut ok = *inp && (f1[0] * f2[1] - f1[1] * f2[0]).abs() > spacing * spacing * 1e-4;
                if cells {
                    let pu = (c[0] + a.offset) * ca - c[1] * sa;
                    let pv = (c[0] + a.offset) * sa + c[1] * ca;
                    let pi = (np::searchsorted(&gx, pu) as i64 - 1).clamp(0, ni as i64 - 2) as usize;
                    let pj = (np::searchsorted(&gy, pv) as i64 - 1).clamp(0, nj as i64 - 2) as usize;
                    ok &= !full_cells(pi, pj);
                }
                ok
            })
            .map(|((tr, _), _)| tr)
            .collect()
    };

    let mut tris: Vec<Tri>;
    if lattice {
        tris = drop_outside(delaunay(&vmm), false);
        if let (false, Some((_, Some(_)))) = (cells_mode, a.phases.as_ref()) {
            let field = a.field.ok_or("a lattice needs its field")?;
            let mut quads: Vec<[usize; 4]> = Vec::new();
            for i in 0..ni.saturating_sub(1) {
                for j in 0..nj.saturating_sub(1) {
                    if full_cells(i, j) {
                        quads.push([gi(i, j), gi(i + 1, j), gi(i + 1, j + 1), gi(i, j + 1)]);
                    }
                }
            }
            if !quads.is_empty() {
                let corners: Vec<P2> = quads.iter().flat_map(|q| q.iter().map(|&k| vmm[k])).collect();
                let h = field(&corners)?;
                let centres: Vec<P2> = quads
                    .iter()
                    .map(|q| {
                        let s0 = ((vmm[q[0]][0] + vmm[q[1]][0]) + vmm[q[2]][0]) + vmm[q[3]][0];
                        let s1 = ((vmm[q[0]][1] + vmm[q[1]][1]) + vmm[q[2]][1]) + vmm[q[3]][1];
                        [s0 / 4.0, s1 / 4.0]
                    })
                    .collect();
                let centre = field(&centres)?;
                let want_main: Vec<bool> = (0..quads.len())
                    .map(|k| {
                        let hh = &h[k * 4..k * 4 + 4];
                        ((hh[0] + hh[2]) * 0.5 - centre[k]).abs() <= ((hh[1] + hh[3]) * 0.5 - centre[k]).abs()
                    })
                    .collect();
                tris = force_cell_diagonals(tris, &quads, &want_main);
            }
        }
        let field = a.field.ok_or("a lattice needs its field")?;
        let fixable: Option<Vec<bool>> = a
            .wrap_u
            .map(|turn| ring_mm.iter().map(|p| p[0].abs() < 1e-6 || (p[0] - turn).abs() < 1e-6).collect());
        tris = flip_to_creases(tris, &vmm, field, n_ring, fixable.as_deref())?;
    } else {
        let mut interior: Vec<Tri> = Vec::new();
        let mut first: Vec<Tri> = Vec::new();
        let mut second: Vec<Tri> = Vec::new();
        for i in 0..ni - 1 {
            for j in 0..nj - 1 {
                if full_cells(i, j) {
                    let (a_, b_, c_, d_) = (gi(i, j), gi(i + 1, j), gi(i + 1, j + 1), gi(i, j + 1));
                    first.push([a_, b_, c_]);
                    second.push([a_, c_, d_]);
                }
            }
        }
        interior.extend(first);
        interior.extend(second);
        let mut surrounded = vec![false; ni * nj];
        if ni >= 3 && nj >= 3 {
            for i in 1..ni - 1 {
                for j in 1..nj - 1 {
                    surrounded[i * nj + j] =
                        full_cells(i - 1, j - 1) && full_cells(i, j - 1) && full_cells(i, j) && full_cells(i - 1, j);
                }
            }
        }
        let mut band_ids: Vec<usize> = (0..n_ring).collect();
        for i in 0..ni {
            for j in 0..nj {
                if kk(i, j) && !surrounded[i * nj + j] {
                    band_ids.push(gi(i, j));
                }
            }
        }
        let band_pts: Vec<P2> = band_ids.iter().map(|&k| vmm[k]).collect();
        let band: Vec<Tri> = delaunay(&band_pts)
            .into_iter()
            .map(|t| [band_ids[t[0]], band_ids[t[1]], band_ids[t[2]]])
            .collect();
        tris = interior;
        tris.extend(drop_outside(band, true));
    }
    if tris.is_empty() {
        return Err("empty after filtering".into());
    }

    let (grid_uv, grid_xyz): (Vec<P2>, Vec<V>) = match chart::uncharter(a.surf, a.u_period) {
        None => {
            let m: Vec<[f64; 3]> = p_mm.iter().map(|p| [p[0], p[1], 1.0]).collect();
            let ys = vec![
                a.base_uv.iter().map(|q| q[0]).collect::<Vec<_>>(),
                a.base_uv.iter().map(|q| q[1]).collect(),
                a.base_pts.iter().map(|q| q[0]).collect(),
                a.base_pts.iter().map(|q| q[1]).collect(),
                a.base_pts.iter().map(|q| q[2]).collect(),
            ];
            let coef = np::lstsq3(&m, &ys).ok_or("non-affine chart (not a plane?)")?;
            let fit = |c: &[f64; 3], p: &P2| c[0] * p[0] + c[1] * p[1] + c[2];
            let mut fit_err: f64 = 0.0;
            for (p, q) in p_mm.iter().zip(a.base_pts) {
                for k in 0..3 {
                    fit_err = fit_err.max((fit(&coef[2 + k], p) - q[k]).abs());
                }
            }
            if fit_err > 1e-4f64.max(spacing * 1e-3) {
                return Err("non-affine chart (not a plane?)".into());
            }
            (
                grid_pts.iter().map(|g| [fit(&coef[0], g), fit(&coef[1], g)]).collect(),
                grid_pts
                    .iter()
                    .map(|g| [fit(&coef[2], g), fit(&coef[3], g), fit(&coef[4], g)])
                    .collect(),
            )
        }
        Some(unchart) => unchart(&grid_pts),
    };
    let mut uv_out = ring_uv;
    uv_out.extend(grid_uv);
    let mut pts_out = ring_xyz;
    pts_out.extend(grid_xyz);

    let t0 = a.base_tris[0];
    let n_ref = v3::cross(
        v3::sub(a.base_pts[t0[1]], a.base_pts[t0[0]]),
        v3::sub(a.base_pts[t0[2]], a.base_pts[t0[0]]),
    );
    for t in tris.iter_mut() {
        let n_new = v3::cross(v3::sub(pts_out[t[1]], pts_out[t[0]]), v3::sub(pts_out[t[2]], pts_out[t[0]]));
        if v3::dot(n_new, n_ref) < 0.0 {
            *t = [t[0], t[2], t[1]];
        }
    }
    Ok(Refined {
        pts: pts_out,
        uv: uv_out,
        tris,
    })
}

fn dist3(a: V, b: V) -> f64 {
    let (dx, dy, dz) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    (dx * dx + dy * dy + dz * dz).sqrt()
}

/// `_refine_face_triangulation`: uniform 1-to-4 subdivision, new interior
/// vertices on the true surface, new boundary vertices on the chord.
pub fn refine_face_triangulation(
    s: &Surf,
    pts: &[V],
    uv: &[P2],
    tris: &[Tri],
    target_edge_mm: f64,
    max_tris: usize,
) -> Refined {
    let mut pts = pts.to_vec();
    let mut uv = uv.to_vec();
    let mut tris = tris.to_vec();
    loop {
        if tris.len() * 4 > max_tris {
            break;
        }
        let mut max_edge: f64 = 0.0;
        for t in &tris {
            max_edge = max_edge
                .max(dist3(pts[t[0]], pts[t[1]]))
                .max(dist3(pts[t[1]], pts[t[2]]))
                .max(dist3(pts[t[2]], pts[t[0]]));
        }
        if max_edge <= target_edge_mm {
            break;
        }
        let ec = edge_count(&tris);
        let key = |i: usize, j: usize| if i < j { (i, j) } else { (j, i) };
        let mut mid: HashMap<(usize, usize), usize> = HashMap::new();
        let mut pending: Vec<(usize, P2)> = Vec::new();
        let mut new_tris = Vec::with_capacity(tris.len() * 4);
        for t in &tris {
            let mut m = [0usize; 3];
            for (slot, (i, j)) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])].into_iter().enumerate() {
                let k = key(i, j);
                if let Some(&hit) = mid.get(&k) {
                    m[slot] = hit;
                    continue;
                }
                let um = (uv[i][0] + uv[j][0]) * 0.5;
                let vm = (uv[i][1] + uv[j][1]) * 0.5;
                let idx = pts.len();
                if ec.count[&k] == 1 {
                    pts.push([
                        (pts[i][0] + pts[j][0]) * 0.5,
                        (pts[i][1] + pts[j][1]) * 0.5,
                        (pts[i][2] + pts[j][2]) * 0.5,
                    ]);
                } else {
                    pts.push([0.0; 3]);
                    pending.push((idx, [um, vm]));
                }
                uv.push([um, vm]);
                mid.insert(k, idx);
                m[slot] = idx;
            }
            let (ab, bc, ca) = (m[0], m[1], m[2]);
            new_tris.push([t[0], ab, ca]);
            new_tris.push([ab, t[1], bc]);
            new_tris.push([ca, bc, t[2]]);
            new_tris.push([ab, bc, ca]);
        }
        let at: Vec<P2> = pending.iter().map(|p| p.1).collect();
        for ((idx, _), smp) in pending.iter().zip(s.samples(&at)) {
            pts[*idx] = smp.point;
        }
        tris = new_tris;
    }
    Refined { pts, uv, tris }
}

fn smoothstep(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// `_boundary_taper`: 0 on the face boundary, smoothstepping to 1 over
/// `inset_mm`, with the edge counts for the manifold check.
pub fn boundary_taper(pts: &[V], tris: &[Tri], inset_mm: f64, exempt: Option<&[bool]>) -> (Vec<f64>, EdgeCount) {
    let ec = edge_count(tris);
    let mut boundary = ec.boundary();
    if let Some(ex) = exempt {
        boundary.retain(|k| !(ex[k.0] && ex[k.1]));
    }
    if boundary.is_empty() {
        return (vec![1.0; pts.len()], ec);
    }
    let mut ends: Vec<usize> = boundary.iter().flat_map(|k| [k.0, k.1]).collect();
    ends.sort_unstable();
    ends.dedup();
    let tree = Tree::new(ends.iter().map(|&i| pts[i].to_vec()).collect());
    let d: Vec<f64> = pts.iter().map(|p| tree.nearest(p)).collect();
    if inset_mm <= 1e-9 {
        return (d.iter().map(|&x| if x > 1e-9 { 1.0 } else { 0.0 }).collect(), ec);
    }
    (d.iter().map(|&x| smoothstep((x / inset_mm).clamp(0.0, 1.0))).collect(), ec)
}
