//! The wall of a thin extrude: sketch curves chained end to end, offset to
//! each side in the sketch's own 2D, corners mitred, and the walls fused into
//! planar faces the extrude then pushes like any profile.

use std::f64::consts::TAU;

use fundacad_core::schema::Extrude;
use opencascade::primitives::Shape;

use crate::builder::{py_g, Ctx, FResult, Fail, SketchEntry};
use crate::kernel::{self, BoolKind, Kind};

/// One stretch of a sketch curve in the sketch's local XY.
#[derive(Debug, Clone, Copy)]
pub enum Piece {
    Seg { a: [f64; 2], b: [f64; 2] },
    Arc { a: [f64; 2], m: [f64; 2], b: [f64; 2] },
    Circle { c: [f64; 2], r: f64 },
}

/// A sketch curve a wall can follow. `pieces` is Err with the curve's kind
/// when a wall cannot follow it.
#[derive(Debug, Clone)]
pub struct Curve {
    pub id: Option<String>,
    pub construction: bool,
    pub pieces: Result<Vec<Piece>, &'static str>,
}

type P = [f64; 2];

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1]]
}
fn mul(a: P, s: f64) -> P {
    [a[0] * s, a[1] * s]
}
fn dot(a: P, b: P) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn cross(a: P, b: P) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn len(a: P) -> f64 {
    a[0].hypot(a[1])
}
fn unit(a: P) -> P {
    let l = len(a);
    if l > 0.0 { mul(a, 1.0 / l) } else { a }
}
fn left(t: P) -> P {
    [-t[1], t[0]]
}
fn ang(p: P, c: P) -> f64 {
    (p[1] - c[1]).atan2(p[0] - c[0])
}

/// A line or circular arc of a chain, or its offset.
#[derive(Debug, Clone, Copy)]
enum El {
    Line { a: P, b: P },
    Arc { a: P, b: P, c: P, r: f64, ccw: bool },
}

impl El {
    fn a(&self) -> P {
        match *self {
            El::Line { a, .. } | El::Arc { a, .. } => a,
        }
    }
    fn b(&self) -> P {
        match *self {
            El::Line { b, .. } | El::Arc { b, .. } => b,
        }
    }
    fn set_a(&mut self, p: P) {
        match self {
            El::Line { a, .. } | El::Arc { a, .. } => *a = p,
        }
    }
    fn set_b(&mut self, p: P) {
        match self {
            El::Line { b, .. } | El::Arc { b, .. } => *b = p,
        }
    }
    fn tangent_at(&self, p: P) -> P {
        match *self {
            El::Line { a, b } => unit(sub(b, a)),
            El::Arc { c, ccw, .. } => {
                let t = left(unit(sub(p, c)));
                if ccw { t } else { mul(t, -1.0) }
            }
        }
    }
    fn reversed(&self) -> El {
        match *self {
            El::Line { a, b } => El::Line { a: b, b: a },
            El::Arc { a, b, c, r, ccw } => El::Arc { a: b, b: a, c, r, ccw: !ccw },
        }
    }
    fn sweep(&self) -> f64 {
        match *self {
            El::Line { .. } => 0.0,
            El::Arc { a, b, c, ccw, .. } => {
                let d = if ccw { ang(b, c) - ang(a, c) } else { ang(a, c) - ang(b, c) };
                let s = d.rem_euclid(TAU);
                if s < 1e-12 { TAU } else { s }
            }
        }
    }
    fn mid(&self) -> P {
        match *self {
            El::Line { a, b } => mul(add(a, b), 0.5),
            El::Arc { a, c, r, ccw, .. } => {
                let s = self.sweep() / 2.0;
                let t = ang(a, c) + if ccw { s } else { -s };
                [c[0] + r * t.cos(), c[1] + r * t.sin()]
            }
        }
    }
    /// Points along it, for the sign of a loop's area.
    fn samples(&self) -> Vec<P> {
        match *self {
            El::Line { a, .. } => vec![a],
            El::Arc { a, c, r, ccw, .. } => {
                let s = self.sweep();
                (0..8)
                    .map(|k| {
                        let t = ang(a, c) + f64::from(k) / 8.0 * if ccw { s } else { -s };
                        [c[0] + r * t.cos(), c[1] + r * t.sin()]
                    })
                    .collect()
            }
        }
    }
    /// Turning along the element, counter-clockwise positive.
    fn turn(&self) -> f64 {
        match *self {
            El::Line { .. } => 0.0,
            El::Arc { ccw, .. } => if ccw { self.sweep() } else { -self.sweep() },
        }
    }
}

