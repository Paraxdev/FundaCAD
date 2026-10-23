use fundacad_geom::builder::{self, NoWatch};
use serde_json::json;

#[test]
fn the_mate_axis_is_published_for_the_handle() {
    let doc = json!({"features": [
        {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "b", "type": "box", "length": 6, "width": 6, "height": 6},
        {"id": "mb", "type": "move", "bodies": ["body2"], "dx": 50},
        {"id": "j", "type": "joint", "moving": "body2",
         "mate": {"body": "body2", "face": {"kind": "face", "by": "nearest", "point": [50, 0, -3], "body": "body2"}},
         "to": {"body": "body1", "face": {"kind": "face", "by": "nearest", "point": [0, 0, 10], "body": "body1"}}},
    ]});
    let typed = serde_json::from_value(doc.clone()).expect("the document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.datum_marks["j"], json!({"kind": "axis", "origin": [0.0, 0.0, 10.0], "dir": [0.0, 0.0, 1.0]}));
    // The moving cube rests on the top face it was mated to.
    let bb = fundacad_geom::kernel::bbox(&r.bodies[1].shape).expect("a box");
    assert!((bb[2] - 10.0).abs() < 1e-6, "{bb:?}");
    assert!((bb[5] - 16.0).abs() < 1e-6, "{bb:?}");
}
