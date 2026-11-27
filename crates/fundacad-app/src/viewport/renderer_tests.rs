use glam::Vec3;

use super::{cap_quad, hatch};

#[test]
fn the_cap_sits_on_the_plane_and_covers_the_box() {
    let (min, max) = (Vec3::new(-1.0, -2.0, 0.0), Vec3::new(3.0, 2.0, 10.0));
    let q = cap_quad([0.0, 0.0, 2.0, 8.0], min, max);
    assert_eq!(&q[..3], &[1.0, 0.0, 4.0]);
    let corner = Vec3::new(3.0, 2.0, 4.0) - Vec3::new(q[0], q[1], q[2]);
    assert!(q[3] > corner.x.abs().max(corner.y.abs()));
}

#[test]
fn a_plane_off_the_box_still_reaches_over_it() {
    let q = cap_quad([1.0, 0.0, 0.0, 50.0], Vec3::ZERO, Vec3::ONE);
    assert_eq!(&q[..3], &[50.0, 0.5, 0.5]);
    assert!(q[3] > 49.5);
}

#[test]
fn no_plane_or_no_bodies_means_no_cap() {
    assert_eq!(cap_quad([0.0; 4], Vec3::ZERO, Vec3::ONE)[3], 0.0);
    assert_eq!(cap_quad([0.0, 0.0, 1.0, 0.0], Vec3::INFINITY, Vec3::NEG_INFINITY)[3], 0.0);
}

#[test]
fn the_hatch_scales_with_the_window() {
    assert_eq!(&hatch(1.0)[..2], &[9.0, 2.0]);
    assert_eq!(&hatch(2.0)[..2], &[18.0, 4.0]);
    assert_eq!(&hatch(0.0)[..2], &[9.0, 2.0]);
}
