//! A conic fillet stays a solid the kernel can compute with, so what is built
//! on it afterwards (a cut through it, a press/pull) removes what it should.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn build(doc: &Value) -> (f64, [f64; 6]) {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let s = &r.bodies[0].shape;
    (kernel::volume(s), kernel::bbox(s).expect("a box"))
}

fn filleted(profile: f64) -> Value {
    json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "width": 50, "height": 50, "x": 0, "y": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 29.691, "operation": "new"},
        {"id": "f", "type": "fillet", "radius": 28.7, "profile": profile, "edges": [
            {"kind": "edge", "by": "nearest", "point": [0, 25, 29.691]},
            {"kind": "edge", "by": "nearest", "point": [-25, 0, 29.691]},
            {"kind": "edge", "by": "nearest", "point": [-25, 25, 14.8455]}
        ]},
    ]})
}

/// Towards the sharp corner the volume can only grow. At 0.99 OCCT measured
/// this blend 5000 mm3 lighter than the circular fillet, and a cut through it
/// added material instead of removing it; 0.99 is now held at 0.95.
#[test]
fn a_fuller_conic_profile_never_loses_volume() {
    let sharp = 50.0 * 50.0 * 29.691;
    let mut last = 0.0;
    for p in [0.0, 0.5, 0.9, 0.95, 0.99] {
        let (v, _) = build(&filleted(p));
        assert!(v >= last && v < sharp, "profile {p}: {v} after {last}, sharp {sharp}");
        last = v;
    }
}

#[test]
fn a_cut_through_a_full_conic_fillet_removes_material() {
    let mut doc = filleted(0.99);
    let (before, _) = build(&doc);
    doc["features"].as_array_mut().unwrap().extend([
        json!({"id": "s2", "type": "sketch", "plane": "XZ", "entities": [{"type": "rectangle", "width": 12, "height": 4, "x": 0, "y": 15}]}),
        json!({"id": "c", "type": "extrude", "sketch": "s2", "distance": 60, "symmetric": true, "operation": "cut"}),
    ]);
    let (after, bb) = build(&doc);
    assert!(after < before - 1000.0, "{before} -> {after}");
    assert!(bb[4] <= 25.0 + 1e-6, "the body grew: {bb:?}");
}
