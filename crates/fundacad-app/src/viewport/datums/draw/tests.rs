use glam::Vec3;

use super::*;

fn view() -> View {
    View::new(&Camera { target: Vec3::ZERO, yaw: 0.0, pitch: 0.0, distance: 10.0 }, 500.0)
}

#[test]
fn a_pixel_grows_with_the_depth() {
    let v = view();
    let cam = Camera { target: Vec3::ZERO, yaw: 0.0, pitch: 0.0, distance: 10.0 };
    assert!((v.px(Vec3::ZERO) - cam.per_pixel(500.0)).abs() < 1e-6);
    assert!((v.px(Vec3::new(-10.0, 0.0, 0.0)) - 2.0 * cam.per_pixel(500.0)).abs() < 1e-6);
}

#[test]
fn a_line_is_as_wide_as_asked_and_a_disc_is_round() {
    let v = view();
    let mut out = Vec::new();
    line(&mut out, &v, Vec3::new(0.0, 0.0, -1.0), Vec3::new(0.0, 0.0, 1.0), 4.0, [1.0; 4]);
    assert_eq!(out.len(), 6);
    let w = Vec3::from(out[2].position).distance(Vec3::from(out[1].position));
    assert!((w - 4.0 * v.px(Vec3::ZERO)).abs() < 1e-5, "{w}");
    out.clear();
    disc(&mut out, &v, Vec3::ZERO, 5.0, [1.0; 4]);
    assert_eq!(out.len(), 36);
    assert!(out.iter().all(|p| {
        let d = Vec3::from(p.position).length();
        d < 1e-6 || (d - 5.0 * v.px(Vec3::ZERO)).abs() < 1e-5
    }));
}

#[test]
fn a_dashed_line_stops_at_its_end_and_its_dashes_are_capped() {
    let v = view();
    let mut out = Vec::new();
    let (a, b) = (Vec3::new(0.0, -1.0, 0.0), Vec3::new(0.0, 1.0, 0.0));
    dashed(&mut out, &v, a, b, 1.0, 8.0, 4.0, [1.0; 4]);
    assert!(out.iter().all(|p| p.position[1] <= 1.0 + 1e-5));
    out.clear();
    dashed(&mut out, &v, a * 1e6, b * 1e6, 1.0, 8.0, 4.0, [1.0; 4]);
    assert!(out.len() <= 401 * 6, "{}", out.len());
}

#[test]
fn a_hex_colour_is_linear_with_its_alpha() {
    assert_eq!(linear(0xffffff, 0.5), [1.0, 1.0, 1.0, 0.5]);
    assert_eq!(linear(0x000000, 1.0), [0.0, 0.0, 0.0, 1.0]);
}
