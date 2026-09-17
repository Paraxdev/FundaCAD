//! ptb_read.py: cylindrical holes, and circular openings in flat faces.

use crate::fundacad::plugin::types::{Curve, Surface};
use crate::g::{self, V};
use crate::{feature, Shape};

const SAMPLES: u32 = 16;

/// `picked_faces`: (body, its shape, the picked faces) per body.
pub fn picked_faces(label: &str) -> Result<Vec<(u32, Shape, Vec<Shape>)>, String> {
    let mut out = Vec::new();
    for p in feature::pick_faces("faces", label)? {
        let shape = feature::body_shape(p.body)?;
        out.push((p.body, shape, p.items));
    }
    Ok(out)
}

pub fn edge_points(s: &Shape) -> Vec<V> {
    s.sample_edges(SAMPLES)
}

fn canonical_axis(a: V) -> V {
    for c in [a.0, a.1, a.2] {
        if c.abs() > 1e-9 {
            return if c > 0.0 { a } else { g::mul(a, -1.0) };
        }
    }
    a
}

pub struct Hole {
    pub origin: V,
    pub axis: V,
    pub radius: f64,
    pub t0: f64,
    pub t1: f64,
}

/// (origin, axis, radius, t0, t1) of a cylindrical face.
pub fn cylinder_of(face: &Shape) -> Option<Hole> {
    let Surface::Cylinder(c) = face.surface() else {
        return None;
    };
    let o = c.origin;
    let a = canonical_axis(g::unit(c.axis));
    let ts: Vec<f64> = edge_points(face).into_iter().map(|p| g::dot(g::sub(p, o), a)).collect();
    if ts.is_empty() {
        return None;
    }
    let lo = ts.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = ts.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    Some(Hole { origin: o, axis: a, radius: c.radius, t0: lo, t1: hi })
}

/// Picked cylinder faces merged into holes, two half faces of one hole once.
pub fn holes_from_faces(shape: &Shape, faces: &[Shape], label: &str) -> Result<Vec<Hole>, String> {
    let mut holes: Vec<Hole> = Vec::new();
    for fc in faces {
        let Some(c) = cylinder_of(fc) else {
            return Err(format!(
                "{label}: pick the inside face of a round hole, this face is not cylindrical"
            ));
        };
        let (o, a, r, t0, t1) = (c.origin, c.axis, c.radius, c.t0, c.t1);
        let mid = g::lin(o, &[((t0 + t1) / 2.0, a)]);
        if g::inside(shape, mid) {
            return Err(format!("{label}: the picked cylinder is a boss, not a hole"));
        }
        let tol = (r * 1e-4).max(1e-4);
        let mut merged = false;
        for h in holes.iter_mut() {
            if (h.radius - r).abs() > tol || (g::dot(h.axis, a).abs() - 1.0).abs() > 1e-6 {
                continue;
            }
            let off = g::sub(o, h.origin);
            if g::norm(g::sub(off, g::mul(h.axis, g::dot(off, h.axis)))) > tol {
                continue;
            }
            let s0 = g::dot(g::sub(g::lin(o, &[(t0, a)]), h.origin), h.axis);
            let s1 = g::dot(g::sub(g::lin(o, &[(t1, a)]), h.origin), h.axis);
            let (lo, hi) = (s0.min(s1), s0.max(s1));
            if lo <= h.t1 + tol && hi >= h.t0 - tol {
                h.t0 = h.t0.min(lo);
                h.t1 = h.t1.max(hi);
                merged = true;
                break;
            }
        }
        if !merged {
            holes.push(c);
        }
    }
    Ok(holes)
}

/// Whether the hole continues into air past one end.
pub fn end_is_open(shape: &Shape, hole: &Hole, at_start: bool, probe: f64) -> bool {
    let t = if at_start { hole.t0 - probe } else { hole.t1 + probe };
    !g::inside(shape, g::lin(hole.origin, &[(t, hole.axis)]))
}

fn circle_of_wire(wire: &Shape) -> Option<(V, f64)> {
    let mut found: Option<(V, f64)> = None;
    let mut n = 0;
    for e in wire.edges() {
        let Curve::Circle(c) = e.curve() else {
            return None;
        };
        match found {
            None => found = Some((c.center, c.radius)),
            Some((cc, rr)) => {
                if g::norm(g::sub(c.center, cc)) > 1e-4 || (c.radius - rr).abs() > 1e-4 {
                    return None;
                }
            }
        }
        n += 1;
    }
    if n > 0 {
        found
    } else {
        None
    }
}

/// (normal out of the material, a point on the plane) for a planar face.
pub fn plane_of(face: &Shape) -> Option<(V, V)> {
    match face.surface() {
        Surface::Plane(p) => Some((g::unit(p.normal), p.origin)),
        _ => None,
    }
}

/// (center, radius) of every inner loop of a face that is a full circle.
pub fn circular_openings(face: &Shape) -> Vec<(V, f64)> {
    face.inner_wires().iter().filter_map(circle_of_wire).collect()
}