fn arc_el(a: P, m: P, b: P) -> Option<El> {
    let d = 2.0 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if d.abs() < 1e-12 {
        return None;
    }
    let (a2, m2, b2) = (dot(a, a), dot(m, m), dot(b, b));
    let c = [
        (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d,
        (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d,
    ];
    Some(El::Arc { a, b, c, r: len(sub(a, c)), ccw: cross(sub(m, a), sub(b, m)) > 0.0 })
}

/// An element of a chain with the curve it came from, for messages.
#[derive(Clone, Copy)]
struct Link<'a> {
    el: El,
    curve: &'a str,
    order: usize,
    flipped: bool,
}

struct Chain<'a> {
    links: Vec<Link<'a>>,
    closed: bool,
}

/// The links joined end to end, a chain stopping where curves end or branch.
fn chains<'a>(links: Vec<Link<'a>>, tol: f64) -> Vec<Chain<'a>> {
    let mut nodes: Vec<P> = Vec::new();
    let mut node = |p: P| -> usize {
        if let Some(i) = nodes.iter().position(|q| len(sub(*q, p)) <= tol) {
            return i;
        }
        nodes.push(p);
        nodes.len() - 1
    };
    let ends: Vec<[usize; 2]> = links.iter().map(|l| [node(l.el.a()), node(l.el.b())]).collect();
    let mut degree = vec![0usize; nodes.len()];
    for e in &ends {
        degree[e[0]] += 1;
        degree[e[1]] += 1;
    }
    let mut used = vec![false; links.len()];
    let mut out = Vec::new();
    let walk = |start: usize, from: usize, used: &mut Vec<bool>, links: &[Link<'a>]| -> Chain<'a> {
        let mut chain = Vec::new();
        let (mut i, mut at) = (start, from);
        loop {
            used[i] = true;
            let mut l = links[i];
            let far = if ends[i][0] == at {
                ends[i][1]
            } else {
                l.el = l.el.reversed();
                l.flipped = true;
                ends[i][0]
            };
            chain.push(l);
            if far == from && degree[far] == 2 {
                return Chain { links: chain, closed: true };
            }
            if degree[far] != 2 {
                return Chain { links: chain, closed: false };
            }
            let Some(next) = (0..ends.len()).find(|&k| !used[k] && ends[k].contains(&far)) else {
                return Chain { links: chain, closed: false };
            };
            i = next;
            at = far;
        }
    };
    for i in 0..links.len() {
        for side in 0..2 {
            if !used[i] && degree[ends[i][side]] != 2 {
                out.push(walk(i, ends[i][side], &mut used, &links));
            }
        }
    }
    for i in 0..links.len() {
        if !used[i] {
            out.push(walk(i, ends[i][0], &mut used, &links));
        }
    }
    out
}

fn too_thick(curve: &str, d: f64) -> Fail {
    Fail::msg(format!(
        "the wall is too thick for curve {curve}: at {} mm its offset folds over, make it thinner or the curve longer",
        py_g(d)
    ))
}

fn offset_el(l: &Link, d: f64) -> FResult<El> {
    Ok(match l.el {
        El::Line { a, b } => {
            let n = mul(left(unit(sub(b, a))), d);
            El::Line { a: add(a, n), b: add(b, n) }
        }
        El::Arc { a, b, c, r, ccw } => {
            let r2 = if ccw { r - d } else { r + d };
            if r2 <= 1e-9 * r.max(1.0) {
                return Err(Fail::msg(format!(
                    "the wall is thicker than the radius of arc {} ({} mm), make it thinner",
                    l.curve,
                    py_g(r)
                )));
            }
            let k = r2 / r;
            El::Arc { a: add(c, mul(sub(a, c), k)), b: add(c, mul(sub(b, c), k)), c, r: r2, ccw }
        }
    })
}

