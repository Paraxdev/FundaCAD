use fundacad_mcp::layflat::face_down;

/// n turned the way OCCT composes intrinsic XYZ, which must come out pointing down.
fn turned(n: [f64; 3], (a, b): (f64, f64)) -> [f64; 3] {
    let (a, b) = (a.to_radians(), b.to_radians());
    // Ry(b) first, then Rx(a): R = Rx(a) * Ry(b).
    let y = [n[0] * b.cos() + n[2] * b.sin(), n[1], -n[0] * b.sin() + n[2] * b.cos()];
    [y[0], y[1] * a.cos() - y[2] * a.sin(), y[1] * a.sin() + y[2] * a.cos()]
}

#[test]
fn every_direction_ends_up_pointing_down() {
    let s = 0.5_f64.sqrt();
    for n in [
        [0.0, 0.0, -1.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [-1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, -1.0, 0.0],
        [s, s, 0.0],
        [0.3, -0.4, 0.866],
    ] {
        let r = turned(n, face_down(n));
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        assert!(
            (r[0] / len).abs() < 1e-6 && (r[1] / len).abs() < 1e-6 && (r[2] / len + 1.0).abs() < 1e-6,
            "{n:?} -> {r:?}"
        );
    }
}
