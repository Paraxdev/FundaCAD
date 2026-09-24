//! Control-point B-spline sketch entities: OCCT's curve agrees with the sampled
//! points in tests/vectors/bspline.json (recorded by tests/sketch/bspline.test.ts),
//! and a bspline profile extrudes and revolves into a valid solid.

use std::path::Path;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, CurveType, ItemKind};
use serde_json::{json, Value};

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/bspline.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse")
}

fn nums(v: &Value) -> Vec<f64> {
    v.as_array().expect("array").iter().map(|x| x.as_f64().expect("number")).collect()
}

#[test]
fn occt_samples_the_shared_vectors() {
    for c in vectors()["cases"].as_array().expect("cases") {
        let name = c["name"].as_str().expect("name");
        let poles: Vec<[f64; 2]> = c["poles"].as_array().expect("poles").iter().map(|p| {
            let p = nums(p);
            [p[0], p[1]]
        }).collect();
        let closed = c["closed"].as_bool().expect("closed");
        let knots = nums(&c["knots"]);
        let degree = c["degree"].as_f64();
        let (p, k) = kernel::bspline_knots(poles.len(), degree, closed, Some(&knots));
        assert_eq!(Some(p as f64), degree, "{name}: degree");
        assert_eq!(k, knots, "{name}: knots");
        let edge = kernel::edge_bspline(&poles, degree, closed, Some(&knots)).expect("edge");
        for s in c["samples"].as_array().expect("samples") {
            let s = nums(s);
            let (pt, range) = kernel::edge_eval(&edge, s[0]).expect("eval");
            assert!((range[0] - knots[0]).abs() < 1e-12 && (range[1] - knots[knots.len() - 1]).abs() < 1e-12, "{name}: range {range:?}");
            let d = (pt[0] - s[1]).hypot(pt[1] - s[2]);
            assert!(d < 1e-9 && pt[2] == 0.0, "{name}: t={} occt {pt:?} vs {:?} ({d})", s[0], &s[1..]);
        }
    }
}

#[test]
fn malformed_stored_knots_fall_back_to_uniform() {
    assert_eq!(kernel::bspline_knots(7, None, false, Some(&[0.0, 1.0, 1.0, 3.0, 4.0])).1, vec![0.0, 1.0, 2.0, 3.0, 4.0]);
    assert_eq!(kernel::bspline_knots(4, Some(5.0), false, None), (3, vec![0.0, 1.0]));
    assert_eq!(kernel::bspline_knots(5, Some(2.0), true, None), (2, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]));
}

fn build(doc: &Value) -> Shape {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(r.bodies.len(), 1);
    r.bodies[0].shape.clone()
}

fn bspline_edges(s: &Shape) -> usize {
    sa::items(s, ItemKind::Edge)
        .iter()
        .filter(|e| sa::edge_probe(e).is_some_and(|p| p.curve == CurveType::Bspline))
        .count()
}

fn valid(s: &Shape) -> bool {
    opencascade_sys::plugin_ops::po_is_valid(s.raw())
}

fn poles(pts: &[[f64; 2]]) -> Value {
    Value::Array(pts.iter().map(|p| json!({"x": p[0], "y": p[1]})).collect())
}

#[test]
fn a_closed_bspline_profile_extrudes_into_a_valid_solid() {
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"type": "bspline", "id": "b", "closed": true, "poles": poles(&[[0.0, -20.0], [25.0, -18.0], [30.0, 5.0], [12.0, 28.0], [-15.0, 22.0], [-28.0, 0.0]])},
        ]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"},
    ]});
    let s = build(&doc);
    assert!(valid(&s));
    assert!(bspline_edges(&s) >= 2, "the caps are bounded by the bspline");
    let v = kernel::volume(&s);
    assert!(v > 10.0 * 1000.0 && v < 10.0 * 58.0 * 48.0, "{v}");
}

#[test]
fn an_open_bspline_closed_by_a_line_revolves_into_a_valid_solid() {
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XZ", "entities": [
            {"type": "bspline", "id": "b", "degree": 3, "poles": poles(&[[0.0, 0.0], [18.0, 2.0], [6.0, 14.0], [15.0, 26.0], [0.0, 30.0]])},
            {"type": "line", "id": "axis", "x1": 0, "y1": 30, "x2": 0, "y2": 0},
        ]},
        {"id": "r", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 360, "operation": "new"},
    ]});
    let s = build(&doc);
    assert!(valid(&s));
    assert!(bspline_edges(&s) >= 1);
    assert!(kernel::volume(&s) > 1000.0);
}

#[test]
fn a_patterned_bspline_is_copied_with_its_knots() {
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"type": "bspline", "id": "b", "closed": true, "knots": [0, 1, 1.5, 2, 3, 4, 5],
             "poles": poles(&[[0.0, 0.0], [10.0, 0.0], [12.0, 6.0], [8.0, 10.0], [2.0, 10.0], [-2.0, 5.0]])},
        ], "patterns": [
            {"type": "patternRect", "id": "p", "sources": ["b"], "countX": 2, "countY": 1, "spacingX": 40, "spacingY": 0},
        ]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 5, "operation": "new"},
    ]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let total: f64 = r.bodies.iter().map(|b| kernel::volume(&b.shape)).sum();
    let one = kernel::volume(&build(&json!({"features": [doc["features"][0].clone().as_object().map(|o| {
        let mut o = o.clone();
        o.remove("patterns");
        Value::Object(o)
    }).unwrap(), doc["features"][1].clone()]})));
    assert!((total - 2.0 * one).abs() < 1e-6 * one, "{total} vs 2 x {one}");
}
