//! ptb_edges.py: elephant-foot chamfer and vertical edge fillet, each finding
//! its own edges from the body and the build direction.

use crate::fundacad::plugin::types::Curve;
use crate::g::{self, py_g, V};
use crate::read::plane_of;
use crate::{feature, kernel, Shape, F};

const VERTICAL_TOL_DEG: f64 = 1.0;
const SMOOTH_EDGE_DEG: f64 = 1.0;

fn bottom_faces(shape: &Shape, bdir: V, label: &str) -> Result<Vec<Shape>, String> {
    let mut hits = Vec::new();
    for fc in shape.faces() {
        let Some((n, p)) = plane_of(&fc) else {
            continue;
        };
        if g::dot(n, bdir) < -0.999 {
            hits.push((g::dot(p, bdir), fc));
        }
    }
    if hits.is_empty() {
        return Err(format!("{label}: no face of this body faces opposite the build direction"));
    }
    let zmin = hits.iter().map(|h| h.0).fold(f64::INFINITY, f64::min);
    Ok(hits.into_iter().filter(|(z, _)| *z <= zmin + 1e-4).map(|(_, f)| f).collect())
}

fn edge_key(e: &Shape) -> Option<(i64, i64, i64)> {
    let p = e.point_at(0.5).or_else(|| e.center())?;
    let r = |x: f64| (x * 1e4).round_ties_even() as i64;
    Some((r(p.0), r(p.1), r(p.2)))
}

fn bottom_edges(shape: &Shape, bdir: V, label: &str) -> Result<Vec<Shape>, String> {
    let mut seen: Vec<((i64, i64, i64), Shape)> = Vec::new();
    for fc in bottom_faces(shape, bdir, label)? {
        let Some(w) = fc.outer_wire() else {
            continue;
        };
        for e in w.edges() {
            let Some(k) = edge_key(&e) else {
                continue;
            };
            if !seen.iter().any(|(s, _)| *s == k) {
                seen.push((k, e));
            }
        }
    }
    if seen.is_empty() {
        return Err(format!("{label}: the lowest face has no edges to chamfer"));
    }
    Ok(seen.into_iter().map(|(_, e)| e).collect())
}

fn into_face(mid: V, n: V, t: V, center: V) -> Option<V> {
    let w = g::cross(t, n);
    if g::norm(w) < 1e-9 {
        return None;
    }
    let to_center = g::sub(center, mid);
    let w = if g::dot(w, to_center) < 0.0 { g::mul(w, -1.0) } else { w };
    Some(g::unit(w))
}

/// Whether the chord between the two faces at the edge stays in material.
fn is_convex(shape: &Shape, edge: &Shape, probe: f64, label: &str) -> Result<bool, String> {
    let faces = shape.faces_of_edge(edge);
    if faces.len() != 2 {
        return Err(format!("{label} failed (SectionBlendError)"));
    }
    let (Some(mid), Some(t)) = (edge.point_at(0.5), edge.tangent_at(0.5)) else {
        return Ok(true);
    };
    let side = |fc: &Shape| -> Option<V> { into_face(mid, fc.normal_at(mid)?, t, fc.center()?) };
    let (Some(w1), Some(w2)) = (side(&faces[0]), side(&faces[1])) else {
        return Ok(true);
    };
    let a = g::lin(mid, &[(probe, w1)]);
    let b = g::lin(mid, &[(probe, w2)]);
    Ok(g::inside(shape, g::mul(g::add(a, b), 0.5)))
}

fn sign_normalize(d: V) -> V {
    for c in [d.0, d.1, d.2] {
        if c.abs() > 1e-9 {
            return if c < 0.0 { g::mul(d, -1.0) } else { d };
        }
    }
    d
}

fn vertical_edges(shape: &Shape, bdir: V, only_convex: bool, radius: f64, label: &str) -> Result<Vec<Shape>, String> {
    let cos_tol = VERTICAL_TOL_DEG.to_radians().cos();
    let probe = (0.1 * radius).max(0.01);
    let mut out = Vec::new();
    for e in shape.edges() {
        if !matches!(e.curve(), Curve::Line(_)) {
            continue;
        }
        let d = match e.tangent_at(0.5) {
            Some(t) => sign_normalize(g::unit(t)),
            None => (0.0, 0.0, 0.0),
        };
        if g::dot(d, bdir).abs() < cos_tol {
            continue;
        }
        match shape.dihedral_deg(&e) {
            Some(dh) if dh >= SMOOTH_EDGE_DEG => {}
            _ => continue,
        }
        if only_convex && !is_convex(shape, &e, probe, label)? {
            continue;
        }
        out.push(e);
    }
    if out.is_empty() {
        return Err(format!("{label}: no edges run parallel to the build direction on this body"));
    }
    Ok(out)
}

fn record_skips(verb: &str, total: usize, skipped: u32) {
    if skipped == 0 {
        return;
    }
    let entry = serde_json::json!({
        "kind": "edgeOpFailed",
        "reason": format!("{skipped} of {total} edges could not be {verb}ed and were skipped"),
        "resolved": total - skipped as usize,
        "confidence": 0.5,
        "lossy": true,
    });
    feature::diagnostic(&entry.to_string());
}

pub fn elephant_foot_chamfer(f: &F) -> Result<(), String> {
    let label = "Elephant-foot chamfer";
    let size = f.num("size", 0.4)?;
    if !(0.01..=20.0).contains(&size) {
        return Err(format!(
            "{label}: the chamfer size must be between 0.01 and 20 mm (got {})",
            py_g(size)
        ));
    }
    let bdir = g::build_dir(f, label)?;
    for body in feature::target_bodies("bodies", label)? {
        let shape = feature::body_shape(body)?;
        let edges = bottom_edges(&shape, bdir, label)?;
        let refs: Vec<&Shape> = edges.iter().collect();
        let out = kernel::chamfer(&shape, &refs, size, size, true).map_err(|e| format!("{label}: {e}"))?;
        feature::set_body_shape(body, &out.shape)?;
        record_skips("chamfer", edges.len(), out.skipped);
    }
    Ok(())
}

pub fn vertical_fillet(f: &F) -> Result<(), String> {
    let label = "Vertical edge fillet";
    let radius = f.num("radius", 2.0)?;
    if !(0.01..=100.0).contains(&radius) {
        return Err(format!(
            "{label}: the radius must be between 0.01 and 100 mm (got {})",
            py_g(radius)
        ));
    }
    let bdir = g::build_dir(f, label)?;
    let only_convex = f.flag("onlyConvex");
    for body in feature::target_bodies("bodies", label)? {
        let shape = feature::body_shape(body)?;
        let edges = vertical_edges(&shape, bdir, only_convex, radius, label)?;
        let refs: Vec<&Shape> = edges.iter().collect();
        let out = kernel::fillet(&shape, &refs, radius, true).map_err(|e| format!("{label}: {e}"))?;
        feature::set_body_shape(body, &out.shape)?;
        record_skips("fillet", edges.len(), out.skipped);
    }
    Ok(())
}
