//! A Move makes no faces, so every face keeps the owner it had before the Move:
//! a face the Fillet trimmed still names the Fillet, an untouched one the Box.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

const PLACEMENTS: [([f64; 3], [f64; 3]); 4] = [
    ([113.5, -41.25, 17.0], [20.0, -35.0, 12.0]),
    ([13.5, -4.25, 7.0], [0.0, 0.0, 0.0]),
    ([-7.35, 2.05, 0.15], [0.0, 0.0, 33.0]),
    ([0.0, 0.0, 0.0], [45.0, 30.0, -60.0]),
];

fn doc(placement: Option<([f64; 3], [f64; 3])>) -> Value {
    let mut features = vec![
        json!({"id": "bx", "type": "box", "length": 60, "width": 40, "height": 20}),
        json!({"id": "fl", "type": "fillet", "radius": 3, "edges": [
            {"kind": "edge", "by": "nearest", "point": [0, 20, 10], "body": "body1"}]}),
    ];
    if let Some((d, r)) = placement {
        features.push(json!({"id": "mv", "type": "move", "dx": d[0], "dy": d[1], "dz": d[2],
            "rx": r[0], "ry": r[1], "rz": r[2], "bodies": ["body1"]}));
    }
    json!({"parameters": {}, "features": features})
}

fn typed(raw: &Value) -> CadDocument {
    serde_json::from_value(raw.clone()).expect("document parses")
}

fn owners_of(r: &Rebuild) -> Vec<Option<String>> {
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(r.bodies.len(), 1);
    let b = &r.bodies[0];
    kernel::subshapes(&b.shape, Kind::Face)
        .iter()
        .map(|f| builder::owners::face_key(f).and_then(|k| b.owners.get(&k).cloned()))
        .collect()
}

fn cold(raw: &Value) -> Vec<Option<String>> {
    owners_of(&builder::rebuild(&typed(raw), raw, &NoWatch).expect("not cancelled"))
}

fn named(owners: &[Option<String>], id: &str) -> usize {
    owners.iter().filter(|o| o.as_deref() == Some(id)).count()
}

#[test]
fn a_moved_body_keeps_each_faces_owner() {
    let before = cold(&doc(None));
    assert_eq!((before.len(), named(&before, "fl"), named(&before, "bx")), (7, 5, 2), "{before:?}");
    for placement in PLACEMENTS {
        let after = cold(&doc(Some(placement)));
        assert_eq!(after, before, "moved by {placement:?}");
    }
}

#[test]
fn a_move_resumed_from_the_cache_keeps_each_faces_owner() {
    let before = cold(&doc(None));
    let mut cache = RebuildCache::new(None);
    let first = doc(Some(PLACEMENTS[1]));
    owners_of(&cache.rebuild(&typed(&first), &first, &NoWatch).expect("not cancelled"));
    for placement in PLACEMENTS {
        let raw = doc(Some(placement));
        let after = owners_of(&cache.rebuild(&typed(&raw), &raw, &NoWatch).expect("not cancelled"));
        assert_eq!(cache.stats.replayed, [2], "only the Move replays");
        assert_eq!(after, before, "moved by {placement:?} from a resume");
    }
}
