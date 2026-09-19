//! A blend that folded back over itself, the Python engine's `blend_overlap.py`.
//!
//! BRepCheck calls such a solid valid; what is wrong is that faces the blend
//! made lie on top of each other and the depth buffer flickers between them.
//! The faces it made are meshed coarsely and a triangle counts as doubled when
//! its centre lies within a micron of a near parallel triangle of another of
//! those faces that really is that close to its own surface.

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
    kernel::subshapes(after, Kind::Face)
        .into_iter()
        .filter(|f| old.index_of(f) == 0)
        .collect()
}

/// Anything that cannot be measured is not a fold.
///
/// The allowance grows with the blend: a fold runs along an edge, so what it
/// doubles is at least about `size` squared. A fixed 0.01 mm2 refused a
/// 1.13 mm rim round for 0.12 mm2 where it meets two notch rounds, a junction
/// the reference CAD model has too.
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

/// Clamped to the triangle: a plane distance calls every tangent junction coincident.
fn point_to_triangle(q: DVec3, tri: &[DVec3; 3]) -> f64 {
    let [a, b, c] = *tri;
    let (ab, ac, ap) = (b - a, c - a, q - a);
    let (d1, d2) = (ab.dot(ap), ac.dot(ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return (q - a).length();
    }
    let bp = q - b;
    if ab.dot(bp) >= 0.0 && 0.0 >= ac.dot(bp) {
        return (q - b).length();
    }
    let cp = q - c;
    if ac.dot(cp) >= 0.0 && 0.0 >= ab.dot(cp) {
        return (q - c).length();
    }
    let n = ab.cross(ac);
    let ln = n.length();
    if ln <= 0.0 {
        return (q - a).length();
    }
    n.dot(ap).abs() / ln
}

fn near_the_face(point: DVec3, face: &Shape) -> bool {
    face.distance_to_point(point)
        .is_ok_and(|d| d <= MEASURE_DEFLECTION_MM)
}

fn cell_of(c: DVec3) -> (i64, i64, i64) {
    const CELL: f64 = 0.25;
    (
        (c.x / CELL).floor() as i64,
        (c.y / CELL).floor() as i64,
        (c.z / CELL).floor() as i64,
    )
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
                            && faces
                                .get(o.face)
                                .is_some_and(|f| near_the_face(t.centre, f))
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
mod tests {
    use super::*;

    fn face_at_x(s: &Shape, x: f64) -> Shape {
        kernel::subshapes(s, Kind::Face)
            .into_iter()
            .find(|f| kernel::face_area_centre(f).is_some_and(|a| (a[1] - x).abs() < 1e-9))
            .expect("a face at x")
    }

    #[test]
    fn coincident_faces_are_doubled_and_apart_ones_are_not() {
        let a = kernel::make_box(10.0, 10.0, 10.0).unwrap();
        let b = kernel::translated(&a, [10.0, 0.0, 0.0]).unwrap();
        let doubled = doubled_area(&[face_at_x(&a, 5.0), face_at_x(&b, 5.0)]).unwrap();
        assert!((doubled - 200.0).abs() < 1.0, "both sides count, {doubled}");
        let apart = doubled_area(&[face_at_x(&a, 5.0), face_at_x(&b, 15.0)]).unwrap();
        assert_eq!(apart, 0.0);
    }

    #[test]
    fn a_sound_fillet_does_not_fold() {
        let a = kernel::make_box(20.0, 20.0, 10.0).unwrap();
        let edges = kernel::subshapes(&a, Kind::Edge);
        let (out, built) = ops::fillet(&a, &edges, &vec![2.0; edges.len()]).unwrap();
        assert_eq!(built, ops::Built::Done);
        assert!(!new_faces(&a, &out).is_empty());
        assert!(!folds_over_itself(&a, &out, 2.0));
    }
}
