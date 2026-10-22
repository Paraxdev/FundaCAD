//! Press/pull previews share one rebuild cache as in a face drag and all start from the cached body before the
//! press/pull, so no preview may change it, or the star pocket ring refuses every distance after a few pushes.

use fundacad_core::CadDocument;
use fundacad_geom::builder::NoWatch;
use fundacad_geom::cache::RebuildCache;
use opencascade::primitives::Shape;
use opencascade::progress::ProgressRange;
use opencascade::shape_io::BrepWriteOptions;
use serde_json::{json, Value};

const BOTTOM: [f64; 3] = [-3.6144186655680337, -16.910546938578285, 0.0];
const FLOOR: [f64; 3] = [-3.3591615358988443, -15.95791467030843, 0.31700000166893005];

fn ring() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/press_pull/star_pocket_ring.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn doc(raw: &Value) -> CadDocument {
    serde_json::from_value(raw.clone()).unwrap()
}

// Without the first flag of each shape, Free, which only says whether the
// shape has been put in a compound yet: kernel::boolean_op puts its tools in one.
fn brep(s: &Shape) -> String {
    let text = s.to_brep_text(BrepWriteOptions::default(), &ProgressRange::detached()).unwrap();
    let flags = |l: &str| l.len() == 7 && l.bytes().all(|b| b == b'0' || b == b'1');
    text.lines().map(|l| if flags(l) { &l[1..] } else { l }).collect::<Vec<_>>().join("\n")
}

fn with_push(base: &Value, point: [f64; 3], distance: f64) -> Value {
    let mut raw = base.clone();
    raw["features"].as_array_mut().unwrap().push(json!({
        "id": "f8", "type": "press-pull",
        "face": {"kind": "face", "by": "nearest", "point": point},
        "distance": distance, "operation": if distance > 0.0 { "join" } else { "cut" }, "body": "body1"
    }));
    raw
}

#[test]
fn previews_leave_the_body_before_them_as_it_was() {
    let base = ring();
    let mut cache = RebuildCache::new(None);
    let held = cache.rebuild(&doc(&base), &base, &NoWatch).unwrap().bodies[0].shape.clone();
    let before = brep(&held);
    for (point, d) in [(BOTTOM, 2.05), (BOTTOM, -0.3), (FLOOR, 2.05), (FLOOR, 1.0), (BOTTOM, 1.2)] {
        let raw = with_push(&base, point, d);
        let r = cache.rebuild(&doc(&raw), &raw, &NoWatch).unwrap();
        assert!(
            r.errors.is_empty(),
            "push {d} at {point:?}: {:?}",
            r.errors.iter().map(|e| &e.message).collect::<Vec<_>>()
        );
    }
    let after = brep(&held);
    assert!(after == before, "the body grew from {} to {} bytes of BREP", before.len(), after.len());
}
