//! The fillet sections in tests/vectors/blend_sections.json, which the viewport's preview draws too, are the ones
//! the engine builds: every point lies on the filleted wedge, and the G2 and G3 sections are not the G1 round.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};
use std::path::Path;

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/blend_sections.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse")
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

/// A prism 40 tall on a triangle whose corner at the origin joins faces toward (-1, 0) and (-cos a, -sin a).
fn filleted_wedge(angle: f64, radius: f64, continuity: &str) -> Shape {
    let t = angle.to_radians();
    let pts = [[0.0, 0.0], [-50.0, 0.0], [-50.0 * t.cos(), -50.0 * t.sin()]];
    let entities: Vec<Value> = (0..3).map(|i| line(&format!("l{i}"), pts[i], pts[(i + 1) % 3])).collect();
    let pick = json!({"kind": "edge", "by": "nearest", "point": [0.0, 0.0, 20.0]});
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": entities},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 40.0, "operation": "new"},
        {"id": "f", "type": "fillet", "radius": radius, "continuity": continuity, "edges": [pick]},
    ]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r.bodies[0].shape.clone()
}

/// How far a section point, mapped to the wedge's mid height, sits from the nearest face of the solid.
fn off_boundary(faces: &[Shape], p: &Value) -> f64 {
    let at = [-p[0].as_f64().expect("x"), -p[1].as_f64().expect("y"), 20.0];
    faces.iter().filter_map(|f| kernel::distance_to_point(f, at)).fold(f64::INFINITY, f64::min)
}

#[test]
fn the_engine_builds_the_shared_blend_sections() {
    let v = vectors();
    let sections = v["sections"].as_array().expect("sections");
    assert_eq!(sections.len(), 18);
    for s in sections {
        let (angle, radius) = (s["angle"].as_f64().expect("angle"), s["radius"].as_f64().expect("radius"));
        let cont = s["continuity"].as_str().expect("continuity");
        let faces = kernel::subshapes(&filleted_wedge(angle, radius, cont), Kind::Face);
        for p in s["points"].as_array().expect("points") {
            let d = off_boundary(&faces, p);
            assert!(d < 1e-4 * radius, "{cont} at {angle} degrees, radius {radius}: {p} is {d} off");
        }
        if cont == "G1" {
            continue;
        }
        let round = sections
            .iter()
            .find(|g| g["angle"] == s["angle"] && g["radius"] == s["radius"] && g["continuity"] == "G1")
            .expect("the G1 section");
        let far = round["points"].as_array().expect("points").iter().map(|p| off_boundary(&faces, p));
        let far = far.fold(0.0, f64::max);
        assert!(far > 0.01 * radius, "{cont} at {angle} degrees, radius {radius} is the G1 round: {far}");
    }
}
