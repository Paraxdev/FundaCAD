//! Turns filled 2D outlines (lines, circular arcs, quadratic and cubic Beziers)
//! into the boundary of the area they fill: ends joined, small gaps closed,
//! crossings split, duplicates and everything inside the area dropped. The
//! result never crosses itself, so the sketch's even-odd fill reproduces it.

use std::collections::{HashMap, HashSet};
use std::f64::consts::{PI, TAU};

pub type P = [f64; 2];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Line(P, P),
    /// Angle `a0 + sweep * t` about `c`.
    Arc { c: P, r: f64, a0: f64, sweep: f64 },
    Quad(P, P, P),
    Cubic(P, P, P, P),
}

fn lerp(a: P, b: P, t: f64) -> P {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn dist(a: P, b: P) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn split_bez(pts: &[P], t: f64) -> (Vec<P>, Vec<P>) {
    let mut left = vec![pts[0]];
    let mut right = vec![pts[pts.len() - 1]];
    let mut cur = pts.to_vec();
    while cur.len() > 1 {
        cur = cur.windows(2).map(|w| lerp(w[0], w[1], t)).collect();
        left.push(cur[0]);
        right.push(cur[cur.len() - 1]);
    }
    right.reverse();
    (left, right)
}

fn quadratic_roots(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a.abs() < 1e-14 {
        return if b.abs() < 1e-14 { vec![] } else { vec![-c / b] };
    }
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return vec![];
    }
    let s = disc.sqrt();
    vec![(-b - s) / (2.0 * a), (-b + s) / (2.0 * a)]
}

/// The arc from `a` through `m` to `e`, turning the way `sweep` does.
fn arc_through(a: P, m: P, e: P, sweep: f64) -> Option<Seg> {
    let d = 2.0 * (a[0] * (m[1] - e[1]) + m[0] * (e[1] - a[1]) + e[0] * (a[1] - m[1]));
    let span = dist(a, m).max(dist(m, e)).max(dist(a, e));
    if d.abs() <= 1e-12 * span * span {
        return None;
    }
    let (a2, m2, e2) = (a[0] * a[0] + a[1] * a[1], m[0] * m[0] + m[1] * m[1], e[0] * e[0] + e[1] * e[1]);
    let c = [
        (a2 * (m[1] - e[1]) + m2 * (e[1] - a[1]) + e2 * (a[1] - m[1])) / d,
        (a2 * (e[0] - m[0]) + m2 * (a[0] - e[0]) + e2 * (m[0] - a[0])) / d,
    ];
    let a0 = (a[1] - c[1]).atan2(a[0] - c[0]);
    let turn = ((e[1] - c[1]).atan2(e[0] - c[0]) - a0).rem_euclid(TAU);
    let sweep = if sweep > 0.0 { turn } else { turn - TAU };
    Some(Seg::Arc { c, r: dist(a, c), a0, sweep })
}

