use std::sync::Arc;

use super::{circle, hole, moved, nearest, placement, rim, snaps, Hit, Placement, SceneBody, Snap};
use crate::viewport::scene::tests::block;
use crate::viewport::scene::Body;
use glam::{Vec2, Vec3};
use serde_json::json;

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

#[test]
fn a_round_edge_seats_at_its_centre_toward_the_viewer() {
    let ring: Vec<Vec3> =
        (0..=24).map(|i| Vec3::new(5.0, 5.0, 10.0) + (Vec2::from_angle(i as f32 * 0.2618) * 2.5).extend(0.0)).collect();
    let p = rim(&ring, -Vec3::Z).unwrap();
    assert!(close(p.origin, Vec3::new(5.0, 5.0, 10.0)) && close(p.z, Vec3::Z), "{p:?}");
    assert!(close(rim(&ring, Vec3::Z).unwrap().z, -Vec3::Z));
    assert!(rim(&ring[..5], -Vec3::Z).is_none());
    assert!(rim(&[Vec3::ZERO, Vec3::X, Vec3::X * 2.0], -Vec3::Z).is_none());
}

/// A 10 by 10 by 5 block with the four edges round its top and one up its side.
fn edged() -> SceneBody {
    let mut b = block(Vec3::ZERO, Vec3::new(10.0, 10.0, 5.0), "ex1");
    let top = [[0.0, 0.0, 5.0], [10.0, 0.0, 5.0], [10.0, 10.0, 5.0], [0.0, 10.0, 5.0], [0.0, 0.0, 5.0]];
    for w in top.windows(2) {
        b.edges.points.extend(w[0].iter().chain(&w[1]));
        b.edges.counts.push(2);
    }
    b.edges.points.extend([0.0, 0.0, 0.0, 0.0, 0.0, 5.0]);
    b.edges.counts.push(2);
    SceneBody::new(Arc::new(b))
}

#[test]
fn a_flat_face_snaps_to_its_corners_edge_middles_and_centre() {
    let s = snaps(&edged(), 5);
    let has = |p: Vec3, k: Snap| s.iter().any(|&(q, j)| j == k && close(p, q));
    assert!(has(Vec3::new(5.0, 5.0, 5.0), Snap::Centre));
    assert!(has(Vec3::new(10.0, 10.0, 5.0), Snap::Corner));
    assert!(has(Vec3::new(5.0, 0.0, 5.0), Snap::Middle));
    assert!(!has(Vec3::new(0.0, 0.0, 2.5), Snap::Middle), "the side edge's middle is off the top's plane");
    assert_eq!(s.len(), 1 + 4 * 3 + 1, "the side edge's top end is a corner of the top");
}

#[test]
fn a_round_face_offers_no_snaps() {
    assert!(snaps(&wall(Vec3::ZERO, Vec3::Z, 3.0, 5.0, 1.0, true), 0).is_empty());
}

#[test]
fn the_strongest_snap_in_reach_wins_then_the_nearest() {
    let flat = |p: Vec3| Some(Vec2::new(p.x, p.y));
    let points = [
        (Vec3::new(0.0, 0.0, 0.0), Snap::Centre),
        (Vec3::new(8.0, 0.0, 0.0), Snap::Corner),
        (Vec3::new(3.0, 0.0, 0.0), Snap::Middle),
        (Vec3::new(-4.0, 0.0, 0.0), Snap::Middle),
    ];
    assert_eq!(nearest(&points, flat, Vec2::ZERO, 10.0).map(|s| s.1), Some(Snap::Corner));
    assert_eq!(nearest(&points, flat, Vec2::ZERO, 5.0).map(|s| s.0), Some(Vec3::new(3.0, 0.0, 0.0)));
    assert_eq!(nearest(&points, flat, Vec2::new(30.0, 0.0), 10.0), None);
    assert_eq!(nearest(&points, |_| None, Vec2::ZERO, 10.0), None);
}

#[test]
fn the_ghost_stands_where_the_drag_would_land() {
    let b = block(Vec3::ZERO, Vec3::ONE, "ex1");
    let from = Placement { origin: Vec3::ZERO, z: Vec3::Z };
    let to = Placement { origin: Vec3::new(5.0, 0.0, 0.0), z: Vec3::X };
    let m = moved(&b, from, to);
    let at = |v: &[f32]| (0..v.len() / 3).map(|i| Vec3::from_slice(&v[i * 3..])).collect::<Vec<_>>();
    for (p, q) in at(&b.positions).into_iter().zip(at(&m.positions)) {
        assert!(close(q, Vec3::new(5.0 + p.z, p.y, -p.x)), "{p} went to {q}");
    }
    let top = at(m.normals.as_ref().unwrap())[5 * 4];
    assert!(close(top, Vec3::X), "the +Z face now faces +X, {top}");
    assert_eq!(moved(&b, from, from), b);
}
