//! A chamfer on the rims of a plate full of holes.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::blend::ops;
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

/// A square plate 10 thick with r2.5 holes through it, its top face's edges chamfered by `chamfer`.
fn plate(side: f64, holes: &[(f64, f64)], chamfer: Option<f64>) -> Value {
    let circles: Vec<Value> = holes
        .iter()
        .enumerate()
        .map(|(i, &(x, y))| json!({"type": "circle", "id": format!("h{i}"), "x": x, "y": y, "radius": 2.5}))
        .collect();
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XY", "entities": [
            {"type": "line", "id": "a", "x1": 0, "y1": 0, "x2": side, "y2": 0},
            {"type": "line", "id": "b", "x1": side, "y1": 0, "x2": side, "y2": side},
            {"type": "line", "id": "c", "x1": side, "y1": side, "x2": 0, "y2": side},
            {"type": "line", "id": "d", "x1": 0, "y1": side, "x2": 0, "y2": 0}]}),
        json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"}),
        json!({"id": "hs", "type": "sketch", "plane": "XY", "entities": circles}),
        json!({"id": "cut", "type": "extrude", "sketch": "hs", "distance": 10, "operation": "cut"}),
    ];
    if let Some(d) = chamfer {
        features.push(json!({"id": "ch", "type": "chamfer", "distance": d,
            "edges": {"kind": "face", "by": "nearest", "point": [1.5, 1.5, 10], "body": "body1"}}));
    }
    json!({"parameters": {}, "features": features})
}

fn one_hole() -> (Shape, Vec<Shape>) {
    let body = build(&plate(20.0, &[(10.0, 10.0)], None)).bodies[0].shape.clone();
    let rim: Vec<Shape> = kernel::subshapes(&body, Kind::Edge)
        .into_iter()
        .filter(|e| {
            kernel::bbox(e)
                .is_some_and(|b| (b[2] - 10.0).abs() < 1e-6 && (b[5] - 10.0).abs() < 1e-6 && b[0] > 1.0 && b[3] < 19.0)
        })
        .collect();
    assert_eq!(rim.len(), 1, "one rim on the top face");
    (body, rim)
}

/// The volume a 45 degree chamfer of `s` takes off the rim of an r2.5 hole.
fn rim_cut(s: f64) -> f64 {
    2.0 * PI * (2.5 + s / 3.0) * s * s / 2.0
}

#[test]
fn a_section_chamfer_on_a_hole_rim_cuts_the_rim() {
    let (body, rim) = one_hole();
    for s in [0.5, 0.75] {
        let out = ops::section(&body, &rim, true, &[s], None, s, 1, false, 0.0).expect("the rim chamfers");
        let removed = kernel::volume(&body) - kernel::volume(&out);
        assert!(
            (removed - rim_cut(s)).abs() < 0.01 * rim_cut(s),
            "at {s} it took {removed}, the rim's chamfer is {}",
            rim_cut(s)
        );
        assert_eq!(kernel::count(&out, Kind::Face), kernel::count(&body, Kind::Face) + 1, "at {s} one chamfer face");
    }
}
