//! A blend that folded back over itself, blend_overlap.py. BRepCheck passes it, but faces the blend made lie on
//! each other: a coarse triangle counts as doubled within a micron of a near parallel one of another such face.

use std::collections::HashMap;

use glam::DVec3;
use opencascade::primitives::{Shape, ShapeType};

use super::ops;
use crate::kernel::{self, Kind};

const COINCIDENT_MM: f64 = 0.001;
const PARALLEL_DOT: f64 = 0.9995;
const FOLD_AREA_MM2: f64 = 0.01;
/// Coarse on purpose: finer triangles crowd a tangent junction and report it.
const MEASURE_DEFLECTION_MM: f64 = 0.1;

/// Faces of `after` that `before` does not share by identity.
pub fn new_faces(before: &Shape, after: &Shape) -> Vec<Shape> {
    let old = before.shape_map(ShapeType::Face);
    kernel::subshapes(after, Kind::Face).into_iter().filter(|f| old.index_of(f) == 0).collect()
}

/// Anything that cannot be measured is not a fold. The allowance grows with `size` squared, since a fixed
/// 0.01 mm2 refused a 1.13 mm rim round for 0.12 mm2 at a junction the reference CAD model has too.
pub fn folds_over_itself(before: &Shape, after: &Shape, size: f64) -> bool {
    let fresh = crate::bench::phase("blend_new_faces", || new_faces(before, after));
    if fresh.is_empty() {
        return false;
    }
    let allowed = FOLD_AREA_MM2.max(0.25 * size * size);
    doubled_area(&fresh).is_some_and(|a| a > allowed)
}

struct Tri {
    face: usize,
    centre: DVec3,
    normal: DVec3,
    area: f64,
    pts: [DVec3; 3],
}

fn triangles(faces: &[Shape]) -> Option<Vec<Tri>> {
    let flat = ops::face_triangles(faces, MEASURE_DEFLECTION_MM).ok()?;
    let mut out = Vec::with_capacity(flat.len() / 10);
    for t in flat.chunks_exact(10) {
        let p = |i: usize| DVec3::new(t[i], t[i + 1], t[i + 2]);
        let (a, b, c) = (p(1), p(4), p(7));
        let n = (b - a).cross(c - a);
        let ln = n.length();
        if ln <= 0.0 {
            continue;
        }
        out.push(Tri {
            face: t[0] as usize,
            centre: (a + b + c) / 3.0,
            normal: n / ln,
            area: ln / 2.0,
            pts: [a, b, c],
        });
    }
    Some(out)
}

/// Clamped to the triangle: a plane distance calls every tangent junction coincident. Ericson's
/// closest point, one Voronoi region at a time.
fn point_to_triangle(q: DVec3, tri: &[DVec3; 3]) -> f64 {
    let [a, b, c] = *tri;
    let (ab, ac, ap) = (b - a, c - a, q - a);
    let (d1, d2) = (ab.dot(ap), ac.dot(ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return ap.length();
    }
    let bp = q - b;
    let (d3, d4) = (ab.dot(bp), ac.dot(bp));
    if d3 >= 0.0 && d4 <= d3 {
        return bp.length();
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return (ap - ab * (d1 / (d1 - d3))).length();
    }
    let cp = q - c;
    let (d5, d6) = (ab.dot(cp), ac.dot(cp));
    if d6 >= 0.0 && d5 <= d6 {
        return cp.length();
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return (ap - ac * (d2 / (d2 - d6))).length();
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return (bp - (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)))).length();
    }
    let n = ab.cross(ac);
    let ln = n.length();
    if ln <= 0.0 {
        return ap.length();
    }
    n.dot(ap).abs() / ln
}

fn near_the_face(point: DVec3, face: &Shape) -> bool {
    face.distance_to_point(point).is_ok_and(|d| d <= MEASURE_DEFLECTION_MM)
}

fn cell_of(c: DVec3) -> (i64, i64, i64) {
    const CELL: f64 = 0.25;
    ((c.x / CELL).floor() as i64, (c.y / CELL).floor() as i64, (c.z / CELL).floor() as i64)
}

/// `doubled_area`, in mm2.
pub fn doubled_area(faces: &[Shape]) -> Option<f64> {
    crate::bench::phase("doubled_area", || doubled_area_inner(faces))
}

fn doubled_area_inner(faces: &[Shape]) -> Option<f64> {
    let tris = triangles(faces)?;
    let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
    for (i, t) in tris.iter().enumerate() {
        grid.entry(cell_of(t.centre)).or_default().push(i);
    }
    let mut doubled = 0.0;
    for t in &tris {
        let key = cell_of(t.centre);
        let mut hit = false;
        'cells: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(list) = grid.get(&(key.0 + dx, key.1 + dy, key.2 + dz)) else {
                        continue;
                    };
                    for &j in list {
                        let o = &tris[j];
                        if o.face == t.face || t.normal.dot(o.normal).abs() < PARALLEL_DOT {
                            continue;
                        }
                        if point_to_triangle(t.centre, &o.pts) <= COINCIDENT_MM
                            && faces.get(o.face).is_some_and(|f| near_the_face(t.centre, f))
                        {
                            hit = true;
                            break 'cells;
                        }
                    }
                }
            }
        }
        if hit {
            doubled += t.area;
        }
    }
    Some(doubled)
}

#[cfg(test)]
#[path = "overlap_tests.rs"]
mod tests;
