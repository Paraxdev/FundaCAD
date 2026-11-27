//! The modify tools' geometry, FundaCAD 1's sketch/modify.ts, mirror.ts and pattern.ts translated: trim, extend,
//! fillet, offset, reflect and translate. Shapes go in and come out as .funda JSON without ids.

use std::f64::consts::{PI, TAU};

use fundacad_sketch::geom::{ccw_delta, circumcenter, v};
use fundacad_sketch::Entity;
use glam::DVec2;
use serde_json::{json, Value};

fn d2(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

/// Something another curve is cut against: a sampled path or an exact circle.
#[derive(Clone, Debug)]
pub enum Cutter {
    Poly(Vec<DVec2>),
    Circle(DVec2, f64),
}

/// Every curve but `skip` as a cutter, polygons included.
pub fn cutters(ents: &[Entity], polygons: &[(String, Vec<DVec2>)], skip: &str) -> Vec<Cutter> {
    let mut out: Vec<Cutter> = ents
        .iter()
        .filter(|e| e.id() != skip)
        .filter_map(|e| match e {
            Entity::Circle { x, y, radius, .. } => Some(Cutter::Circle(d2(*x, *y), *radius)),
            _ => super::regions::outline(e)
                .map(|mut o| {
                    o.push(o[0]);
                    o
                })
                .or_else(|| super::regions::path(e))
                .or_else(|| match e {
                    Entity::Projected { .. } => e.as_line_seg().map(|(a, b)| vec![d2(a.x, a.y), d2(b.x, b.y)]),
                    Entity::Spline { points, .. } => Some(points.iter().map(|p| d2(p.x, p.y)).collect()),
                    _ => None,
                })
                .map(Cutter::Poly),
        })
        .collect();
    out.extend(polygons.iter().filter(|(id, _)| id != skip).map(|(_, p)| {
        let mut p = p.clone();
        p.push(p[0]);
        Cutter::Poly(p)
    }));
    out
}

fn cross(a: DVec2, b: DVec2) -> f64 {
    a.x * b.y - a.y * b.x
}

/// Where segments a-b and c-d cross, ends included.
pub fn seg_intersect(a: DVec2, b: DVec2, c: DVec2, d: DVec2) -> Option<DVec2> {
    let (r, s) = (b - a, d - c);
    let den = cross(r, s);
    if den.abs() < 1e-12 {
        return None;
    }
    let t = cross(c - a, s) / den;
    let u = cross(c - a, r) / den;
    ((-1e-9..=1.0 + 1e-9).contains(&t) && (-1e-9..=1.0 + 1e-9).contains(&u)).then(|| a + r * t)
}

/// Where the infinite lines through a-b and c-d meet.
pub fn line_intersect(a: DVec2, b: DVec2, c: DVec2, d: DVec2) -> Option<DVec2> {
    let (r, s) = (b - a, d - c);
    let den = cross(r, s);
    (den.abs() > 1e-12).then(|| a + r * (cross(c - a, s) / den))
}

pub fn seg_circle_intersect(a: DVec2, b: DVec2, c: DVec2, r: f64) -> Vec<DVec2> {
    let d = b - a;
    let f = a - c;
    let (qa, qb, qc) = (d.dot(d), 2.0 * f.dot(d), f.dot(f) - r * r);
    let disc = qb * qb - 4.0 * qa * qc;
    if qa < 1e-18 || disc < 0.0 {
        return Vec::new();
    }
    let s = disc.sqrt();
    let mut out = Vec::new();
    for t in [(-qb - s) / (2.0 * qa), (-qb + s) / (2.0 * qa)] {
        if (-1e-9..=1.0 + 1e-9).contains(&t) && out.iter().all(|p: &DVec2| p.distance(a + d * t) > 1e-9) {
            out.push(a + d * t);
        }
    }
    out
}

pub fn circle_circle_intersect(c1: DVec2, r1: f64, c2: DVec2, r2: f64) -> Vec<DVec2> {
    let d = c1.distance(c2);
    if d < 1e-12 || d > r1 + r2 || d < (r1 - r2).abs() {
        return Vec::new();
    }
    let a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d);
    let h = (r1 * r1 - a * a).max(0.0).sqrt();
    let u = (c2 - c1) / d;
    let m = c1 + u * a;
    let n = d2(-u.y, u.x) * h;
    if h < 1e-12 {
        vec![m]
    } else {
        vec![m + n, m - n]
    }
}

