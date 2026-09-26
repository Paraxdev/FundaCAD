//! A sketch pattern copies an entity as drawn, a rotated rectangle included,
//! so the build agrees with the preview (src/sketch/pattern.ts).

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use serde_json::json;

/// The corners of a `w` x `h` rectangle at (`x`,`y`) turned `deg` about its
/// centre, rectCorners in src/sketch/region.ts.
fn corners(w: f64, h: f64, x: f64, y: f64, deg: f64) -> [[f64; 2]; 4] {
    let (s, c) = deg.to_radians().sin_cos();
    [
        [-w / 2.0, -h / 2.0],
        [w / 2.0, -h / 2.0],
        [w / 2.0, h / 2.0],
        [-w / 2.0, h / 2.0],
    ]
    .map(|[lx, ly]| [x + lx * c - ly * s, y + lx * s + ly * c])
}

#[test]
fn a_rectangular_pattern_of_a_rotated_rectangle_repeats_it_rotated() {
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "id": "r", "width": 20, "height": 6, "x": 0, "y": 0, "angle": 30},
        ], "patterns": [
            {"type": "patternRect", "id": "p", "sources": ["r"], "countX": 3, "countY": 1, "spacingX": 40, "spacingY": 0},
        ]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"},
    ]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(
        r.errors.is_empty(),
        "{:?}",
        r.errors.iter().map(|e| &e.message).collect::<Vec<_>>()
    );
    assert_eq!(r.bodies.len(), 1, "one extrude, one body");
    let shape = &r.bodies[0].shape;
    let v = kernel::volume(shape);
    assert!((v - 3.0 * 20.0 * 6.0 * 5.0).abs() < 1e-6 * v, "volume {v}");
    #[allow(clippy::cast_precision_loss)]
    let c: Vec<[f64; 2]> = (0..3)
        .flat_map(|i| corners(20.0, 6.0, 40.0 * i as f64, 0.0, 30.0))
        .collect();
    let lo = |k: usize| c.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min);
    let hi = |k: usize| c.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max);
    let want = [lo(0), lo(1), 0.0, hi(0), hi(1), 5.0];
    let got = kernel::bbox(shape).expect("a box");
    for k in 0..6 {
        assert!(
            (got[k] - want[k]).abs() < 1e-6,
            "box {got:?}, want {want:?}"
        );
    }
}
