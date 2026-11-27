use glam::Vec3;

use super::scene::Scene;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub body: usize,
    pub face: u32,
    pub point: Vec3,
    /// The surface normal at the hit, as the mesh gives it (outward for engine bodies).
    pub normal: Vec3,
}

/// The nearest triangle the ray crosses, from either side.
pub fn pick(scene: &Scene, origin: Vec3, dir: Vec3) -> Option<Hit> {
    pick_kept(scene, origin, dir, |_| true)
}

/// The nearest hit at a point `keep` allows, so a click goes through what a Section cuts away.
pub fn pick_kept(scene: &Scene, origin: Vec3, dir: Vec3, keep: impl Fn(Vec3) -> bool) -> Option<Hit> {
    pick_where(scene, origin, dir, |_| true, keep)
}

/// `pick_kept` over the bodies `allow` takes.
pub fn pick_where(
    scene: &Scene,
    origin: Vec3,
    dir: Vec3,
    allow: impl Fn(usize) -> bool,
    keep: impl Fn(Vec3) -> bool,
) -> Option<Hit> {
    let mut best: Option<(f32, Hit)> = None;
    for (bi, body) in scene.bodies.iter().enumerate().filter(|(i, _)| allow(*i)) {
        for tri in body.indices.chunks_exact(3) {
            let [a, b, c] = [tri[0], tri[1], tri[2]].map(|i| &body.vertices[i as usize]);
            let Some((t, u, v)) = intersect(origin, dir, a.position(), b.position(), c.position()) else {
                continue;
            };
            if best.as_ref().is_some_and(|(d, _)| *d <= t) || !keep(origin + dir * t) {
                continue;
            }
            let normal = (a.normal() * (1.0 - u - v) + b.normal() * u + c.normal() * v).normalize_or_zero();
            best = Some((t, Hit { body: bi, face: a.face, point: origin + dir * t, normal }));
        }
    }
    best.map(|(_, hit)| hit)
}

/// Möller and Trumbore: ray distance and barycentrics.
fn intersect(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Option<(f32, f32, f32)> {
    let (e1, e2) = (b - a, c - a);
    let p = d.cross(e2);
    let det = e1.dot(p);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = 1.0 / det;
    let s = o - a;
    let u = s.dot(p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(e1);
    let v = d.dot(q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = e2.dot(q) * inv;
    (t > 0.0).then_some((t, u, v))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::viewport::scene::tests::block;

    #[test]
    fn hits_the_near_face_of_a_block() {
        let mut scene = Scene::default();
        scene.set(&[Arc::new(block(Vec3::ZERO, Vec3::new(10.0, 10.0, 5.0), "ex1"))]);
        let hit = pick(&scene, Vec3::new(3.0, 4.0, 50.0), -Vec3::Z).unwrap();
        assert_eq!(hit.face, 5);
        assert!((hit.point - Vec3::new(3.0, 4.0, 5.0)).length() < 1e-4);
        assert_eq!(hit.normal, Vec3::Z);
        assert!(pick(&scene, Vec3::new(30.0, 4.0, 50.0), -Vec3::Z).is_none());
    }
}
