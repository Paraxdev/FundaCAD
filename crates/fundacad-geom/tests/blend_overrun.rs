//! A fillet bigger than the face it runs onto is built from lofted sections,
//! and cutting all of them at once could leave their faces inside the result.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::blend::overlap;
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

fn features(fillet: Option<Value>) -> Value {
    let mut fs = vec![
        json!({"id": "f1", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "id": "e0", "width": 50, "height": 50, "x": 0, "y": 0}]}),
        json!({"id": "f2", "type": "extrude", "sketch": "f1", "distance": 29.691, "operation": "new", "regions": [[0, 0, 0]], "hiddenBodies": []}),
    ];
    fs.extend(fillet);
    json!({ "features": fs })
}

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled")
}

/// The reported document: a box extruded from a picked sketch region, whose
/// orientation made the one-shot cut keep both top edge blends and the corner
/// patch under the side blend. BRepCheck passed it, the section cap streaked.
#[test]
fn a_fillet_past_its_face_does_not_cover_the_model_twice() {
    let fillet = json!({"id": "f3", "type": "fillet", "radius": 30.1, "profile": 0.95, "edges": [
        {"kind": "edge", "by": "nearest", "point": [0, 25, 29.691], "body": "body1"},
        {"kind": "edge", "by": "nearest", "point": [-25, 0, 29.691], "body": "body1"},
        {"kind": "edge", "by": "nearest", "point": [-25, 25, 14.8455], "body": "body1"}
    ]});
    let before = build(&features(None));
    let after = build(&features(Some(fillet)));
    assert!(after.errors.is_empty(), "{:?}", after.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let (b, a) = (&before.bodies[0].shape, &after.bodies[0].shape);
    assert!(!overlap::folds_over_itself(b, a));
    assert_eq!(kernel::count(a, Kind::Face), 7);
    let v = kernel::volume(a);
    assert!((v - 71_850.0).abs() < 50.0, "{v}");
}

fn g2(radius: f64, profile: f64) -> Value {
    json!({"id": "f3", "type": "fillet", "radius": radius, "profile": profile, "continuity": "G2", "draft": true, "edges": [
        {"kind": "edge", "by": "nearest", "point": [0, 25, 29.691], "body": "body1"},
        {"kind": "edge", "by": "nearest", "point": [-25, 0, 29.691], "body": "body1"},
        {"kind": "edge", "by": "nearest", "point": [-25, 25, 14.8455], "body": "body1"}
    ]})
}

/// Two G2 tools met at the corner and the cut kept that corner of the box,
/// with all its old faces, 1400 mm3 heavier than its neighbours.
#[test]
fn overlapping_g2_tools_leave_no_corner_standing() {
    let r = build(&features(Some(g2(19.0, 0.05))));
    let s = &r.bodies[0].shape;
    assert_eq!(kernel::count(s, Kind::Face), 10);
    let v = kernel::volume(s);
    assert!((v - 64_960.0).abs() < 50.0, "{v}");
}

/// The profile used to scale a weight, 400 at the corner patch, and a 0.671
/// G2 corner ran past the engine's minute without progress: the engine
/// restarted mid drag. Python took five minutes over the same one.
#[test]
fn a_g2_profile_builds_in_seconds_and_fills_in_order() {
    let mut last = 0.0;
    for p in [-0.5, 0.3, 0.671, 0.95] {
        let t = std::time::Instant::now();
        let r = build(&features(Some(g2(13.1, p))));
        let secs = t.elapsed().as_secs_f64();
        assert!(r.errors.is_empty(), "{p}: {:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
        let v = kernel::volume(&r.bodies[0].shape);
        assert!(v > last && secs < 30.0, "profile {p}: {v} after {last}, {secs:.1} s");
        last = v;
    }
}