impl Seg {
    pub fn at(&self, t: f64) -> P {
        match *self {
            Seg::Line(a, b) => lerp(a, b, t),
            Seg::Arc { c, r, a0, sweep } => {
                let th = a0 + sweep * t;
                [c[0] + r * th.cos(), c[1] + r * th.sin()]
            }
            Seg::Quad(a, b, c) => {
                let u = 1.0 - t;
                [u * u * a[0] + 2.0 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2.0 * u * t * b[1] + t * t * c[1]]
            }
            Seg::Cubic(a, b, c, d) => {
                let u = 1.0 - t;
                let (k0, k1, k2, k3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]]
            }
        }
    }

    pub fn deriv(&self, t: f64) -> P {
        match *self {
            Seg::Line(a, b) => [b[0] - a[0], b[1] - a[1]],
            Seg::Arc { r, a0, sweep, .. } => {
                let th = a0 + sweep * t;
                [-r * sweep * th.sin(), r * sweep * th.cos()]
            }
            Seg::Quad(a, b, c) => {
                let u = 1.0 - t;
                [2.0 * (u * (b[0] - a[0]) + t * (c[0] - b[0])), 2.0 * (u * (b[1] - a[1]) + t * (c[1] - b[1]))]
            }
            Seg::Cubic(a, b, c, d) => {
                let u = 1.0 - t;
                let f = |k: usize| 3.0 * (u * u * (b[k] - a[k]) + 2.0 * u * t * (c[k] - b[k]) + t * t * (d[k] - c[k]));
                [f(0), f(1)]
            }
        }
    }

    pub fn start(&self) -> P {
        self.at(0.0)
    }

    pub fn end(&self) -> P {
        self.at(1.0)
    }

    fn ctrl(&self) -> Vec<P> {
        match *self {
            Seg::Line(a, b) => vec![a, b],
            Seg::Quad(a, b, c) => vec![a, b, c],
            Seg::Cubic(a, b, c, d) => vec![a, b, c, d],
            Seg::Arc { .. } => vec![],
        }
    }

    fn from_ctrl(p: &[P]) -> Seg {
        match p.len() {
            2 => Seg::Line(p[0], p[1]),
            3 => Seg::Quad(p[0], p[1], p[2]),
            _ => Seg::Cubic(p[0], p[1], p[2], p[3]),
        }
    }

    /// The exact piece between `t0` and `t1`.
    pub fn sub(&self, t0: f64, t1: f64) -> Seg {
        match *self {
            Seg::Arc { c, r, a0, sweep } => Seg::Arc { c, r, a0: a0 + sweep * t0, sweep: sweep * (t1 - t0) },
            _ => {
                let (_, right) = split_bez(&self.ctrl(), t0);
                let rel = if t0 < 1.0 { (t1 - t0) / (1.0 - t0) } else { 1.0 };
                let (left, _) = split_bez(&right, rel.clamp(0.0, 1.0));
                Seg::from_ctrl(&left)
            }
        }
    }

    /// Moves the two ends, keeping a curve's inner control points, or an
    /// arc's middle point.
    pub fn with_ends(&self, s: P, e: P) -> Seg {
        match *self {
            Seg::Line(..) => Seg::Line(s, e),
            Seg::Quad(_, b, _) => Seg::Quad(s, b, e),
            Seg::Cubic(_, b, c, _) => Seg::Cubic(s, b, c, e),
            Seg::Arc { c, r, sweep, .. } if dist(s, e) <= 1e-3 * r => {
                if s == e {
                    Seg::Arc { c, r, a0: (s[1] - c[1]).atan2(s[0] - c[0]), sweep: TAU.copysign(sweep) }
                } else {
                    *self
                }
            }
            Seg::Arc { sweep, .. } => arc_through(s, self.at(0.5), e, sweep).unwrap_or(Seg::Line(s, e)),
        }
    }

    /// Box of the curve, padded by nothing, from the control hull or the circle.
    pub fn hull(&self) -> [f64; 4] {
        let pts = match *self {
            Seg::Arc { c, r, .. } => vec![[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]],
            _ => self.ctrl(),
        };
        pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])])
    }

    fn y_extrema(&self) -> Vec<f64> {
        let mut ts = match *self {
            Seg::Line(..) => vec![],
            Seg::Arc { a0, sweep, .. } => {
                let (lo, hi) = if sweep > 0.0 { (a0, a0 + sweep) } else { (a0 + sweep, a0) };
                let mut out = Vec::new();
                let mut k = ((lo - PI / 2.0) / PI).ceil();
                while PI / 2.0 + k * PI < hi {
                    out.push((PI / 2.0 + k * PI - a0) / sweep);
                    k += 1.0;
                }
                out
            }
            Seg::Quad(a, b, c) => {
                let den = a[1] - 2.0 * b[1] + c[1];
                if den.abs() < 1e-14 {
                    vec![]
                } else {
                    vec![(a[1] - b[1]) / den]
                }
            }
            Seg::Cubic(a, b, c, d) => {
                quadratic_roots(-a[1] + 3.0 * b[1] - 3.0 * c[1] + d[1], 2.0 * (a[1] - 2.0 * b[1] + c[1]), b[1] - a[1])
            }
        };
        ts.retain(|t| *t > 1e-12 && *t < 1.0 - 1e-12);
        ts.sort_by(f64::total_cmp);
        ts
    }

    pub fn samples(&self) -> usize {
        match *self {
            Seg::Line(..) => 1,
            Seg::Arc { sweep, .. } => ((sweep.abs() / (PI / 16.0)).ceil() as usize).clamp(2, 64),
            _ => 24,
        }
    }

    pub fn length(&self) -> f64 {
        let n = self.samples().max(8);
        (0..n).map(|i| dist(self.at(i as f64 / n as f64), self.at((i + 1) as f64 / n as f64))).sum()
    }

    /// Signed crossings of the ray from `p` towards +x, upward counted +1.
    fn crossings(&self, p: P) -> i32 {
        let h = self.hull();
        if p[1] < h[1] || p[1] > h[3] || p[0] > h[2] {
            return 0;
        }
        let mut ts = vec![0.0];
        ts.extend(self.y_extrema());
        ts.push(1.0);
        let mut w = 0;
        for k in ts.windows(2) {
            let (ta, tb) = (k[0], k[1]);
            let (ya, yb) = (self.at(ta)[1], self.at(tb)[1]);
            let dir = if ya <= p[1] && p[1] < yb {
                1
            } else if yb <= p[1] && p[1] < ya {
                -1
            } else {
                continue;
            };
            let (mut lo, mut hi) = (ta, tb);
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if (self.at(mid)[1] < p[1]) == (dir == 1) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            if self.at(0.5 * (lo + hi))[0] > p[0] {
                w += dir;
            }
        }
        w
    }
}