fn seg_hits(c: &Cutter, a: DVec2, b: DVec2) -> Vec<DVec2> {
    match c {
        Cutter::Circle(o, r) => seg_circle_intersect(a, b, *o, *r),
        Cutter::Poly(p) => p.windows(2).filter_map(|w| seg_intersect(a, b, w[0], w[1])).collect(),
    }
}

fn circle_hits(c: &Cutter, o: DVec2, r: f64) -> Vec<DVec2> {
    match c {
        Cutter::Circle(o2, r2) => circle_circle_intersect(o, r, *o2, *r2),
        Cutter::Poly(p) => p.windows(2).flat_map(|w| seg_circle_intersect(w[0], w[1], o, r)).collect(),
    }
}

fn param_on_seg(a: DVec2, b: DVec2, p: DVec2) -> f64 {
    let d = b - a;
    (p - a).dot(d) / d.length_squared().max(1e-18)
}

/// An arc's centre, radius, CCW start and CCW sweep, oriented so the through point lies inside the sweep.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArcGeom {
    pub c: DVec2,
    pub r: f64,
    pub start: f64,
    pub delta: f64,
}

pub fn arc_geom(a: DVec2, b: DVec2, m: DVec2) -> Option<ArcGeom> {
    let c = circumcenter(v(a.x, a.y), v(b.x, b.y), v(m.x, m.y))?;
    let c = d2(c.x, c.y);
    let ang = |p: DVec2| (p.y - c.y).atan2(p.x - c.x);
    let (s, e, t) = (ang(a), ang(b), ang(m));
    let r = c.distance(a);
    Some(if ccw_delta(s, t) <= ccw_delta(s, e) {
        ArcGeom { c, r, start: s, delta: ccw_delta(s, e) }
    } else {
        ArcGeom { c, r, start: e, delta: ccw_delta(e, s) }
    })
}

fn polar(c: DVec2, r: f64, a: f64) -> DVec2 {
    c + DVec2::from_angle(a) * r
}

pub fn arc_json(c: DVec2, r: f64, start: f64, delta: f64) -> Value {
    let (a, b, m) = (polar(c, r, start), polar(c, r, start + delta), polar(c, r, start + delta / 2.0));
    json!({"type": "arc", "x1": a.x, "y1": a.y, "x2": b.x, "y2": b.y, "mx": m.x, "my": m.y})
}

fn line_json(a: DVec2, b: DVec2) -> Value {
    json!({"type": "line", "x1": a.x, "y1": a.y, "x2": b.x, "y2": b.y})
}

/// The span between sorted cut parameters that holds `tc`.
fn span(sorted: &[f64], tc: f64) -> (f64, f64) {
    sorted.windows(2).find(|w| tc >= w[0] && tc <= w[1]).map_or((0.0, 1.0), |w| (w[0], w[1]))
}

fn sorted_params(mut ts: Vec<f64>) -> Vec<f64> {
    ts.push(0.0);
    ts.push(1.0);
    ts.sort_by(f64::total_cmp);
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    ts
}

