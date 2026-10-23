use glam::DVec3;

use super::point_to_triangle;

fn to_segment(q: DVec3, a: DVec3, b: DVec3) -> f64 {
    let ab = b - a;
    let t = ((q - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0);
    (q - (a + t * ab)).length()
}

// The plane distance where the foot lands inside the triangle, else the nearest of the three sides.
fn reference(q: DVec3, [a, b, c]: [DVec3; 3]) -> f64 {
    let n = (b - a).cross(c - a).normalize();
    let foot = q - n * n.dot(q - a);
    let inside = [(a, b), (b, c), (c, a)].iter().all(|&(u, v)| (v - u).cross(foot - u).dot(n) >= 0.0);
    if inside {
        return n.dot(q - a).abs();
    }
    to_segment(q, a, b).min(to_segment(q, b, c)).min(to_segment(q, c, a))
}

fn triangles() -> [[DVec3; 3]; 3] {
    [
        [DVec3::new(1.1, 0.2, 0.0), DVec3::new(1.4, -1.1, 0.0), DVec3::new(0.1, 1.8, 0.0)],
        [DVec3::new(3.2, -1.7, 2.4), DVec3::new(7.9, 0.6, 3.1), DVec3::new(4.1, 2.3, 6.7)],
        [DVec3::new(-2.6, 4.4, 1.9), DVec3::new(5.3, 5.1, -0.8), DVec3::new(-1.9, 4.9, 2.6)],
    ]
}

// One point in each region: inside, past each corner, past each side, each lifted off the plane by `h`.
fn probes([a, b, c]: [DVec3; 3], h: f64) -> Vec<DVec3> {
    let n = (b - a).cross(c - a).normalize();
    let g = (a + b + c) / 3.0;
    let mut out = vec![g + n * h, a + 0.2 * (b - a) + 0.3 * (c - a) - n * h];
    for p in [a, b, c] {
        out.push(p + 0.7 * (p - g) + n * h);
    }
    for (u, v) in [(a, b), (b, c), (c, a)] {
        let mid = 0.4 * u + 0.6 * v;
        out.push(mid + 0.9 * (mid - g) + n * h);
    }
    out
}

#[test]
fn point_to_triangle_matches_the_nearest_point_in_every_region() {
    for tri in triangles() {
        for h in [0.0, 0.0005, 0.37, -2.6] {
            for q in probes(tri, h) {
                let (got, want) = (point_to_triangle(q, &tri), reference(q, tri));
                assert!((got - want).abs() < 1e-9, "{tri:?} {q:?}: {got} against {want}");
            }
        }
    }
}

#[test]
fn point_to_triangle_on_known_points() {
    let obtuse = triangles()[0];
    let corner = [DVec3::new(1.0, 1.0, 1.0), DVec3::new(2.0, 1.0, 1.0), DVec3::new(1.0, 2.0, 1.0)];
    let flat = [DVec3::ZERO, DVec3::new(10.0, 0.0, 0.0), DVec3::new(0.0, 10.0, 0.0)];
    let rows = [
        (DVec3::new(0.69, 0.52, 0.0), obtuse, 0.0),
        (DVec3::new(0.69, 0.52, -0.43), obtuse, 0.43),
        (DVec3::new(1.0003, 0.9996, 1.0), corner, 0.0004),
        (DVec3::new(2.0003, 0.9996, 1.0), corner, 0.0005),
        (DVec3::new(1.5, 0.9993, 1.0), corner, 0.0007),
        (DVec3::new(0.3, 0.3, 0.0005), flat, 0.0005),
        (DVec3::new(6.0, 6.0, 0.0), flat, 2.0_f64.sqrt()),
    ];
    let got: Vec<f64> = rows.iter().map(|(q, t, _)| (point_to_triangle(*q, t) * 1e9).round() / 1e9).collect();
    let want: Vec<f64> = rows.iter().map(|r| (r.2 * 1e9).round() / 1e9).collect();
    assert_eq!(got, want);
}