#[derive(Clone, Debug, Default)]
pub struct Sub {
    pub segs: Vec<Seg>,
    pub closed: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Filled {
    pub subs: Vec<Sub>,
    pub evenodd: bool,
}

impl Filled {
    fn fills(&self, bbox: &[f64; 4], p: P) -> bool {
        if p[0] < bbox[0] || p[0] > bbox[2] || p[1] < bbox[1] || p[1] > bbox[3] {
            return false;
        }
        let w: i32 = self.subs.iter().flat_map(|s| &s.segs).map(|s| s.crossings(p)).sum();
        if self.evenodd {
            w % 2 != 0
        } else {
            w != 0
        }
    }
}

#[derive(Debug, Default)]
pub struct Healed {
    pub segs: Vec<Seg>,
    pub gaps_closed: usize,
    pub lines_added: usize,
    pub crossings_split: usize,
    pub dropped: usize,
    pub open_ends: usize,
}

pub struct Tol {
    pub join: f64,
    pub gap: f64,
}

pub fn tolerances(diagonal: f64) -> Tol {
    let d = diagonal.max(1e-6);
    Tol { join: crate::kernel::sketch_fuzz(Some(d)).max(1e-5 * d), gap: 1e-3 * d }
}

fn degenerate(s: &Seg, tol: f64) -> bool {
    match s {
        Seg::Arc { r, sweep, .. } => r * sweep.abs() < tol,
        other => {
            let c = other.ctrl();
            c.iter().all(|p| dist(*p, c[0]) < tol)
        }
    }
}

/// Drops zero length pieces and closes a subpath: a gap within `gap` by
/// moving the last end, a wider one with a line when `fill` asks for it.
/// Returns (snapped a real gap, added a line).
pub fn close_sub(sub: &mut Sub, tol: &Tol, fill: bool) -> (bool, bool) {
    sub.segs.retain(|s| !degenerate(s, tol.join));
    let (Some(first), Some(last)) = (sub.segs.first().copied(), sub.segs.last().copied()) else {
        return (false, false);
    };
    let (s, e) = (first.start(), last.end());
    let g = dist(s, e);
    let mut out = (false, false);
    if g <= tol.gap {
        let n = sub.segs.len() - 1;
        if !matches!(last, Seg::Arc { .. }) {
            sub.segs[n] = last.with_ends(last.start(), s);
        } else if !matches!(first, Seg::Arc { .. }) {
            sub.segs[0] = first.with_ends(e, first.end());
        } else if g > tol.join {
            sub.segs.push(Seg::Line(e, s));
        } else {
            sub.segs[n] = last.with_ends(last.start(), s);
        }
        out.0 = g > tol.join && !sub.closed;
    } else if fill || sub.closed {
        sub.segs.push(Seg::Line(e, s));
        out.1 = !sub.closed;
    } else {
        return out;
    }
    sub.closed = true;
    out
}

struct Welder {
    tol: f64,
    cells: HashMap<(i64, i64), Vec<usize>>,
    reps: Vec<P>,
}

impl Welder {
    fn new(tol: f64) -> Self {
        Welder { tol, cells: HashMap::new(), reps: Vec::new() }
    }

    #[allow(clippy::cast_possible_truncation)]
    fn snap(&mut self, p: P) -> (P, usize) {
        let (cx, cy) = ((p[0] / self.tol).floor() as i64, (p[1] / self.tol).floor() as i64);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for &i in self.cells.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    if dist(self.reps[i], p) <= self.tol {
                        return (self.reps[i], i);
                    }
                }
            }
        }
        self.reps.push(p);
        self.cells.entry((cx, cy)).or_default().push(self.reps.len() - 1);
        (p, self.reps.len() - 1)
    }
}

