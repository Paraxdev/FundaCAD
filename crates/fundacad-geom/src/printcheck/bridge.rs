//! Whether a flat ceiling is a bridge held on two sides or a ledge needing support. A point's span is the
//! shortest opposite ray pair ending on supported edges, a ray first meeting an unsupported edge has left the ceiling.

use std::collections::HashMap;

use super::{dot, sub_samples, Body, EdgeKey};

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

/// Per mm from the origin, how far the part must drop below an edge for it to hold: above single precision
/// noise, below a fine fillet's first facet drop, which is under a thousandth of a mm.
const DROP: f64 = 8.0 * f32::EPSILON as f64;

/// `tris` is one flat downward face of `b`. A point `rests` puts on another body is held, and the rims
/// of other bodies' tops in `posts` hold it as its own walls do.
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
    let mut free: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for (key, n) in &count {
        if *n != 1 {
            continue;
        }
        let (i, j, _) = uses[key];
        let height = dot(b.pts[i], up).max(dot(b.pts[j], up));
        // Where the far corner of the triangle across this edge lies says whether the part goes down here. Any
        // drop counts: a small fillet drops under a thousandth of a mm in its first facet, a step up never drops.
        let held = edges.get(key).into_iter().flatten().filter(|t| !in_face.contains(t)).any(|&t| {
            b.tris[t].iter().filter(|&&q| b.key(q) != b.key(i) && b.key(q) != b.key(j)).any(|&q| {
                let p = b.pts[q];
                let size = p.iter().fold(height.abs(), |m, c| m.max(c.abs()));
                height - dot(p, up) > DROP * (1.0 + size)
            })
        });
        if held {
            support.push((flat(b.pts[i]), flat(b.pts[j])));
        } else {
            free.push((flat(b.pts[i]), flat(b.pts[j])));
        }
    }
    support.extend(posts.iter().map(|(p, q)| (flat(*p), flat(*q))));
    let area: f64 = tris.iter().map(|&t| b.area[t]).sum();
    let spacing = 0.5f64.max((area / 2000.0).sqrt());
    // Also straight across every wall: a ray a few degrees off across a short tunnel runs out of its open
    // end before it reaches the far wall.
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
                let there = reach(q, *d, &support, &free);
                let back = reach(q, [-d[0], -d[1]], &support, &free);
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

/// Infinity when the ray leaves the ceiling through a `free` edge first. A tie is a corner, or an edge
/// right over another body's top: held.
fn reach(q: [f64; 2], d: [f64; 2], support: &[([f64; 2], [f64; 2])], free: &[([f64; 2], [f64; 2])]) -> f64 {
    let held = nearest(q, d, support);
    if held <= nearest(q, d, free) + 1e-6 {
        held
    } else {
        f64::INFINITY
    }
}

fn nearest(q: [f64; 2], d: [f64; 2], edges: &[([f64; 2], [f64; 2])]) -> f64 {
    let mut best = f64::INFINITY;
    for (a, b) in edges {
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