/// Where the carriers of two offset elements cross, nearest `near`.
fn meet(e1: &El, e2: &El, near: P) -> Option<P> {
    let line_line = |p: P, u: P, q: P, v: P| -> Option<P> {
        let den = cross(u, v);
        (den.abs() > 1e-12).then(|| add(p, mul(u, cross(sub(q, p), v) / den)))
    };
    let line_circle = |p: P, u: P, c: P, r: f64| -> Vec<P> {
        let u = unit(u);
        let f = sub(p, c);
        let bq = dot(f, u);
        let disc = bq * bq - (dot(f, f) - r * r);
        if disc < 0.0 {
            return Vec::new();
        }
        let s = disc.sqrt();
        vec![add(p, mul(u, -bq - s)), add(p, mul(u, -bq + s))]
    };
    let cands: Vec<P> = match (*e1, *e2) {
        (El::Line { a, b }, El::Line { a: q, b: w }) => line_line(a, sub(b, a), q, sub(w, q)).into_iter().collect(),
        (El::Line { a, b }, El::Arc { c, r, .. }) | (El::Arc { c, r, .. }, El::Line { a, b }) => {
            line_circle(a, sub(b, a), c, r)
        }
        (El::Arc { c: c1, r: r1, .. }, El::Arc { c: c2, r: r2, .. }) => {
            let dv = sub(c2, c1);
            let dd = len(dv);
            if dd < 1e-12 || dd > r1 + r2 || dd < (r1 - r2).abs() {
                Vec::new()
            } else {
                let x = (dd * dd + r1 * r1 - r2 * r2) / (2.0 * dd);
                let h = (r1 * r1 - x * x).max(0.0).sqrt();
                let base = add(c1, mul(dv, x / dd));
                let n = mul(left(unit(dv)), h);
                vec![add(base, n), sub(base, n)]
            }
        }
    };
    cands.into_iter().min_by(|p, q| len(sub(*p, near)).total_cmp(&len(sub(*q, near))))
}

/// One side of a chain offset by `d` (left of travel positive), corners mitred.
fn side_path(chain: &Chain, d: f64) -> FResult<Vec<El>> {
    if d == 0.0 {
        return Ok(chain.links.iter().map(|l| l.el).collect());
    }
    let n = chain.links.len();
    let mut offs: Vec<El> = chain.links.iter().map(|l| offset_el(l, d)).collect::<FResult<_>>()?;
    let joints = if chain.closed { n } else { n - 1 };
    let mut bridges: Vec<(usize, P)> = Vec::new();
    for j in 0..joints {
        let (i, k) = (j, (j + 1) % n);
        let p = chain.links[i].el.b();
        let t1 = chain.links[i].el.tangent_at(p);
        let t2 = chain.links[k].el.tangent_at(p);
        let (end, start) = (offs[i].b(), offs[k].a());
        if cross(t1, t2).abs() < 1e-9 && dot(t1, t2) > 0.0 {
            let x = mul(add(end, start), 0.5);
            offs[i].set_b(x);
            offs[k].set_a(x);
            continue;
        }
        if dot(t1, t2) < -(160f64.to_radians().cos().abs()) {
            return Err(Fail::msg(format!(
                "curves {} and {} meet at too sharp an angle for a wall, open the angle past 20 degrees",
                chain.links[i].curve, chain.links[k].curve
            )));
        }
        let near = mul(add(end, start), 0.5);
        match meet(&offs[i], &offs[k], near) {
            Some(x) if len(sub(x, p)) <= 8.0 * d.abs() => {
                offs[i].set_b(x);
                offs[k].set_a(x);
            }
            _ => {
                let m = meet(&El::Line { a: end, b: add(end, t1) }, &El::Line { a: start, b: add(start, t2) }, near)
                    .unwrap_or(near);
                bridges.push((i, m));
            }
        }
    }
    for (orig, off) in chain.links.iter().zip(&offs) {
        let bad = match (orig.el, off) {
            (El::Line { a, b }, El::Line { a: oa, b: ob }) => dot(sub(*ob, *oa), sub(b, a)) <= 1e-9,
            (El::Arc { .. }, El::Arc { .. }) => {
                let s = off.sweep();
                s > orig.el.sweep() + std::f64::consts::FRAC_PI_2 || s >= TAU - 1e-9
            }
            _ => false,
        };
        if bad {
            return Err(too_thick(orig.curve, d.abs()));
        }
    }
    let mut out = Vec::with_capacity(offs.len() + 2 * bridges.len());
    for (i, e) in offs.iter().enumerate() {
        out.push(*e);
        if let Some((_, m)) = bridges.iter().find(|(b, _)| *b == i) {
            let next = offs[(i + 1) % n].a();
            out.push(El::Line { a: e.b(), b: *m });
            out.push(El::Line { a: *m, b: next });
        }
    }
    Ok(out)
}

