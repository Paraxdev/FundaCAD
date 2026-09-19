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

/// One build at a time: two of these fillets run on parallel test threads
/// made OCCT refuse ones it builds alone. The engine builds on a single job
/// thread, so only the tests need this.
fn build(doc: &Value) -> Rebuild {
    build_timed(doc).0
}

/// The build and the seconds it took, not counting the wait for its turn.
fn build_timed(doc: &Value) -> (Rebuild, f64) {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let t = std::time::Instant::now();
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    (r, t.elapsed().as_secs_f64())
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
    assert!(!overlap::folds_over_itself(b, a, 30.1));
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
        let (r, secs) = build_timed(&features(Some(g2(13.1, p))));
        assert!(r.errors.is_empty(), "{p}: {:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
        let v = kernel::volume(&r.bodies[0].shape);
        assert!(v > last && secs < 30.0, "profile {p}: {v} after {last}, {secs:.1} s");
        last = v;
    }
}

fn debowler(inner_r: f64) -> Value {
    let mut d: Value = serde_json::from_str(include_str!("blend/debowler.json")).expect("fixture parses");
    d["parameters"]["notch_inner_r"] = json!(inner_r);
    d
}

/// A dish with two rim notches, rebuilt through the MCP from a STEP of
/// 76893.47 mm3. Its notch rounds meet across a 3.5 mm wall.
#[test]
fn the_debowler_rebuilds_to_its_reference_volume() {
    let r = build(&debowler(1.63));
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    let v = kernel::volume(&r.bodies[0].shape);
    assert!((v - 76_893.47).abs() < 1.0, "{v}");
}

/// Past about 1.8 mm the inner notch corners cannot be rounded. The one edge
/// at a time fallback used to round a 0.03 mm sliver instead and the section
/// build handed the corners back sharp, both reported as success.
#[test]
fn a_notch_round_that_cannot_be_built_says_so() {
    let r = build(&debowler(2.0));
    let failed: Vec<_> = r.errors.iter().filter_map(|e| e.feature_id.clone()).collect();
    assert!(failed.iter().any(|f| f == "notch_round_inner"), "{failed:?}");
}

/// The batch fingerprint measures the part once; it must say exactly what
/// fingerprinting each edge on its own says.
#[test]
fn batched_edge_fingerprints_match_one_at_a_time() {
    use fundacad_geom::select::{edge_fingerprint, edge_fingerprints};
    let r = build(&debowler(1.63));
    let part = &r.bodies[0].shape;
    let edges = kernel::subshapes(part, Kind::Edge);
    let batch = edge_fingerprints(&edges, part).unwrap();
    for (e, fp) in edges.iter().zip(&batch) {
        assert_eq!(&edge_fingerprint(e, part).unwrap(), fp);
    }
}
