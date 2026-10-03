//! A duplicate that skips a missing source keeps that source's slot, so the
//! copies after it keep their recorded ids and later moves still find them.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use indexmap::IndexMap;
use serde_json::{json, Value};

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r
}

fn three_boxes_copied(middle: Value, body_ids: Value) -> Value {
    json!({
        "parameters": {},
        "features": [
            {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
            middle,
            {"id": "b3", "type": "box", "length": 30, "width": 30, "height": 30},
            {"id": "dup", "type": "duplicate", "dx": 0, "dy": 0, "dz": 50, "rx": 0, "ry": 0, "rz": 0,
             "bodies": ["body1", "body2", "body3"]},
            {"id": "mv", "type": "move", "dx": 30, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0,
             "bodies": ["body5"]}
        ],
        "bodyIds": body_ids
    })
}

fn second_box(extra: Value) -> Value {
    let mut f = json!({"id": "b2", "type": "box", "length": 20, "width": 20, "height": 20});
    f.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    f
}

fn recorded() -> IndexMap<String, String> {
    let r = build(&three_boxes_copied(second_box(json!({})), json!({})));
    let ids: Vec<&str> = r.bodies.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids, ["body1", "body2", "body3", "body4", "body5", "body6"]);
    r.body_ids
}

fn assert_third_copy_keeps_its_id(r: &Rebuild) {
    assert!(r.bodies.iter().all(|b| b.id != "body5"), "{:?}", r.bodies.iter().map(|b| &b.id).collect::<Vec<_>>());
    assert!(
        r.diagnostics.iter().any(|d| d["feature_id"] == "mv"
            && d["reason"] == "target body already consumed or missing"),
        "{:?}",
        r.diagnostics
    );
    let b6 = r.bodies.iter().find(|b| b.id == "body6").expect("body6 survives");
    let bb = kernel::bbox(&b6.shape).expect("a box");
    for (got, want) in bb.iter().zip([-15.0, -15.0, 35.0, 15.0, 15.0, 65.0]) {
        assert!((got - want).abs() < 1e-3, "body6 {bb:?} is not the third box's copy left in place");
    }
}

#[test]
fn a_deleted_source_does_not_hand_its_copy_id_to_the_next_copy() {
    let map = recorded();
    let mut doc = three_boxes_copied(second_box(json!({})), json!(map));
    doc["features"].as_array_mut().unwrap().remove(1);
    assert_third_copy_keeps_its_id(&build(&doc));
}

#[test]
fn a_switched_off_source_does_not_hand_its_copy_id_to_the_next_copy() {
    let map = recorded();
    let doc = three_boxes_copied(second_box(json!({"activeWhen": 0})), json!(map));
    assert_third_copy_keeps_its_id(&build(&doc));
}

#[test]
fn restoring_the_source_brings_its_copy_id_back() {
    let map = recorded();
    let mut doc = three_boxes_copied(second_box(json!({})), json!(map));
    doc["features"].as_array_mut().unwrap().remove(1);
    let skipped = build(&doc).body_ids;
    let r = build(&three_boxes_copied(second_box(json!({})), json!(skipped)));
    let ids: Vec<&str> = r.bodies.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids, ["body1", "body2", "body3", "body4", "body5", "body6"]);
    let b5 = r.bodies.iter().find(|b| b.id == "body5").unwrap();
    let bb = kernel::bbox(&b5.shape).unwrap();
    assert!((bb[0] - 20.0).abs() < 1e-3 && (bb[3] - 40.0).abs() < 1e-3, "body5 {bb:?} is the moved second copy");
}
