use glam::Vec3;

use super::{zoom_about, zoom_log};
use crate::viewport::camera::Camera;

#[test]
fn a_pinch_zooms_faster_than_a_wheel_and_a_sweep_is_held() {
    assert!(zoom_log(10.0, true) > zoom_log(10.0, false));
    assert_eq!(zoom_log(1000.0, false), zoom_log(240.0, false));
    assert!(zoom_log(-20.0, false) < 0.0);
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
