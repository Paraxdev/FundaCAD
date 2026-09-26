//! A sketch pattern copies an entity as drawn, keeping its type, so the build
//! agrees with the preview (`translated` and `rotated` in src/sketch/pattern.ts).

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use serde_json::{json, Value};

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

fn build(features: Value) -> Vec<fundacad_geom::builder::BuiltBody> {
    let doc = json!({ "features": features });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(
        r.errors.is_empty(),
        "{:?}",
        r.errors.iter().map(|e| &e.message).collect::<Vec<_>>()
    );
    r.bodies
}

/// Volume and exact box of one extrude of `entities`, with `patterns` if any.
fn extruded(entities: &Value, patterns: Option<Value>) -> (f64, [f64; 6]) {
    let mut sketch = json!({"id": "s", "type": "sketch", "plane": "XY", "entities": entities});
    if let Some(p) = patterns {
        sketch["patterns"] = p;
    }
    let bodies = build(json!([
        sketch,
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"},
    ]));
    assert_eq!(bodies.len(), 1, "one extrude, one body");
    let shape = &bodies[0].shape;
    (kernel::volume(shape), kernel::bbox(shape).expect("a box"))
}

fn union(boxes: &[[f64; 6]]) -> [f64; 6] {
    let mut u = boxes[0];
    for b in &boxes[1..] {
        for k in 0..3 {
            u[k] = u[k].min(b[k]);
            u[k + 3] = u[k + 3].max(b[k + 3]);
        }
    }
    u
}

fn shifted(b: [f64; 6], dx: f64) -> [f64; 6] {
    [b[0] + dx, b[1], b[2], b[3] + dx, b[4], b[5]]
}

/// A box turned a quarter turn `k` times about (`cx`,`cy`), which stays exact.
fn quarter_turned(b: [f64; 6], cx: f64, cy: f64, k: usize) -> [f64; 6] {
    let (mut x0, mut y0, mut x1, mut y1) = (b[0] - cx, b[1] - cy, b[3] - cx, b[4] - cy);
    for _ in 0..k {
        (x0, y0, x1, y1) = (-y1, x0, -y0, x1);
    }
    [cx + x0, cy + y0, b[2], cx + x1, cy + y1, b[5]]
}

fn assert_close(got: (f64, [f64; 6]), want: (f64, [f64; 6]), what: &str) {
    assert!(
        (got.0 - want.0).abs() < 1e-5 * want.0.abs().max(1.0),
        "{what}: volume {} want {}",
        got.0,
        want.0
    );
    for k in 0..6 {
        assert!(
            (got.1[k] - want.1[k]).abs() < 1e-4,
            "{what}: box {:?}, want {:?}",
            got.1,
            want.1
        );
    }
}

/// `entities` patterned twice, once in a row of two 100 apart, once four
/// times round (200, 0), each copy the same shape as the original moved or
/// turned with it.
fn keeps_its_shape(entities: Value, what: &str) {
    let sources: Vec<Value> = entities
        .as_array()
        .expect("a list")
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    let one = extruded(&entities, None);
    assert!(one.0 > 0.0, "{what}: the original has an area");

    let row = extruded(
        &entities,
        Some(json!([{"type": "patternRect", "id": "p", "sources": sources,
            "countX": 2, "countY": 1, "spacingX": 100, "spacingY": 0}])),
    );
    assert_close(row, (2.0 * one.0, union(&[one.1, shifted(one.1, 100.0)])), &format!("{what} in a row"));

    let round = extruded(
        &entities,
        Some(json!([{"type": "patternCircular", "id": "p", "sources": sources,
            "count": 4, "angle": 360, "cx": 200, "cy": 0}])),
    );
    let turned: Vec<[f64; 6]> = (0..4).map(|k| quarter_turned(one.1, 200.0, 0.0, k)).collect();
    assert_close(round, (4.0 * one.0, union(&turned)), &format!("{what} round a centre"));
}

#[test]
fn a_rectangular_pattern_of_a_rotated_rectangle_repeats_it_rotated() {
    let (v, got) = extruded(
        &json!([{"type": "rectangle", "id": "r", "width": 20, "height": 6, "x": 0, "y": 0, "angle": 30}]),
        Some(json!([{"type": "patternRect", "id": "p", "sources": ["r"], "countX": 3, "countY": 1, "spacingX": 40, "spacingY": 0}])),
    );
    assert!((v - 3.0 * 20.0 * 6.0 * 5.0).abs() < 1e-6 * v, "volume {v}");
    #[allow(clippy::cast_precision_loss)]
    let c: Vec<[f64; 2]> = (0..3)
        .flat_map(|i| corners(20.0, 6.0, 40.0 * i as f64, 0.0, 30.0))
        .collect();
    let lo = |k: usize| c.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min);
    let hi = |k: usize| c.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max);
    assert_close((v, got), (v, [lo(0), lo(1), 0.0, hi(0), hi(1), 5.0]), "rotated rectangle");
}