/// The pieces left once the clicked span up to its nearest crossings is gone: a line or arc keeps its outer pieces, a
/// circle becomes the complementary arc, a curve with no crossing or a rigid shape goes whole (an empty list).
pub fn trim(e: &Entity, cut: &[Cutter], click: DVec2) -> Vec<Value> {
    match e {
        Entity::Circle { x, y, radius, .. } => {
            let (c, r) = (d2(*x, *y), *radius);
            let norm = |a: f64| a.rem_euclid(TAU);
            let mut angs: Vec<f64> =
                cut.iter().flat_map(|k| circle_hits(k, c, r)).map(|h| norm((h.y - c.y).atan2(h.x - c.x))).collect();
            angs.sort_by(f64::total_cmp);
            angs.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
            if angs.len() < 2 {
                return Vec::new();
            }
            let tc = norm((click.y - c.y).atan2(click.x - c.x));
            let n = angs.len();
            let (lo, hi) = (0..n)
                .map(|k| (angs[k], angs[(k + 1) % n]))
                .find(|(a, b)| ccw_delta(*a, tc) <= ccw_delta(*a, *b))
                .unwrap_or((angs[n - 1], angs[0]));
            let keep = ccw_delta(hi, lo);
            if keep < 1e-3 {
                return Vec::new();
            }
            vec![arc_json(c, r, hi, keep)]
        }
        Entity::Arc { x1, y1, x2, y2, mx, my, .. } => {
            let Some(g) = arc_geom(d2(*x1, *y1), d2(*x2, *y2), d2(*mx, *my)) else { return Vec::new() };
            let ts = cut
                .iter()
                .flat_map(|k| circle_hits(k, g.c, g.r))
                .map(|h| ccw_delta(g.start, (h.y - g.c.y).atan2(h.x - g.c.x)) / g.delta)
                .filter(|t| *t > 1e-4 && *t < 1.0 - 1e-4)
                .collect();
            let sorted = sorted_params(ts);
            if sorted.len() <= 2 {
                return Vec::new();
            }
            let tc = (ccw_delta(g.start, (click.y - g.c.y).atan2(click.x - g.c.x)) / g.delta).clamp(0.0, 1.0);
            let (lo, hi) = span(&sorted, tc);
            [(0.0, lo), (hi, 1.0)]
                .into_iter()
                .filter(|(a, b)| b - a > 1e-3)
                .map(|(a, b)| arc_json(g.c, g.r, g.start + a * g.delta, (b - a) * g.delta))
                .collect()
        }
        Entity::Line { x1, y1, x2, y2, .. } => {
            let (p1, p2) = (d2(*x1, *y1), d2(*x2, *y2));
            let ts = cut
                .iter()
                .flat_map(|k| seg_hits(k, p1, p2))
                .map(|h| param_on_seg(p1, p2, h))
                .filter(|t| *t > 1e-4 && *t < 1.0 - 1e-4)
                .collect();
            let sorted = sorted_params(ts);
            if sorted.len() <= 2 {
                return Vec::new();
            }
            let (lo, hi) = span(&sorted, param_on_seg(p1, p2, click).clamp(0.0, 1.0));
            let at = |t: f64| p1 + (p2 - p1) * t;
            [(0.0, lo), (hi, 1.0)].into_iter().filter(|(a, b)| b - a >= 1e-3).map(|(a, b)| line_json(at(a), at(b))).collect()
        }
        _ => Vec::new(),
    }
}

