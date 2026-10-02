//! Whether a flat ceiling is a bridge, held up on two sides, or a ledge
//! that hangs in the air and needs support.
//!
//! A flat ceiling prints as a bridge: filament strung between two walls.
//! So the ceiling's outline is sorted into edges a wall comes down from
//! (support) and edges where the part goes up or ends (no support), and from
//! points across the ceiling rays go out in opposite pairs: the span at a
//! point is the shortest pair that ends on support at both ends. A point with
//! no such pair is not bridged at all.
//!
//! Known limit: a ray goes straight through an edge without support, so a
//! U-shaped ceiling whose ray leaves through a step up and finds a wall again
//! beyond it counts as bridged.

use std::collections::HashMap;

use super::{dot, sub_samples, Body, EdgeKey};

/// What a ceiling is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Span {
    /// Held up on two sides everywhere; the longest span across it, in mm.
    Bridged(f64),
    /// Somewhere a point has no wall on two opposite sides. `partly` when
    /// other points of it are bridged.
    Ledge { partly: bool },
}

/// Ray pairs per point, evenly spread over half a turn.
const PAIRS: usize = 16;

/// At most this many more, straight across the walls.
const EXTRA: usize = 64;

/// How far below a ceiling the part has to go from an edge for the edge to
/// hold it, for each mm the points are from the origin: more than the noise
/// of a mesh's single precision, and less than the first facet of a fine
/// mesh's fillet drops, under a thousandth of a mm.
const DROP: f64 = 8.0 * f32::EPSILON as f64;

/// The span of the ceiling made of `tris` (one flat downward face of `b`).
/// A point `rests` says sits on another body is held where it is, and the
/// rims of other bodies' tops in `posts` hold it as its own walls do.
pub fn span(
    b: &Body,
    tris: &[usize],
    edges: &HashMap<EdgeKey, Vec<usize>>,
    rests: &dyn Fn([f64; 3]) -> bool,
    posts: &[([f64; 3], [f64; 3])],
) -> Span {
    let up = b.up;
    let in_face: std::collections::HashSet<usize> = tris.iter().copied().collect();
    // The ceiling's outline: the edges only one of its triangles uses.
    let mut uses: HashMap<EdgeKey, (usize, usize, usize)> = HashMap::new();
    let mut count: HashMap<EdgeKey, usize> = HashMap::new();
    for &t in tris {
        let [a, bb, c] = b.tris[t];
        for (i, j, k) in [(a, bb, c), (bb, c, a), (c, a, bb)] {
            let key = b.edge_key(i, j);
            *count.entry(key).or_default() += 1;
            uses.insert(key, (i, j, k));
        }
    }
    // (u, v) in the ceiling's plane.
    let pick = if up[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let u = super::unit(super::cross(super::cross(up, pick), up));
    let v = super::cross(up, u);
    let flat = |p: [f64; 3]| [dot(p, u), dot(p, v)];

    let mut support: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for (key, n) in &count {
        if *n != 1 {
            continue;
        }
        let (i, j, _) = uses[key];
        let height = dot(b.pts[i], up).max(dot(b.pts[j], up));
        // The triangle across this edge, outside the ceiling: where its far
        // corner is says whether the part goes down from here. Any drop
        // counts: a small fillet into the wall drops under a thousandth of a
        // mm in its first facet, and a step up or an open end never drops at all.
        let held = edges.get(key).into_iter().flatten().filter(|t| !in_face.contains(t)).any(|&t| {
            b.tris[t]
                .iter()
                .filter(|&&q| b.key(q) != b.key(i) && b.key(q) != b.key(j))
                .any(|&q| {
                    let p = b.pts[q];
                    let size = p.iter().fold(height.abs(), |m, c| m.max(c.abs()));
                    height - dot(p, up) > DROP * (1.0 + size)
                })
        });
        if held {
            support.push((flat(b.pts[i]), flat(b.pts[j])));
        }
    }
    support.extend(posts.iter().map(|(p, q)| (flat(*p), flat(*q))));
    let area: f64 = tris.iter().map(|&t| b.area[t]).sum();
    let spacing = 0.5f64.max((area / 2000.0).sqrt());
    // Evenly spread, and straight across every wall: a ray a few degrees off
    // straight across a short tunnel runs out of its open end before it
    // reaches the far wall.
    let mut angles: Vec<f64> = (0..PAIRS).map(|k| std::f64::consts::PI * k as f64 / PAIRS as f64).collect();
    for (p, q) in &support {
        let a = (q[1] - p[1]).atan2(q[0] - p[0]) + std::f64::consts::FRAC_PI_2;
        let a = a.rem_euclid(std::f64::consts::PI);
        let near = |x: &f64| {
            let d = (x - a).abs();
            d.min(std::f64::consts::PI - d) < 0.5f64.to_radians()
        };
        if !angles.iter().any(near) && angles.len() < PAIRS + EXTRA {
            angles.push(a);
        }
    }
    let dirs: Vec<[f64; 2]> = angles.iter().map(|a| [a.cos(), a.sin()]).collect();
    let mut widest: f64 = 0.0;
    let (mut held, mut hanging) = (0usize, 0usize);
    for &t in tris {
        let [a, bb, c] = b.tris[t];
        for (q, _) in sub_samples(b.pts[a], b.pts[bb], b.pts[c], b.area[t], spacing) {
            if rests(q) {
                held += 1;
                continue;
            }
            let q = flat(q);
            let mut best = f64::INFINITY;
            for d in &dirs {
                let there = reach(q, *d, &support);
                let back = reach(q, [-d[0], -d[1]], &support);
                if there.is_finite() && back.is_finite() {
                    best = best.min(there + back);
                }
            }
            if best.is_finite() {
                held += 1;
                widest = widest.max(best);
            } else {
                hanging += 1;
            }
        }
    }
    if hanging > 0 {
        Span::Ledge { partly: held > 0 }
    } else {
        Span::Bridged(widest)
    }
}

/// How far from `q` along `d` the nearest supported edge is.
fn reach(q: [f64; 2], d: [f64; 2], support: &[([f64; 2], [f64; 2])]) -> f64 {
    let mut best = f64::INFINITY;
    for (a, b) in support {
        let e = [b[0] - a[0], b[1] - a[1]];
        let den = d[0] * e[1] - d[1] * e[0];
        if den.abs() < 1e-12 {
            continue;
        }
        let w = [a[0] - q[0], a[1] - q[1]];
        let t = (w[0] * e[1] - w[1] * e[0]) / den;
        let s = (w[0] * d[1] - w[1] * d[0]) / den;
        if t > 0.0 && (-1e-9..=1.0 + 1e-9).contains(&s) {
            best = best.min(t);
        }
    }
    best
}
