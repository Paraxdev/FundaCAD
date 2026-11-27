//! Measure, FundaCAD 1's measureTool.ts and measureRows.ts: a face or edge as a probe, the closest pair of points
//! between two probes over their tessellation, and the readout rows.

use glam::Vec3;

use super::{spell, Row};
use crate::i18n::t;
use crate::viewport::scene::SceneBody;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq)]
pub enum Probe {
    /// `point` is the area weighted centroid, `dir` the mean normal.
    Face { point: Vec3, dir: Vec3, area: f32, tris: Vec<[Vec3; 3]> },
    /// `point` is halfway along, `dir` runs from the first point to the last.
    Edge { point: Vec3, dir: Vec3, length: f32, line: Vec<Vec3> },
}

impl Probe {
    pub fn point(&self) -> Vec3 {
        match self {
            Probe::Face { point, .. } | Probe::Edge { point, .. } => *point,
        }
    }

    pub fn dir(&self) -> Vec3 {
        match self {
            Probe::Face { dir, .. } | Probe::Edge { dir, .. } => *dir,
        }
    }
}

pub fn face_triangles(body: &SceneBody, face: u32) -> Vec<[Vec3; 3]> {
    body.indices
        .chunks_exact(3)
        .filter(|t| body.vertices[t[0] as usize].face == face)
        .map(|t| t.iter().map(|&i| body.vertices[i as usize].position()).collect::<Vec<_>>().try_into().unwrap())
        .collect()
}

pub fn face_probe(tris: Vec<[Vec3; 3]>) -> Option<Probe> {
    let (mut area, mut centre, mut normal) = (0.0f32, Vec3::ZERO, Vec3::ZERO);
    for [a, b, c] in &tris {
        let n = (*b - *a).cross(*c - *a);
        let w = n.length() * 0.5;
        area += w;
        centre += (*a + *b + *c) / 3.0 * w;
        normal += n;
    }
    (area > 0.0).then(|| Probe::Face { point: centre / area, dir: normal.normalize_or_zero(), area, tris })
}

/// The point halfway along a polyline by length.
pub fn halfway(line: &[Vec3]) -> Option<Vec3> {
    let total: f32 = line.windows(2).map(|w| w[0].distance(w[1])).sum();
    let mut left = total / 2.0;
    for w in line.windows(2) {
        let d = w[0].distance(w[1]);
        if d >= left && d > 0.0 {
            return Some(w[0].lerp(w[1], left / d));
        }
        left -= d;
    }
    line.first().copied()
}