#[test]
fn a_rotated_rectangle_keeps_its_shape() {
    keeps_its_shape(
        json!([{"type": "rectangle", "id": "r", "width": 20, "height": 6, "x": 3, "y": 4, "angle": 30}]),
        "rectangle",
    );
}

#[test]
fn a_loop_of_lines_keeps_its_shape() {
    keeps_its_shape(
        json!([
            {"type": "line", "id": "a", "x1": 0, "y1": 0, "x2": 12, "y2": 0},
            {"type": "line", "id": "b", "x1": 12, "y1": 0, "x2": 0, "y2": 7},
            {"type": "line", "id": "c", "x1": 0, "y1": 7, "x2": 0, "y2": 0},
        ]),
        "lines",
    );
}

#[test]
fn an_arc_keeps_its_shape() {
    keeps_its_shape(
        json!([
            {"type": "line", "id": "a", "x1": 5, "y1": 0, "x2": -5, "y2": 0},
            {"type": "arc", "id": "b", "x1": -5, "y1": 0, "x2": 5, "y2": 0, "mx": 1, "my": 8},
        ]),
        "arc",
    );
}

#[test]
fn a_circle_keeps_its_shape() {
    keeps_its_shape(json!([{"type": "circle", "id": "c", "radius": 3, "x": 4, "y": 1}]), "circle");
}

#[test]
fn an_ellipse_keeps_its_shape() {
    keeps_its_shape(
        json!([{"type": "ellipse", "id": "c", "rx": 6, "ry": 2, "x": 4, "y": 1, "angle": 20}]),
        "ellipse",
    );
}

#[test]
fn a_polygon_keeps_its_shape() {
    keeps_its_shape(
        json!([{"type": "polygon", "id": "g", "x": 2, "y": 3, "radius": 6, "sides": 5, "angle": 10}]),
        "polygon",
    );
}

#[test]
fn a_slot_keeps_its_shape() {
    keeps_its_shape(
        json!([{"type": "slot", "id": "s", "x1": 0, "y1": 0, "x2": 10, "y2": 4, "width": 3}]),
        "slot",
    );
}

#[test]
fn a_spline_keeps_its_shape() {
    keeps_its_shape(
        json!([
            {"type": "spline", "id": "a", "points": [{"x": 0, "y": 0}, {"x": 4, "y": 6}, {"x": 9, "y": 2}, {"x": 12, "y": 0}]},
            {"type": "line", "id": "b", "x1": 12, "y1": 0, "x2": 0, "y2": 0},
        ]),
        "spline",
    );
}

#[test]
fn a_bspline_keeps_its_shape() {
    keeps_its_shape(
        json!([
            {"type": "bspline", "id": "a", "poles": [{"x": 0, "y": 0}, {"x": 2, "y": 8}, {"x": 9, "y": 5}, {"x": 12, "y": 0}], "degree": 3},
            {"type": "line", "id": "b", "x1": 12, "y1": 0, "x2": 0, "y2": 0},
        ]),
        "bspline",
    );
}

#[test]
fn text_keeps_its_lettering() {
    keeps_its_shape(
        json!([{"type": "text", "id": "t", "text": "F", "height": 10, "x": 1, "y": 2, "angle": 15}]),
        "text",
    );
}

#[test]
fn a_point_stays_a_point_a_hole_drills() {
    let plate = json!({"id": "s1", "type": "sketch", "plane": "XY",
        "entities": [{"type": "rectangle", "width": 600, "height": 600, "x": 100, "y": 0}]});
    let base = json!({"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"});
    let drilled = |patterns: Value| {
        let bodies = build(json!([
            plate,
            base,
            {"id": "s2", "type": "sketch", "plane": {"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
             "entities": [{"type": "point", "id": "p0", "x": 10, "y": 5}], "patterns": patterns},
            {"id": "h", "type": "hole", "sketch": "s2", "diameter": 3, "depth": 4},
        ]));
        kernel::volume(&bodies[0].shape)
    };
    let full = 600.0 * 600.0 * 20.0;
    let one = full - drilled(json!([]));
    assert!(one > 0.0, "one hole");
    let row = full
        - drilled(json!([{"type": "patternRect", "id": "p", "sources": ["p0"],
            "countX": 3, "countY": 1, "spacingX": 50, "spacingY": 0}]));
    assert!((row - 3.0 * one).abs() < 1e-6 * full, "three holes, {row} vs {one}");
    let round = full
        - drilled(json!([{"type": "patternCircular", "id": "p", "sources": ["p0"],
            "count": 4, "angle": 360, "cx": 100, "cy": 0}]));
    assert!((round - 4.0 * one).abs() < 1e-6 * full, "four holes, {round} vs {one}");
}
