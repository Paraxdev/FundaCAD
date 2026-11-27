use std::sync::Arc;

use super::{circle, hole, placement, Hit, Placement, SceneBody};
use glam::{Vec2, Vec3};
use serde_json::json;
use crate::viewport::scene::tests::block;
use crate::viewport::scene::Body;

/// A round wall about `centre` along `axis` from 0 to `depth`, `turn` of a full circle of it, as face 0, its normals
/// toward the axis when `hole`.
fn wall(centre: Vec3, axis: Vec3, r: f32, depth: f32, turn: f32, hole: bool) -> SceneBody {
    let u = axis.any_orthonormal_vector();
    let w = axis.cross(u);
    let (mut positions, mut normals, mut indices) = (Vec::new(), Vec::new(), Vec::new());
    let steps = 24;
    for i in 0..=steps {
        let a = turn * std::f32::consts::TAU * i as f32 / steps as f32;
        let out = u * a.cos() + w * a.sin();
        for z in [0.0, depth] {
            positions.extend((centre + out * r + axis * z).to_array());
            normals.extend((if hole { -out } else { out }).to_array());
        }
        if i < steps {
            let b = 2 * i;
            indices.extend([b, b + 2, b + 3, b, b + 3, b + 1]);
        }
    }
    let tris = indices.len() / 3;
    SceneBody::new(Arc::new(Body {
        positions,
        normals: Some(normals),
        indices,
        face_ids: vec![0; tris],
        face_owners: vec![Some("ex1".into())],
        ..Default::default()
    }))
}

fn close(a: Vec3, b: Vec3) -> bool {
    a.distance(b) < 1e-3
}

#[test]
fn a_hole_seats_on_its_rim_along_its_axis() {
    let body = wall(Vec3::new(5.0, 5.0, 0.0), Vec3::Z, 2.5, 10.0, 1.0, true);
    let p = hole(&body, 0, -Vec3::Z).unwrap();
    assert!(close(p.origin, Vec3::new(5.0, 5.0, 10.0)), "{p:?}");
    assert!(close(p.z, Vec3::Z), "{p:?}");
    let below = hole(&body, 0, Vec3::Z).unwrap();
    assert!(close(below.origin, Vec3::new(5.0, 5.0, 0.0)) && close(below.z, -Vec3::Z), "{below:?}");
}

#[test]
fn a_tilted_half_hole_still_finds_its_axis() {
    let axis = Vec3::new(1.0, 0.0, 1.0).normalize();
    let body = wall(Vec3::new(1.0, 2.0, 3.0), axis, 4.0, 6.0, 0.5, true);
    let p = hole(&body, 0, -axis).unwrap();
    assert!(close(p.z, axis) && close(p.origin, Vec3::new(1.0, 2.0, 3.0) + axis * 6.0), "{p:?}");
}

#[test]
fn bosses_fillets_and_flat_faces_are_no_hole() {
    assert!(hole(&wall(Vec3::ZERO, Vec3::Z, 3.0, 5.0, 1.0, false), 0, -Vec3::Z).is_none());
    assert!(hole(&wall(Vec3::ZERO, Vec3::Z, 3.0, 5.0, 0.25, true), 0, -Vec3::Z).is_none());
    let flat = SceneBody::new(Arc::new(block(Vec3::ZERO, Vec3::new(10.0, 10.0, 5.0), "ex1")));
    assert!(hole(&flat, 5, -Vec3::Z).is_none());
}

#[test]
fn a_flat_face_takes_the_point_and_its_normal() {
    let body = SceneBody::new(Arc::new(block(Vec3::ZERO, Vec3::new(10.0, 10.0, 5.0), "ex1")));
    let hit = Hit { body: 0, face: 3, point: Vec3::new(2.0, 10.0, 1.0), normal: Vec3::Y };
    assert_eq!(placement(&body, &hit, -Vec3::Y), Placement { origin: hit.point, z: Vec3::Y });
}

#[test]
fn the_engine_reads_origin_and_z_axis() {
    let p = Placement { origin: Vec3::new(1.0, -0.0, 2.123456), z: Vec3::Z };
    assert_eq!(p.json(), json!({"origin": [1.0, 0.0, 2.1235], "zAxis": [0.0, 0.0, 1.0]}));
}

#[test]
fn the_circle_fit_is_exact_on_a_circle() {
    let pts: Vec<Vec2> = (0..7).map(|i| Vec2::new(3.0, -1.0) + Vec2::from_angle(i as f32 * 0.4) * 2.0).collect();
    let (c, r) = circle(&pts).unwrap();
    assert!(c.distance(Vec2::new(3.0, -1.0)) < 1e-4 && (r - 2.0).abs() < 1e-4, "{c} {r}");
}
