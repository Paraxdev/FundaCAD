use std::collections::HashSet;

use glam::{IVec3, Vec3};

use super::scene::{SceneBody, Vertex};

/// Faces whose normals are this close to the push axis count as caps.
const PARALLEL: f32 = 0.999;

/// Where along the line `anchor + axis * t` the ray passes closest. None when the ray runs along the line.
pub fn axis_travel(anchor: Vec3, axis: Vec3, origin: Vec3, dir: Vec3) -> Option<f32> {
    let b = axis.dot(dir);
    let denom = 1.0 - b * b;
    if denom < 1e-4 {
        return None;
    }
    let w = anchor - origin;
    Some((b * dir.dot(w) - axis.dot(w)) / denom)
}

/// The plane, as an offset along `axis`, of the cap made by `owner` facing `axis` nearest to `near`.
pub fn cap_plane(body: &SceneBody, owner: &str, axis: Vec3, near: f32) -> Option<f32> {
    body.vertices
        .iter()
        .filter(|v| v.normal().dot(axis) > PARALLEL && body.owner(v.face) == Some(owner))
        .map(|v| v.position().dot(axis))
        .min_by(|a, b| (a - near).abs().total_cmp(&(b - near).abs()))
}

/// 1 for every vertex that rides with the cap at `plane`: the caps `owner` made facing `axis`, and the wall vertices
/// on their edges. Other features' faces on the same plane stay put, walls included.
pub fn stretch_mask(body: &SceneBody, owner: &str, axis: Vec3, plane: f32, tolerance: f32) -> Vec<f32> {
    let on_plane = |v: &Vertex| (v.position().dot(axis) - plane).abs() <= tolerance;
    let is_cap = |v: &Vertex| v.normal().dot(axis) > PARALLEL && body.owner(v.face) == Some(owner);
    let key = |p: Vec3| (p / tolerance.max(1e-6)).round().as_ivec3();
    let edge: HashSet<IVec3> =
        body.vertices.iter().filter(|v| on_plane(v) && is_cap(v)).map(|v| key(v.position())).collect();
    body.vertices
        .iter()
        .map(|v| {
            let wall = v.normal().dot(axis).abs() < PARALLEL && edge.contains(&key(v.position()));
            if on_plane(v) && (is_cap(v) || wall) {
                1.0
            } else {
                0.0
            }
        })
        .collect()
}

/// The cap `owner` made facing `axis`, if one sits within `tolerance` of `expected`, and the mask that stretches it.
/// With `mirror`, the sketch origin of a symmetric extrude, the opposite cap rides the other way (-1).
pub fn cap(
    body: &SceneBody,
    owner: &str,
    axis: Vec3,
    expected: f32,
    mirror: Option<Vec3>,
    tolerance: f32,
) -> Option<(f32, Vec<f32>)> {
    let plane = cap_plane(body, owner, axis, expected).filter(|p| (p - expected).abs() <= tolerance)?;
    let mut mask = stretch_mask(body, owner, axis, plane, tolerance * 0.1);
    if let Some(origin) = mirror {
        let back = plane - 2.0 * origin.dot(axis);
        if let Some(bp) = cap_plane(body, owner, -axis, back).filter(|p| (p - back).abs() <= tolerance) {
            for (m, b) in mask.iter_mut().zip(stretch_mask(body, owner, -axis, bp, tolerance * 0.1)) {
                *m -= b;
            }
        }
    }
    Some((plane, mask))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::viewport::scene::tests::block;

    #[test]
    fn travel_is_the_closest_point_on_the_axis() {
        let t = axis_travel(Vec3::ZERO, Vec3::Z, Vec3::new(5.0, 0.0, 3.0), -Vec3::X).unwrap();
        assert!((t - 3.0).abs() < 1e-6);
        assert!(axis_travel(Vec3::ZERO, Vec3::Z, Vec3::new(0.0, 0.0, 9.0), -Vec3::Z).is_none());
    }

    #[test]
    fn the_top_cap_and_its_wall_edges_ride() {
        let body = SceneBody::new(Arc::new(block(Vec3::ZERO, Vec3::new(10.0, 10.0, 5.0), "ex1")));
        assert_eq!(cap_plane(&body, "ex1", Vec3::Z, 0.0), Some(5.0));
        assert_eq!(cap_plane(&body, "other", Vec3::Z, 0.0), None);
        let mask = stretch_mask(&body, "ex1", Vec3::Z, 5.0, 1e-4);
        for (v, m) in body.vertices.iter().zip(&mask) {
            assert_eq!(*m == 1.0, v.position().z == 5.0, "{v:?}");
        }
        let foreign = stretch_mask(&body, "other", Vec3::Z, 5.0, 1e-4);
        let cap = body.vertices.iter().zip(&foreign).filter(|(v, _)| v.face == 5);
        assert!(cap.into_iter().all(|(_, m)| *m == 0.0));
    }

    #[test]
    fn walls_of_another_feature_on_the_cap_plane_stay() {
        let mut tall = block(Vec3::ZERO, Vec3::new(10.0, 10.0, 5.0), "ex1");
        let other = block(Vec3::new(20.0, 0.0, 0.0), Vec3::new(30.0, 10.0, 5.0), "ex2");
        let base = tall.positions.len() as u32 / 3;
        tall.positions.extend(&other.positions);
        tall.normals.as_mut().unwrap().extend(other.normals.as_ref().unwrap());
        tall.indices.extend(other.indices.iter().map(|i| i + base));
        let faces = tall.face_owners.len() as u32;
        tall.face_ids.extend(other.face_ids.iter().map(|f| f + faces));
        tall.face_owners.extend(other.face_owners.iter().cloned());
        let body = SceneBody::new(Arc::new(tall));
        let mask = stretch_mask(&body, "ex1", Vec3::Z, 5.0, 1e-4);
        for (v, m) in body.vertices.iter().zip(&mask) {
            assert_eq!(*m == 1.0, v.position().z == 5.0 && v.position().x <= 10.0, "{v:?}");
        }
    }

    #[test]
    fn a_symmetric_cap_pulls_its_mirror_the_other_way() {
        let body = SceneBody::new(Arc::new(block(Vec3::new(0.0, 0.0, -5.0), Vec3::new(10.0, 10.0, 5.0), "ex1")));
        assert!(cap(&body, "ex1", Vec3::Z, 4.0, None, 1e-3).is_none());
        let (plane, mask) = cap(&body, "ex1", Vec3::Z, 5.0, Some(Vec3::ZERO), 1e-3).unwrap();
        assert_eq!(plane, 5.0);
        for (v, m) in body.vertices.iter().zip(&mask) {
            assert_eq!(*m, v.position().z / 5.0, "{v:?}");
        }
        let (_, one) = cap(&body, "ex1", Vec3::Z, 5.0, None, 1e-3).unwrap();
        assert!(one.iter().all(|m| *m >= 0.0));
    }
}
