use glam::Vec3;

use super::{body_cap, cap_quad, hatch, straddles, stretched};

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

#[test]
fn only_a_box_the_plane_runs_through_or_touches_straddles_it() {
    let (min, max) = (Vec3::ZERO, Vec3::ONE);
    assert!(straddles([1.0, 0.0, 0.0, 0.5], min, max));
    assert!(straddles([0.0, 0.0, 1.0, 1.0], min, max));
    assert!(!straddles([0.0, 0.0, 1.0, 2.0], min, max));
    assert!(!straddles([0.0, 0.0, -1.0, 0.5], Vec3::new(0.0, 0.0, 3.0), Vec3::new(1.0, 1.0, 4.0)));
    assert!(straddles([0.0, 0.6, 0.8, 1.0], min, max));
    assert!(!straddles([0.0; 4], min, max));
    assert!(!straddles([1.0, 0.0, 0.0, 0.0], Vec3::INFINITY, Vec3::NEG_INFINITY));
}

#[test]
fn each_body_gets_a_cap_of_its_own_size_or_none() {
    let clip = Some([0.0, 0.0, 1.0, 5.0]);
    let small = body_cap(clip, (Vec3::ZERO, Vec3::splat(10.0)));
    let big = body_cap(clip, (Vec3::splat(-50.0), Vec3::splat(50.0)));
    assert_eq!(&small[..3], &[5.0, 5.0, 5.0]);
    assert!(small[3] > 0.0 && small[3] < big[3]);
    assert_eq!(body_cap(clip, (Vec3::splat(20.0), Vec3::splat(30.0)))[3], 0.0);
    assert_eq!(body_cap(None, (Vec3::ZERO, Vec3::ONE))[3], 0.0);
}

#[test]
fn a_stretch_widens_the_box_the_way_it_moves() {
    let b = stretched((Vec3::ZERO, Vec3::ONE), Vec3::new(0.0, 0.0, 6.0));
    assert_eq!(b, (Vec3::ZERO, Vec3::new(1.0, 1.0, 7.0)));
    assert!(body_cap(Some([0.0, 0.0, 1.0, 5.0]), b)[3] > 0.0);
    let b = stretched((Vec3::ZERO, Vec3::ONE), Vec3::new(-2.0, 0.0, 0.0));
    assert_eq!(b, (Vec3::new(-2.0, 0.0, 0.0), Vec3::ONE));
}