fn face_of(els: &[El], tol: f64, what: &str) -> FResult<Shape> {
    let mut edges = Vec::with_capacity(els.len());
    for e in els {
        if len(sub(e.b(), e.a())) <= tol {
            continue;
        }
        edges.push(match *e {
            El::Line { a, b } => kernel::edge_line(a, b)?,
            El::Arc { a, b, .. } => kernel::edge_arc3(a, e.mid(), b)?,
        });
    }
    let wires = kernel::wires_from_edges(&edges, tol)?;
    let [w] = wires.as_slice() else {
        return Err(Fail::msg(format!("the wall along {what} does not close into one outline")));
    };
    if !kernel::wire_closed(w) {
        return Err(Fail::msg(format!("the wall along {what} does not close into one outline")));
    }
    up(kernel::face_from_wire(w)?)
}

fn up(face: Shape) -> FResult<Shape> {
    Ok(match kernel::face_normal_mid(&face) {
        Some(n) if n[2] < 0.0 => kernel::reversed(&face),
        _ => face,
    })
}

fn loop_area(els: &[El]) -> f64 {
    let pts: Vec<P> = els.iter().flat_map(El::samples).collect();
    (0..pts.len()).map(|i| cross(pts[i], pts[(i + 1) % pts.len()])).sum::<f64>() / 2.0
}

/// Inside and outside widths of the wall.
fn widths(ctx: &Ctx, f: &Extrude) -> FResult<(f64, f64)> {
    let t = ctx.val_or(f.thickness.as_ref(), 0.0)?;
    if !(t.is_finite() && t > 0.0) {
        return Err(Fail::msg(format!("a thin extrude needs a thickness greater than 0, it has {}", py_g(t))));
    }
    Ok(match f.side.as_deref().filter(|s| !s.is_empty()).unwrap_or("center") {
        "center" => (t / 2.0, t / 2.0),
        "inside" => (t, 0.0),
        "outside" => (0.0, t),
        "twoSides" => {
            let t2 = ctx.val_or(f.thickness2.as_ref(), 0.0)?;
            if !(t2.is_finite() && t2 > 0.0) {
                return Err(Fail::msg(format!(
                    "a thin extrude with side twoSides needs a thickness2 greater than 0, it has {}",
                    py_g(t2)
                )));
            }
            (t, t2)
        }
        other => {
            return Err(Fail::msg(format!(
                "thin extrude side {other:?} is not one of center, inside, outside or twoSides"
            )))
        }
    })
}

