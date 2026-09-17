//! The plugin host end to end on the PrintToolbox component, with the same
//! documents and analytic volumes as plugins/FundaCAD.PrintToolbox/geometry/tests.
//! Needs `python scripts/build-plugin-wasm.py FundaCAD.PrintToolbox` first;
//! without the component every case is skipped with a note.
#![cfg(feature = "plugins")]

use std::f64::consts::PI;
use std::path::Path;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn component_built() -> bool {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/FundaCAD.PrintToolbox/geometry.wasm");
    if !p.is_file() {
        eprintln!("skipped: build the component with scripts/build-plugin-wasm.py");
    }
    p.is_file()
}

fn block(w: f64, d: f64, h: f64) -> Vec<Value> {
    vec![
        json!({"id": "s1", "type": "sketch", "plane": "XY",
               "entities": [{"type": "rectangle", "width": w, "height": d, "x": 0, "y": 0}]}),
        json!({"id": "e1", "type": "extrude", "sketch": "s1", "distance": h, "operation": "new"}),
    ]
}

fn y_hole(r: f64, z: f64) -> Vec<Value> {
    vec![
        json!({"id": "sh", "type": "sketch", "plane": "XZ",
               "entities": [{"type": "circle", "radius": r, "x": 0, "y": z}]}),
        json!({"id": "eh", "type": "extrude", "sketch": "sh", "distance": 100, "symmetric": true,
               "operation": "cut"}),
    ]
}

fn face_at(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p})
}

fn build(features: Vec<Value>) -> Rebuild {
    let doc = json!({"parameters": {}, "features": features});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn one_volume(r: &Rebuild) -> f64 {
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1);
    kernel::volume(&r.bodies[0].shape)
}

const R: f64 = 3.0;
const Z: f64 = 10.0;
const L: f64 = 20.0;

fn base() -> Vec<Value> {
    let mut f = block(30.0, L, 20.0);
    f.extend(y_hole(R, Z));
    f
}

#[test]
fn teardrop_removes_the_analytic_cap() {
    if !component_built() {
        return;
    }
    let before = one_volume(&build(base()));
    for angle in [45.0f64, 30.0, 60.0] {
        let mut f = base();
        f.push(json!({"id": "td", "type": "teardropHole", "faces": face_at([0.0, 0.0, Z + R]), "angle": angle}));
        let after = one_volume(&build(f));
        let th = angle.to_radians();
        let cap = R * R * (1.0 / th.tan() - (PI / 2.0 - th));
        let removed = before - after;
        assert!((removed - cap * L).abs() < 1e-3 * cap * L + 1e-4, "{angle}: {removed} vs {}", cap * L);
    }
}

#[test]
fn roof_bridge_and_ribs_and_errors() {
    if !component_built() {
        return;
    }
    let before = one_volume(&build(base()));
    let mut f = base();
    f.push(json!({"id": "rb", "type": "roofBridge", "faces": face_at([0.0, 0.0, Z + R]), "height": 0.6}));
    let area = 2.0 * R * (R + 0.6) - PI * R * R / 2.0;
    assert!(((before - one_volume(&build(f))) - area * L).abs() < 1e-3 * area * L);

    let mut f = base();
    f.push(json!({"id": "td", "type": "teardropHole", "faces": face_at([0.0, 0.0, 20.0])}));
    let r = build(f);
    assert_eq!(r.errors.len(), 1);
    assert_eq!(r.errors[0].feature_id.as_deref(), Some("td"));
    assert!(r.errors[0].message.contains("not cylindrical"), "{}", r.errors[0].message);

    let mut f = base();
    f.push(json!({"id": "tr", "type": "threadRibs", "faces": face_at([0.0, 0.0, Z + R]), "ribCount": 2}));
    let r = build(f);
    assert_eq!(
        r.errors[0].message,
        "Thread-forming ribs: the rib count must be a whole number from 3 to 8 (got 2)"
    );
}

#[test]
fn an_unknown_type_still_reads_unknown() {
    let r = build(vec![json!({"id": "x", "type": "noSuchFeature"})]);
    assert_eq!(r.errors[0].message, "unknown feature type: noSuchFeature");
}