pub fn edge_probe(line: Vec<Vec3>) -> Option<Probe> {
    if line.len() < 2 {
        return None;
    }
    let length = line.windows(2).map(|w| w[0].distance(w[1])).sum();
    let point = halfway(&line)?;
    let dir = (line[line.len() - 1] - line[0]).normalize_or_zero();
    Some(Probe::Edge { point, dir, length, line })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Near {
    pub d: f32,
    pub pa: Vec3,
    pub pb: Vec3,
}

type Soup = (Vec<[Vec3; 3]>, Vec<[Vec3; 2]>, Vec<Vec3>);

fn soup(p: &Probe) -> Soup {
    match p {
        Probe::Face { tris, .. } => {
            let segs = tris.iter().flat_map(|[a, b, c]| [[*a, *b], [*b, *c], [*c, *a]]).collect();
            let pts = tris.iter().flatten().copied().collect();
            (tris.clone(), segs, pts)
        }
        Probe::Edge { line, .. } => (Vec::new(), line.windows(2).map(|w| [w[0], w[1]]).collect(), line.clone()),
    }
}

/// Exact for flat faces and straight edges, the tessellation's answer on curved ones.
pub fn closest(a: &Probe, b: &Probe) -> Near {
    let (ta, sa, pa) = soup(a);
    let (tb, sb, pb) = soup(b);
    let mut best = Near { d: f32::INFINITY, pa: a.point(), pb: b.point() };
    let mut take = |x: Vec3, y: Vec3| {
        let d = x.distance(y);
        if d < best.d {
            best = Near { d, pa: x, pb: y };
        }
    };
    for p in &pa {
        for t in &tb {
            take(*p, on_triangle(*p, t));
        }
    }
    for p in &pb {
        for t in &ta {
            take(on_triangle(*p, t), *p);
        }
    }
    for s in &sa {
        for t in &sb {
            let (x, y) = on_segments(s[0], s[1], t[0], t[1]);
            take(x, y);
        }
    }
    best
}

/// Ericson, Real-Time Collision Detection 5.1.5.
fn on_triangle(p: Vec3, [a, b, c]: &[Vec3; 3]) -> Vec3 {
    let (a, b, c) = (*a, *b, *c);
    let (ab, ac, ap) = (b - a, c - a, p - a);
    let (d1, d2) = (ab.dot(ap), ac.dot(ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = p - b;
    let (d3, d4) = (ab.dot(bp), ac.dot(bp));
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return a + ab * (d1 / (d1 - d3));
    }
    let cp = p - c;
    let (d5, d6) = (ab.dot(cp), ac.dot(cp));
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return a + ac * (d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
    }
    let denom = va + vb + vc;
    if denom.abs() < f32::EPSILON {
        return a;
    }
    a + ab * (vb / denom) + ac * (vc / denom)
}

/// Ericson 5.1.9, robust for parallel and degenerate segments.
fn on_segments(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3) -> (Vec3, Vec3) {
    const EPS: f32 = 1e-12;
    let (d1, d2, r) = (q1 - p1, q2 - p2, p1 - p2);
    let (a, e, f) = (d1.dot(d1), d2.dot(d2), d2.dot(r));
    let (s, t);
    if a <= EPS && e <= EPS {
        return (p1, p2);
    }
    if a <= EPS {
        s = 0.0;
        t = (f / e).clamp(0.0, 1.0);
    } else {
        let c = d1.dot(r);
        if e <= EPS {
            t = 0.0;
            s = (-c / a).clamp(0.0, 1.0);
        } else {
            let b = d1.dot(d2);
            let denom = a * e - b * b;
            let s0 = if denom > EPS { ((b * f - c * e) / denom).clamp(0.0, 1.0) } else { 0.0 };
            let t0 = (b * s0 + f) / e;
            if t0 < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t0 > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            } else {
                t = t0;
                s = s0;
            }
        }
    }
    (p1 + d1 * s, p2 + d2 * t)
}

fn xyz(v: Vec3) -> String {
    super::spell_xyz(v.as_dvec3().to_array())
}

fn mm(v: f32) -> String {
    format!("{} mm", spell(v as f64))
}

/// The readout for the picks so far: a prompt, one probe's size and place, or what lies between two.
pub fn rows(a: Option<&Probe>, b: Option<&Probe>) -> Vec<Row> {
    let row = |k: &str, v: String| (k.to_string(), v);
    let Some(a) = a else { return vec![row("", t("inspect.measure.prompt"))] };
    let Some(b) = b else {
        let size = match a {
            Probe::Face { area, .. } => row(&t("tool.measure.area"), format!("{} mm²", spell(*area as f64))),
            Probe::Edge { length, .. } => row(&t("field.length"), mm(*length)),
        };
        return vec![size, row(&t("tool.measure.at"), xyz(a.point()))];
    };
    let near = closest(a, b);
    let mut out = vec![
        row(&t("field.distance"), mm(near.d)),
        row("ΔX ΔY ΔZ", xyz(near.pb - near.pa)),
        row(&t("tool.measure.centers"), mm(a.point().distance(b.point()))),
    ];
    if a.dir() != Vec3::ZERO && b.dir() != Vec3::ZERO {
        out.push(row(&t("field.angle"), format!("{}°", spell(a.dir().angle_between(b.dir()).to_degrees() as f64))));
    }
    out
}
