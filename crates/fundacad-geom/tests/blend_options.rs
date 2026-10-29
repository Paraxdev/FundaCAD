//! The less common blend options measured on a slanted prism: a chord sized fillet, a two distance chamfer
//! whose first distance is not 1, and an equal chamfer that carries a stray distance2.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

const HEIGHT: f64 = 10.0;
const PARALLELOGRAM: [(f64, f64); 4] = [(5.0, 2.0), (27.0, 2.0), (35.0, 18.0), (13.0, 18.0)];
const ACUTE: [f64; 3] = [5.0, 2.0, 5.0];
// The walls meet at 63.43 degrees at (5, 2) and (35, 18), at 116.57 at the other two corners.
const ACUTE_DEG: f64 = 63.434_948_822_922;

fn prism(blend: Value) -> Rebuild {
    let lines: Vec<Value> = (0..4)
        .map(|i| {
            let (a, b) = (PARALLELOGRAM[i], PARALLELOGRAM[(i + 1) % 4]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1})
        })
        .collect();
    let raw = json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": "XY", "entities": lines},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": HEIGHT, "operation": "new"},
        blend,
    ]});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled")
}

fn near(p: [f64; 3]) -> Value {
    json!({"kind": "edge", "by": "nearest", "point": p, "body": "body1"})
}

/// Errors, warnings, face count and volume to 0.01 mm^3.
fn outcome(r: &Rebuild) -> (Vec<String>, Vec<String>, Option<usize>, f64) {
    let errors = r.errors.iter().map(|e| e.message.clone()).collect();
    let warned = r.diagnostics.iter().filter_map(|d| d["message"].as_str().map(str::to_owned)).collect();
    let faces = r.bodies.first().map(|b| kernel::count(&b.shape, Kind::Face));
    let volume = r.bodies.first().map_or(0.0, |b| kernel::volume_precise(&b.shape).abs());
    (errors, warned, faces, (volume * 100.0).round() / 100.0)
}

fn clean(faces: usize, removed: f64) -> (Vec<String>, Vec<String>, Option<usize>, f64) {
    let whole = 22.0 * 16.0 * HEIGHT;
    (vec![], vec![], Some(faces), ((whole - removed) * 100.0).round() / 100.0)
}

/// The triangle a d by d2 chamfer cuts from a corner of `deg` degrees, along the prism's height.
fn chamfer_cut(deg: f64, d: f64, d2: f64) -> f64 {
    d * d2 / 2.0 * deg.to_radians().sin() * HEIGHT
}

/// The sliver a round whose tangent points lie `chord` apart cuts from a corner of `deg` degrees.
fn chord_cut(deg: f64, chord: f64) -> f64 {
    let inside = deg.to_radians();
    let r = chord / (2.0 * ((PI - inside) / 2.0).sin());
    (r * r / (inside / 2.0).tan() - r * r * (PI - inside) / 2.0) * HEIGHT
}

/// The kernel took distance2 as d2 * size / d, so distance 2 with distance2 1 set the second wall back 1 mm.
/// Distance 1 hides a * in place of the /, as every other two distance fixture used.
#[test]
fn a_two_distance_chamfer_sets_each_wall_back_by_its_own_distance() {
    for (d, d2) in [(2.0, 1.0), (1.0, 2.5), (3.0, 3.0)] {
        let c = json!({"id": "c", "type": "chamfer", "chamferType": "twoDistance", "distance": d, "distance2": d2,
            "edges": near(ACUTE)});
        assert_eq!(outcome(&prism(c)), clean(7, chamfer_cut(ACUTE_DEG, d, d2)), "{d}/{d2}");
    }
}

#[test]
fn an_equal_chamfer_ignores_a_distance2_it_carries() {
    for d2 in [1.0, 4.0] {
        let c = json!({"id": "c", "type": "chamfer", "chamferType": "equalDistance", "distance": 2, "distance2": d2,
            "edges": near(ACUTE)});
        assert_eq!(outcome(&prism(c)), clean(7, chamfer_cut(ACUTE_DEG, 2.0, 2.0)), "distance2 {d2}");
    }
}

/// A 3 mm chord is a 1.763 mm round at the acute corners and a 2.853 mm one at the obtuse corners.
#[test]
fn a_chord_sized_fillet_puts_its_tangent_lines_the_chord_apart_on_any_corner() {
    let fillet = |edges: Value| json!({"id": "f", "type": "fillet", "radius": 3, "sizeType": "chord", "edges": edges});
    let acute = chord_cut(ACUTE_DEG, 3.0);
    assert_eq!(outcome(&prism(fillet(near(ACUTE)))), clean(7, acute));
    let all = 2.0 * acute + 2.0 * chord_cut(180.0 - ACUTE_DEG, 3.0);
    let z_edges = json!({"kind": "edge", "by": "axis", "axis": "Z", "body": "body1"});
    assert_eq!(outcome(&prism(fillet(z_edges))), clean(10, all));
}