/// The located wall faces of a thin extrude. `regions` are left for when thin is
/// turned off again, the wall follows `curves`.
pub fn wall_faces(ctx: &Ctx, f: &Extrude, entry: &SketchEntry) -> FResult<Shape> {
    let (inside, outside) = widths(ctx, f)?;
    let names: Vec<String> =
        entry.curves.iter().enumerate().map(|(i, c)| c.id.clone().unwrap_or_else(|| format!("#{}", i + 1))).collect();
    let chosen: Vec<usize> = match &f.curves {
        Some(ids) if !ids.is_empty() => {
            let mut out = Vec::new();
            for id in ids {
                let Some(i) = entry.curves.iter().position(|c| c.id.as_deref() == Some(id.as_str())) else {
                    return Err(Fail::msg(format!("curve {id} is not in sketch {}", f.sketch)));
                };
                if entry.curves[i].construction {
                    return Err(Fail::msg(format!(
                        "curve {id} is a construction curve, a thin wall follows only normal curves"
                    )));
                }
                if !out.contains(&i) {
                    out.push(i);
                }
            }
            out
        }
        _ => (0..entry.curves.len()).filter(|&i| !entry.curves[i].construction).collect(),
    };
    if chosen.is_empty() {
        return Err(Fail::msg(format!("sketch {} has no curves for a thin wall", f.sketch)));
    }

    let mut links: Vec<Link> = Vec::new();
    let mut walls: Vec<Shape> = Vec::new();
    let mut scale: f64 = 1.0;
    for &i in &chosen {
        let pieces = entry.curves[i].pieces.as_ref().map_err(|kind| {
            Fail::msg(format!(
                "curve {} is a {kind}, a thin wall follows lines, arcs, circles, rectangles, polygons and slots",
                names[i]
            ))
        })?;
        for p in pieces {
            match *p {
                Piece::Seg { a, b } => {
                    scale = scale.max(len(a)).max(len(b));
                    if len(sub(b, a)) > 1e-12 {
                        links.push(Link { el: El::Line { a, b }, curve: &names[i], order: links.len(), flipped: false });
                    }
                }
                Piece::Arc { a, m, b } => {
                    scale = scale.max(len(a)).max(len(b));
                    let el = arc_el(a, m, b).unwrap_or(El::Line { a, b });
                    links.push(Link { el, curve: &names[i], order: links.len(), flipped: false });
                }
                Piece::Circle { c, r } => {
                    if r - inside <= 1e-9 * r.max(1.0) {
                        return Err(Fail::msg(format!(
                            "the wall is thicker than the radius of circle {} ({} mm), make it thinner",
                            names[i],
                            py_g(r)
                        )));
                    }
                    let disc = |rr: f64| -> FResult<Shape> {
                        let e = kernel::edge_circle(c, rr)?;
                        up(kernel::face_from_wire(&kernel::wire_from_edge(&e)?)?)
                    };
                    walls.push(kernel::boolean_op(&disc(r + outside)?, &[&disc(r - inside)?], BoolKind::Cut)?);
                }
            }
        }
    }
    let tol = 1e-7 * scale;
    for chain in chains(links, tol * 10.0) {
        let mut chain = chain;
        let what = chain.links[0].curve.to_owned();
        let inside_left = if chain.closed {
            let els: Vec<El> = chain.links.iter().map(|l| l.el).collect();
            if loop_area(&els) < 0.0 {
                chain.links.reverse();
                for l in &mut chain.links {
                    l.el = l.el.reversed();
                    l.flipped = !l.flipped;
                }
            }
            true
        } else {
            let mut turn: f64 = chain.links.iter().map(|l| l.el.turn()).sum();
            for w in chain.links.windows(2) {
                let p = w[0].el.b();
                turn += cross(w[0].el.tangent_at(p), w[1].el.tangent_at(p))
                    .atan2(dot(w[0].el.tangent_at(p), w[1].el.tangent_at(p)));
            }
            if turn.abs() < 1e-9 {
                // A straight chain has no inside, so it is the left of its first curve as drawn.
                !chain.links.iter().min_by_key(|l| l.order).is_some_and(|l| l.flipped)
            } else {
                turn > 0.0
            }
        };
        let (dl, dr) = if inside_left { (inside, outside) } else { (outside, inside) };
        let lp = side_path(&chain, dl)?;
        let rp = side_path(&chain, -dr)?;
        if chain.closed {
            let inner = face_of(&lp, tol, &what)?;
            let outer = face_of(&rp, tol, &what)?;
            let inner_area = loop_area(&lp);
            if inner_area <= 0.0 || inner_area >= loop_area(&rp) {
                return Err(too_thick(&what, inside));
            }
            walls.push(kernel::boolean_op(&outer, &[&inner], BoolKind::Cut)?);
        } else {
            let mut outline = lp.clone();
            let (le, re) = (lp[lp.len() - 1].b(), rp[rp.len() - 1].b());
            outline.push(El::Line { a: le, b: re });
            outline.extend(rp.iter().rev().map(El::reversed));
            outline.push(El::Line { a: rp[0].a(), b: lp[0].a() });
            walls.push(face_of(&outline, tol, &what)?);
        }
    }
    let faces: Vec<Shape> = walls.iter().flat_map(|w| kernel::subshapes(w, Kind::Face)).collect();
    let fused = match faces.as_slice() {
        [] => return Err(Fail::msg(format!("sketch {} has no curves for a thin wall", f.sketch))),
        [one] => one.clone(),
        [first, rest @ ..] => {
            let tools: Vec<&Shape> = rest.iter().collect();
            kernel::clean(&kernel::boolean_op(first, &tools, BoolKind::Fuse)?)?
        }
    };
    Ok(entry.plane.locate(&fused)?)
}