/// The line or arc with its end nearer the click run on to the nearest crossing, None when nothing lies ahead.
pub fn extend(e: &Entity, cut: &[Cutter], click: DVec2) -> Option<Value> {
    match e {
        Entity::Line { x1, y1, x2, y2, .. } => {
            let (p1, p2) = (d2(*x1, *y1), d2(*x2, *y2));
            let end2 = param_on_seg(p1, p2, click) >= 0.5;
            let dir = (p2 - p1).normalize_or_zero();
            let (far, far_end) = (p1 - dir * 1e5, p2 + dir * 1e5);
            let ts = cut.iter().flat_map(|k| seg_hits(k, far, far_end)).map(|h| param_on_seg(p1, p2, h));
            let best = if end2 {
                ts.filter(|t| *t > 1.0 + 1e-4).min_by(f64::total_cmp)?
            } else {
                ts.filter(|t| *t < -1e-4).max_by(f64::total_cmp)?
            };
            let np = p1 + (p2 - p1) * best;
            Some(if end2 { line_json(p1, np) } else { line_json(np, p2) })
        }
        Entity::Arc { x1, y1, x2, y2, mx, my, .. } => {
            let g = arc_geom(d2(*x1, *y1), d2(*x2, *y2), d2(*mx, *my))?;
            let near_end = ccw_delta(g.start, (click.y - g.c.y).atan2(click.x - g.c.x)) > g.delta / 2.0;
            let end = g.start + g.delta;
            let best = cut
                .iter()
                .flat_map(|k| circle_hits(k, g.c, g.r))
                .map(|h| (h.y - g.c.y).atan2(h.x - g.c.x))
                .filter(|a| ccw_delta(g.start, *a) > g.delta + 1e-6)
                .map(|a| if near_end { ccw_delta(end, a) } else { ccw_delta(a, g.start) })
                .filter(|gap| *gap > 1e-4 && *gap < TAU - g.delta - 1e-4)
                .min_by(f64::total_cmp)?;
            let start = if near_end { g.start } else { g.start - best };
            let mut out = arc_json(g.c, g.r, start, g.delta + best);
            let s0 = polar(g.c, g.r, g.start);
            if d2(*x1, *y1).distance(s0) > d2(*x2, *y2).distance(s0) {
                for (a, b) in [("x1", "x2"), ("y1", "y2")] {
                    let t = out[a].take();
                    out[a] = std::mem::replace(&mut out[b], t);
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// A fillet of radius `r` at the corner of two lines: each line cut back to its tangent point with its ends in their
/// own order, and the tangent arc.
#[derive(Clone, Debug, PartialEq)]
pub struct Fillet {
    pub a: (DVec2, DVec2),
    pub b: (DVec2, DVec2),
    pub arc: Value,
}

pub fn fillet(a: (DVec2, DVec2), b: (DVec2, DVec2), r: f64) -> Option<Fillet> {
    let corner = line_intersect(a.0, a.1, b.0, b.1)?;
    let far = |l: (DVec2, DVec2)| if l.0.distance(corner) >= l.1.distance(corner) { (l.0, true) } else { (l.1, false) };
    let ((af, a_start), (bf, b_start)) = (far(a), far(b));
    let (d1, d2v) = ((af - corner).normalize_or_zero(), (bf - corner).normalize_or_zero());
    let theta = d1.dot(d2v).clamp(-1.0, 1.0).acos();
    if theta < 1e-3 || PI - theta < 1e-3 {
        return None;
    }
    let tan = r / (theta / 2.0).tan();
    if tan > af.distance(corner) || tan > bf.distance(corner) {
        return None;
    }
    let (t1, t2) = (corner + d1 * tan, corner + d2v * tan);
    let center = corner + (d1 + d2v).normalize() * (r / (theta / 2.0).sin());
    let through = center + (corner - center).normalize() * r;
    let cut = |keep_start: bool, far: DVec2, t: DVec2| if keep_start { (far, t) } else { (t, far) };
    Some(Fillet {
        a: cut(a_start, af, t1),
        b: cut(b_start, bf, t2),
        arc: json!({"type": "arc", "x1": t1.x, "y1": t1.y, "x2": t2.x, "y2": t2.y, "mx": through.x, "my": through.y}),
    })
}

fn num(e: &Value, k: &str) -> f64 {
    e.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn pt(e: &Value, kx: &str, ky: &str) -> DVec2 {
    d2(num(e, kx), num(e, ky))
}

fn pts(e: &Value, k: &str) -> Vec<DVec2> {
    e.get(k).and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().map(|p| pt(p, "x", "y")).collect())
}

fn ty(e: &Value) -> &str {
    e.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn polygon_corners(e: &Value) -> Vec<DVec2> {
    let n = num(e, "sides").round().max(3.0) as usize;
    let (c, r, a) = (pt(e, "x", "y"), num(e, "radius"), num(e, "angle").to_radians());
    (0..n).map(|k| polar(c, r, a + k as f64 / n as f64 * TAU)).collect()
}

fn dist_to_seg(a: DVec2, b: DVec2, p: DVec2) -> f64 {
    (a + (b - a) * param_on_seg(a, b, p).clamp(0.0, 1.0)).distance(p)
}

fn left_of(a: DVec2, b: DVec2, p: DVec2) -> f64 {
    let d = b - a;
    let len = d.length();
    if len < 1e-9 {
        0.0
    } else {
        cross(d, p - a) / len
    }
}

/// The offset distance that puts the copy under `p`: positive outward for a closed shape, left of the stored direction
/// for a line or spline.
pub fn signed_offset_at(e: &Value, p: DVec2) -> Option<f64> {
    Some(match ty(e) {
        "line" => left_of(pt(e, "x1", "y1"), pt(e, "x2", "y2"), p),
        "circle" => pt(e, "x", "y").distance(p) - num(e, "radius"),
        "arc" => {
            let g = arc_geom(pt(e, "x1", "y1"), pt(e, "x2", "y2"), pt(e, "mx", "my"))?;
            g.c.distance(p) - g.r
        }
        "rectangle" => {
            let dx = (p.x - num(e, "x")).abs() - num(e, "width") / 2.0;
            let dy = (p.y - num(e, "y")).abs() - num(e, "height") / 2.0;
            if dx > 0.0 || dy > 0.0 {
                dx.max(0.0).hypot(dy.max(0.0))
            } else {
                dx.max(dy)
            }
        }
        "polygon" => {
            let c = polygon_corners(e);
            (0..c.len()).map(|i| -left_of(c[i], c[(i + 1) % c.len()], p)).fold(f64::NEG_INFINITY, f64::max)
        }
        "spline" => {
            let line = pts(e, "points");
            line.windows(2)
                .map(|w| (dist_to_seg(w[0], w[1], p), left_of(w[0], w[1], p)))
                .min_by(|a, b| a.0.total_cmp(&b.0))
                .map(|(d, side)| if side < 0.0 { -d } else { d })?
        }
        _ => return None,
    })
}

/// The offset copy of a shape and whether the offset constraint can tie it to the source (rigid shapes cannot), None
/// when the distance collapses it or the type has no offset.
pub fn offset(e: &Value, dist: f64) -> Option<(Value, bool)> {
    match ty(e) {
        "rectangle" => {
            let (w, h) = (num(e, "width") + 2.0 * dist, num(e, "height") + 2.0 * dist);
            let mut c = json!({"type": "rectangle", "x": num(e, "x"), "y": num(e, "y"), "width": w, "height": h});
            let angle = num(e, "angle");
            if angle != 0.0 {
                c["angle"] = json!(angle);
            }
            (w > 1e-3 && h > 1e-3).then_some((c, angle == 0.0))
        }
        "circle" => {
            let r = num(e, "radius") + dist;
            (r > 1e-3).then(|| (json!({"type": "circle", "x": num(e, "x"), "y": num(e, "y"), "radius": r}), true))
        }
        "line" => {
            let (a, b) = (pt(e, "x1", "y1"), pt(e, "x2", "y2"));
            let d = (b - a).normalize_or_zero();
            let n = d2(-d.y, d.x) * dist;
            Some((line_json(a + n, b + n), true))
        }
        "arc" => {
            let g = arc_geom(pt(e, "x1", "y1"), pt(e, "x2", "y2"), pt(e, "mx", "my"))?;
            (g.r + dist > 1e-3).then(|| (arc_json(g.c, g.r + dist, g.start, g.delta), true))
        }
        "spline" => {
            let p = pts(e, "points");
            if p.len() < 2 {
                return None;
            }
            let n = p.len();
            let closed = n > 3 && p[0].distance(p[n - 1]) < 1e-9;
            let moved: Vec<Value> = (0..n)
                .map(|i| {
                    let prev = if i > 0 { p[i - 1] } else if closed { p[n - 2] } else { p[i] };
                    let next = if i + 1 < n { p[i + 1] } else if closed { p[1] } else { p[i] };
                    let d = next - prev;
                    let len = if d.length() > 0.0 { d.length() } else { 1.0 };
                    let q = p[i] + d2(-d.y, d.x) / len * dist;
                    json!({"x": q.x, "y": q.y})
                })
                .collect();
            Some((json!({"type": "spline", "points": moved}), false))
        }
        "polygon" => {
            let n = num(e, "sides").round().max(3.0);
            let r = num(e, "radius") + dist / (PI / n).cos();
            let c = json!({"type": "polygon", "x": num(e, "x"), "y": num(e, "y"), "radius": r, "sides": e["sides"], "angle": num(e, "angle")});
            (r > 1e-3).then_some((c, false))
        }
        _ => None,
    }
}

/// Every point of a shape through `f`, the angle of a rectangle or polygon through `turn`.
fn map_points(e: &Value, f: impl Fn(DVec2) -> DVec2, turn: impl Fn(f64) -> f64) -> Value {
    let mut out = e.clone();
    for (kx, ky) in [("x1", "y1"), ("x2", "y2"), ("mx", "my"), ("x", "y")] {
        if e.get(kx).and_then(Value::as_f64).is_some() && e.get(ky).and_then(Value::as_f64).is_some() {
            let q = f(pt(e, kx, ky));
            out[kx] = json!(q.x);
            out[ky] = json!(q.y);
        }
    }
    for k in ["points", "poles"] {
        if e.get(k).is_some() {
            out[k] = Value::Array(pts(e, k).into_iter().map(&f).map(|q| json!({"x": q.x, "y": q.y})).collect());
        }
    }
    if matches!(ty(e), "rectangle" | "polygon") {
        let a = turn(num(e, "angle"));
        if a == 0.0 && ty(e) == "rectangle" {
            if let Some(o) = out.as_object_mut() {
                o.remove("angle");
            }
        } else {
            out["angle"] = json!(a);
        }
    }
    out
}

pub fn reflect_point(p: DVec2, a: DVec2, b: DVec2) -> DVec2 {
    let foot = a + (b - a) * param_on_seg(a, b, p);
    foot * 2.0 - p
}

/// The mirror image across the line through a and b.
pub fn reflect(e: &Value, a: DVec2, b: DVec2) -> Value {
    let theta = (b.y - a.y).atan2(b.x - a.x).to_degrees();
    let period = if ty(e) == "rectangle" { 180.0 } else { 360.0 };
    map_points(e, |p| reflect_point(p, a, b), |deg| (2.0 * theta - deg).rem_euclid(period))
}

pub fn translate(e: &Value, d: DVec2) -> Value {
    map_points(e, |p| p + d, |deg| deg)
}

#[cfg(test)]
#[path = "modify_tests.rs"]
mod tests;
