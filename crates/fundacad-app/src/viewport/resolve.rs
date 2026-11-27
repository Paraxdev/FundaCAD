//! Finds the face, edge or body a stored target means on the current build, by the point a `nearest` selector keeps.

#[cfg(test)]
mod tests;

use glam::Vec3;
use serde_json::Value;

use super::edges;
use super::scene::Scene;
use crate::selection::Pick;

pub fn resolve(scene: &Scene, lines: &[Vec<Vec<Vec3>>], entry: &Value) -> Option<Pick> {
    if let Some(id) = entry.as_str() {
        return scene.body_index(id).map(|_| Pick::Body { body: id.into() });
    }
    let body = entry.get("body")?.as_str()?;
    let at = entry.get("point")?.as_array()?;
    let at: Vec<f32> = at.iter().filter_map(Value::as_f64).map(|c| c as f32).collect();
    let at = Vec3::from_slice(at.get(..3)?);
    let bi = scene.body_index(body)?;
    match entry.get("kind")?.as_str()? {
        "edge" => {
            let (edge, _) = lines.get(bi)?.iter().enumerate().map(|(i, l)| (i, line_distance(l, at))).min_by(|a, b| a.1.total_cmp(&b.1))?;
            let mid = edges::midpoint(&lines[bi][edge])?;
            let dir = edges::straight(&lines[bi][edge]).map(|d| d.to_array());
            Some(Pick::Edge { body: body.into(), edge: edge as u32, mid: mid.to_array(), dir })
        }
        "face" => {
            let b = &scene.bodies[bi];
            let mut best: Option<(f32, u32, Vec3)> = None;
            for tri in b.indices.chunks_exact(3) {
                let [p, q, r] = [0, 1, 2].map(|k| b.vertices[tri[k] as usize].position());
                let d = closest_on_triangle(at, p, q, r).distance(at);
                if best.is_none_or(|(bd, ..)| d < bd) {
                    best = Some((d, b.vertices[tri[0] as usize].face, (q - p).cross(r - p)));
                }
            }
            let (_, face, n) = best?;
            Some(Pick::Face { body: body.into(), face, point: at.to_array(), normal: n.normalize_or_zero().to_array() })
        }
        _ => None,
    }
}

fn line_distance(line: &[Vec3], at: Vec3) -> f32 {
    line.windows(2)
        .map(|s| {
            let d = s[1] - s[0];
            let t = if d.length_squared() > 0.0 { ((at - s[0]).dot(d) / d.length_squared()).clamp(0.0, 1.0) } else { 0.0 };
            (s[0] + d * t).distance(at)
        })
        .fold(f32::INFINITY, f32::min)
}

/// Ericson's closest point on a triangle.
fn closest_on_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
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
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
    }
    let denom = 1.0 / (va + vb + vc);
    a + ab * (vb * denom) + ac * (vc * denom)
}
