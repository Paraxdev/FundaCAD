//! Mirror acts on the bodies it names, and on the active body only when it
//! names none.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn two_boxes(mirror: Value) -> Value {
    json!({"parameters": {}, "features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "place", "type": "move", "dx": 20, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body1"]},
        {"id": "b", "type": "box", "length": 4, "width": 4, "height": 4},
        mirror,
    ]})
}

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn volume_and_min_x(r: &Rebuild, id: &str) -> (f64, f64) {
    let b = r.bodies.iter().find(|b| b.id == id).expect("the body");
    (kernel::volume(&b.shape), kernel::bbox(&b.shape).expect("a box")[0])
}

fn only_error_of_m(r: &Rebuild) -> String {
    assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
    assert_eq!(r.errors[0].feature_id.as_deref(), Some("m"));
    r.errors[0].message.clone()
}

#[test]
fn mirror_reflects_the_named_body_and_leaves_the_active_one() {
    let r = build(&two_boxes(json!({"id": "m", "type": "mirror", "plane": {"name": "YZ"}, "bodies": ["body1"]})));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let (v1, x1) = volume_and_min_x(&r, "body1");
    assert!((v1 - 2000.0).abs() < 1e-6, "body1 volume {v1}");
    assert!((x1 + 25.0).abs() < 1e-6, "body1 min x {x1}");
    let (v2, x2) = volume_and_min_x(&r, "body2");
    assert!((v2 - 64.0).abs() < 1e-6, "body2 volume {v2}");
    assert!((x2 + 2.0).abs() < 1e-6, "body2 min x {x2}");
}

#[test]
fn mirror_without_bodies_still_reflects_the_active_body() {
    for plane in [json!("YZ"), json!({"name": "YZ"})] {
        let r = build(&two_boxes(json!({"id": "m", "type": "mirror", "plane": plane})));
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let (v1, x1) = volume_and_min_x(&r, "body1");
        assert!((v1 - 1000.0).abs() < 1e-6, "body1 volume {v1}");
        assert!((x1 - 15.0).abs() < 1e-6, "body1 min x {x1}");
        let (v2, _) = volume_and_min_x(&r, "body2");
        assert!((v2 - 64.0).abs() < 1e-6, "{plane}: body2 is the active body, volume {v2}");
    }
}

#[test]
fn mirror_of_a_missing_body_refuses_and_names_it() {
    let r = build(&two_boxes(json!({"id": "m", "type": "mirror", "plane": {"name": "YZ"}, "bodies": ["body1", "body9"]})));
    let msg = only_error_of_m(&r);
    assert!(msg.contains("body9") && !msg.contains("body1"), "{msg}");
    let (v1, _) = volume_and_min_x(&r, "body1");
    assert!((v1 - 1000.0).abs() < 1e-6, "body1 is left as it was, volume {v1}");
}

#[test]
fn mirror_with_bodies_refuses_a_bare_plane_name() {
    let r = build(&two_boxes(json!({"id": "m", "type": "mirror", "plane": "YZ", "bodies": ["body1"]})));
    let msg = only_error_of_m(&r);
    assert!(msg.contains(r#"{"name": "YZ"}"#), "{msg}");
}
