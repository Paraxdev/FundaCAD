use fundacad_client::Body;
use glam::{Vec2, Vec3};

use super::*;

fn body(points: &[[f32; 3]], counts: &[u32]) -> Body {
    let mut b = Body::default();
    b.edges.points = points.iter().flatten().copied().collect();
    b.edges.counts = counts.to_vec();
    b
}

#[test]
fn splits_the_flat_array_by_count() {
    let b = body(&[[1., 2., 3.], [4., 2., 3.], [7., -1., 0.5], [7., 5., 0.5], [9., 5., 0.5]], &[2, 3]);
    assert_eq!(
        polylines(&b),
        vec![
            vec![Vec3::new(1., 2., 3.), Vec3::new(4., 2., 3.)],
            vec![Vec3::new(7., -1., 0.5), Vec3::new(7., 5., 0.5), Vec3::new(9., 5., 0.5)],
        ]
    );
    assert!(polylines(&body(&[], &[])).is_empty());
}

#[test]
fn a_count_past_the_points_stops_there() {
    let b = body(&[[1., 2., 3.], [4., 2., 3.]], &[2, 4]);
    assert_eq!(polylines(&b).len(), 1);
}

#[test]
fn the_midpoint_is_halfway_by_length() {
    let bent = [Vec3::new(3., 1., 2.), Vec3::new(3., 7., 2.), Vec3::new(5., 7., 2.)];
    assert!(midpoint(&bent).unwrap().abs_diff_eq(Vec3::new(3., 5., 2.), 1e-5));
    assert_eq!(midpoint(&[Vec3::new(2., -1., 4.)]), Some(Vec3::new(2., -1., 4.)));
    assert_eq!(midpoint(&[]), None);
}

#[test]
fn takes_the_nearest_edge_within_reach() {
    // Screen is the world's x and y, z behind the camera when negative.
    let project = |p: Vec3| (p.z >= 0.0).then(|| Vec2::new(p.x, p.y));
    let lines = vec![
        vec![Vec3::new(10., 10., 1.), Vec3::new(30., 10., 1.)],
        vec![Vec3::new(10., 14., 1.), Vec3::new(30., 14., 1.)],
        vec![Vec3::new(20., 12., -1.), Vec3::new(21., 12., -1.)],
    ];
    let near = |x: f32, y: f32| nearest(&lines, project, Vec2::new(x, y), 6.);
    assert_eq!(near(17., 13.), Some(Near { edge: 1, distance: 1.0, point: Vec3::new(17., 14., 1.) }));
    assert_eq!(near(17., 11.), Some(Near { edge: 0, distance: 1.0, point: Vec3::new(17., 10., 1.) }));
    assert_eq!(nearest(&lines, project, Vec2::new(17., 30.), 6.), None);
    assert_eq!(nearest(&[], project, Vec2::new(17., 13.), 6.), None);
}

#[test]
fn a_straight_edge_gives_its_direction_and_a_bent_one_none() {
    let v = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
    assert_eq!(straight(&[v(2.0, -1.0, 5.0), v(2.0, 3.0, 8.0)]), Some(v(0.0, 0.8, 0.6)));
    assert_eq!(straight(&[v(3.0, 1.0, -2.0), v(5.0, 1.0, -2.0), v(9.0, 1.0, -2.0)]), Some(v(1.0, 0.0, 0.0)));
    assert_eq!(straight(&[v(3.0, 1.0, -2.0), v(5.0, 1.5, -2.0), v(9.0, 1.0, -2.0)]), None);
    assert_eq!(straight(&[v(3.0, 1.0, -2.0), v(3.0, 1.0, -2.0)]), None);
    assert_eq!(straight(&[v(3.0, 1.0, -2.0)]), None);
    assert_eq!(straight(&[]), None);
}
