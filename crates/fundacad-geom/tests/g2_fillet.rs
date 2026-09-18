//! A G2 fillet sets back further than its radius, so on a corner it can run off
//! a face the G1 fillet of the same radius still fits on.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::json;

fn corner(radius: f64, profile: f64) -> Rebuild {
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "width": 50, "height": 50, "x": 0, "y": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 29.691, "operation": "new"},
        {"id": "f", "type": "fillet", "radius": radius, "profile": profile, "continuity": "G2", "draft": true, "edges": [
            {"kind": "edge", "by": "nearest", "point": [0, 25, 29.691]},
            {"kind": "edge", "by": "nearest", "point": [-25, 0, 29.691]},
            {"kind": "edge", "by": "nearest", "point": [-25, 25, 14.8455]}
        ]},
    ]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

/// 28.7 fits a 29.7 face as a G1 fillet, but a G2 one sets back 44.5 and used
/// to eat the whole side face, or spend minutes in the boolean first.
#[test]
fn a_g2_fillet_that_runs_off_the_face_is_refused() {
    let r = corner(28.7, -0.324);
    let msg = r.errors.first().map(|e| e.message.clone()).unwrap_or_default();
    assert!(msg.contains("runs off the face"), "{msg:?}");
}

#[test]
fn a_g2_fillet_that_fits_keeps_the_body_box() {
    let r = corner(10.0, 0.0);
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let s = &r.bodies[0].shape;
    let bb = kernel::bbox(s).expect("a box");
    assert!((bb[0] + 25.0).abs() < 1e-3 && (bb[4] - 25.0).abs() < 1e-3, "{bb:?}");
    let v = kernel::volume(s);
    assert!(v > 70_000.0 && v < 50.0 * 50.0 * 29.691, "{v}");
}
