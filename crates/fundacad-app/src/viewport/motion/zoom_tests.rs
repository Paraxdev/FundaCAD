use glam::Vec3;

use super::{pinch_log, zoom_about, zoom_log};
use crate::viewport::camera::Camera;

#[test]
fn a_wheel_sweep_is_held_and_a_bad_one_does_nothing() {
    assert_eq!(zoom_log(1000.0), zoom_log(240.0));
    assert!(zoom_log(-20.0) < 0.0);
    assert_eq!(zoom_log(f32::NAN), 0.0);
}

#[test]
fn a_pinch_zooms_by_its_own_scale() {
    assert!((pinch_log(0.1) - 1.1f32.ln()).abs() < 1e-6);
    assert!(pinch_log(-0.1) < 0.0);
    assert!(pinch_log(-5.0).is_finite());
    assert_eq!(pinch_log(f32::NAN), 0.0);
}

#[test]
fn a_zoom_about_a_surface_keeps_it_still_and_slows_onto_it() {
    let mut cam = Camera { target: Vec3::ZERO, yaw: 0.0, pitch: 0.0, distance: 10.0 };
    let anchor = Vec3::new(6.0, 1.0, 0.5);
    let dir = (anchor - cam.eye()).normalize();
    let mut steps = Vec::new();
    for _ in 0..5 {
        let before = cam.eye().distance(anchor);
        zoom_about(&mut cam, anchor, 0.3);
        let after = cam.eye().distance(anchor);
        assert!(((anchor - cam.eye()).normalize() - dir).length() < 1e-4);
        steps.push(before - after);
    }
    assert!(steps.windows(2).all(|w| w[1] < w[0]), "{steps:?}");
}

#[test]
fn a_zoom_in_stops_short_of_the_anchor() {
    let mut cam = Camera::default();
    let anchor = cam.target;
    for _ in 0..200 {
        zoom_about(&mut cam, anchor, 2.0);
    }
    assert!(cam.distance >= 1e-3 * 0.999 && cam.distance.is_finite());
    zoom_about(&mut cam, anchor, -2.0);
    assert!(cam.distance > 1e-3);
}