fn overlap(a: &[f64; 4], b: &[f64; 4], pad: f64) -> bool {
    a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3]
}

fn newton_cross(a: &Seg, b: &Seg, mut s: f64, mut t: f64) -> Option<(f64, f64)> {
    for _ in 0..30 {
        let (pa, pb) = (a.at(s), b.at(t));
        let f = [pa[0] - pb[0], pa[1] - pb[1]];
        let (da, db) = (a.deriv(s), b.deriv(t));
        let det = da[0] * -db[1] - -db[0] * da[1];
        if det.abs() < 1e-18 {
            return None;
        }
        let ds = (f[0] * -db[1] - -db[0] * f[1]) / det;
        let dt = (da[0] * f[1] - da[1] * f[0]) / det;
        s = (s - ds).clamp(0.0, 1.0);
        t = (t - dt).clamp(0.0, 1.0);
        if ds.abs() < 1e-15 && dt.abs() < 1e-15 {
            break;
        }
    }
    Some((s, t))
}

fn closest_param(s: &Seg, p: P) -> f64 {
    let n = s.samples() * 4;
    let mut best = (f64::MAX, 0.0);
    for i in 0..=n {
        let t = i as f64 / n as f64;
        let d = dist(s.at(t), p);
        if d < best.0 {
            best = (d, t);
        }
    }
    let mut t = best.1;
    for _ in 0..20 {
        let (q, d) = (s.at(t), s.deriv(t));
        let dd = d[0] * d[0] + d[1] * d[1];
        if dd < 1e-24 {
            break;
        }
        t = (t - ((q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1]) / dd).clamp(0.0, 1.0);
    }
    t
}

fn polyline(s: &Seg) -> Vec<(f64, P)> {
    let n = s.samples();
    (0..=n).map(|i| {
        let t = i as f64 / n as f64;
        (t, s.at(t))
    }).collect()
}

/// Parameters where `a` and `b` cross or touch, from their polylines refined
/// on the curves.
fn cross_params(a: &Seg, b: &Seg, pa: &[(f64, P)], pb: &[(f64, P)], tol: f64) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for wa in pa.windows(2) {
        let ba = [wa[0].1[0].min(wa[1].1[0]), wa[0].1[1].min(wa[1].1[1]), wa[0].1[0].max(wa[1].1[0]), wa[0].1[1].max(wa[1].1[1])];
        for wb in pb.windows(2) {
            let bb = [wb[0].1[0].min(wb[1].1[0]), wb[0].1[1].min(wb[1].1[1]), wb[0].1[0].max(wb[1].1[0]), wb[0].1[1].max(wb[1].1[1])];
            if !overlap(&ba, &bb, tol) {
                continue;
            }
            let (p, r) = (wa[0].1, [wa[1].1[0] - wa[0].1[0], wa[1].1[1] - wa[0].1[1]]);
            let (q, sv) = (wb[0].1, [wb[1].1[0] - wb[0].1[0], wb[1].1[1] - wb[0].1[1]]);
            let den = r[0] * sv[1] - r[1] * sv[0];
            if den.abs() < 1e-30 {
                continue;
            }
            let qp = [q[0] - p[0], q[1] - p[1]];
            let u = (qp[0] * sv[1] - qp[1] * sv[0]) / den;
            let v = (qp[0] * r[1] - qp[1] * r[0]) / den;
            if !(-0.05..=1.05).contains(&u) || !(-0.05..=1.05).contains(&v) {
                continue;
            }
            let s0 = wa[0].0 + u.clamp(0.0, 1.0) * (wa[1].0 - wa[0].0);
            let t0 = wb[0].0 + v.clamp(0.0, 1.0) * (wb[1].0 - wb[0].0);
            let (s, t) = newton_cross(a, b, s0, t0).unwrap_or((s0, t0));
            if dist(a.at(s), b.at(t)) <= tol {
                out.push((s, t));
            }
        }
    }
    out
}

/// The boundary of the union of `shapes`.
pub fn heal(shapes: &mut [Filled], tol: &Tol) -> Healed {
    let mut out = Healed::default();
    for shape in shapes.iter_mut() {
        for sub in &mut shape.subs {
            let (snapped, added) = close_sub(sub, tol, true);
            out.gaps_closed += usize::from(snapped);
            out.lines_added += usize::from(added);
        }
        shape.subs.retain(|s| !s.segs.is_empty());
    }
    let segs: Vec<Seg> = shapes.iter().flat_map(|s| s.subs.iter().flat_map(|u| u.segs.iter().copied())).collect();
    let hulls: Vec<[f64; 4]> = segs.iter().map(Seg::hull).collect();
    let lines: Vec<Vec<(f64, P)>> = segs.iter().map(polyline).collect();
    let mut cuts: Vec<Vec<f64>> = vec![Vec::new(); segs.len()];
    let interior = |s: &Seg, t: f64| dist(s.at(t), s.start()) > tol.join && dist(s.at(t), s.end()) > tol.join;
    for i in 0..segs.len() {
        for j in i + 1..segs.len() {
            if !overlap(&hulls[i], &hulls[j], tol.join) {
                continue;
            }
            for (s, t) in cross_params(&segs[i], &segs[j], &lines[i], &lines[j], tol.join) {
                let (ii, ij) = (interior(&segs[i], s), interior(&segs[j], t));
                if ii {
                    cuts[i].push(s);
                }
                if ij {
                    cuts[j].push(t);
                }
                if ii && ij {
                    out.crossings_split += 1;
                }
            }
            for (a, b) in [(i, j), (j, i)] {
                for end in [segs[a].start(), segs[a].end()] {
                    let t = closest_param(&segs[b], end);
                    if dist(segs[b].at(t), end) <= tol.join && interior(&segs[b], t) {
                        cuts[b].push(t);
                    }
                }
            }
        }
    }
    let mut pieces = Vec::new();
    for (k, s) in segs.iter().enumerate() {
        let c = &mut cuts[k];
        c.sort_by(f64::total_cmp);
        let mut ts = vec![0.0];
        for &t in c.iter() {
            if dist(s.at(t), s.at(*ts.last().unwrap())) > tol.join {
                ts.push(t);
            }
        }
        if dist(s.end(), s.at(*ts.last().unwrap())) <= tol.join && ts.len() > 1 {
            ts.pop();
        }
        ts.push(1.0);
        for w in ts.windows(2) {
            pieces.push(s.sub(w[0], w[1]));
        }
    }
    let boxes: Vec<[f64; 4]> = shapes
        .iter()
        .map(|s| {
            s.subs.iter().flat_map(|u| &u.segs).map(Seg::hull).fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, h| {
                [b[0].min(h[0]), b[1].min(h[1]), b[2].max(h[2]), b[3].max(h[3])]
            })
        })
        .collect();
    let filled = |p: P| shapes.iter().zip(&boxes).any(|(s, b)| s.fills(b, p));
    let mut ends = Welder::new(tol.join);
    let mut mids = Welder::new(tol.join * 4.0);
    let mut seen = HashSet::new();
    let mut uses: HashMap<usize, usize> = HashMap::new();
    for piece in pieces {
        let (s, is) = ends.snap(piece.start());
        let (e, ie) = ends.snap(piece.end());
        let len = piece.length();
        if is == ie && len < 4.0 * tol.join {
            out.dropped += 1;
            continue;
        }
        let m = piece.at(0.5);
        let d = piece.deriv(0.5);
        let dl = d[0].hypot(d[1]);
        if dl < 1e-300 {
            out.dropped += 1;
            continue;
        }
        let n = [-d[1] / dl, d[0] / dl];
        let eps = (10.0 * tol.join).min(len / 4.0);
        let left = filled([m[0] + eps * n[0], m[1] + eps * n[1]]);
        let right = filled([m[0] - eps * n[0], m[1] - eps * n[1]]);
        if left == right {
            out.dropped += 1;
            continue;
        }
        let (_, im) = mids.snap(m);
        if !seen.insert((is.min(ie), is.max(ie), im)) {
            out.dropped += 1;
            continue;
        }
        if is != ie {
            *uses.entry(is).or_default() += 1;
            *uses.entry(ie).or_default() += 1;
        }
        out.segs.push(piece.with_ends(s, e));
    }
    out.open_ends = uses.values().filter(|&&n| n % 2 == 1).count();
    out
}

/// An arc piece that closes on itself, split in two so a sketch arc can hold it.
pub fn arc_halves(s: &Seg) -> Vec<Seg> {
    match *s {
        Seg::Arc { sweep, .. } if sweep.abs() >= TAU - 1e-9 => vec![s.sub(0.0, 0.5), s.sub(0.5, 1.0)],
        _ => vec![*s],
    }
}
