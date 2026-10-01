//! A feature's `name` names the bodies it makes, and only those: a join is
//! the body it merged into, and keeps that body's name.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use serde_json::{json, Value};

fn names(doc: &Value) -> Vec<(String, String)> {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r.bodies.iter().map(|b| (b.id.clone(), b.name.clone())).collect()
}

fn plate_and_rib(body_ids: Value) -> Value {
    json!({
        "parameters": {},
        "features": [
            {"id": "f1", "type": "box", "length": 30, "width": 20, "height": 4, "name": "Plate"},
            {"id": "f2", "type": "box", "length": 4, "width": 20, "height": 12, "name": "Rib",
             "operation": "join", "targets": ["body1"]},
            {"id": "f3", "type": "box", "length": 5, "width": 5, "height": 5, "name": "Peg",
             "operation": "new"}
        ],
        "bodyIds": body_ids
    })
}

#[test]
fn a_named_join_keeps_the_name_of_the_body_it_merged_into() {
    let got = names(&plate_and_rib(json!({})));
    assert_eq!(got[0].1, "Plate", "{got:?}");
    assert_eq!(got[1].1, "Peg", "{got:?}");
}

#[test]
fn a_named_join_with_a_recorded_id_of_its_own_still_keeps_the_name() {
    // Recorded when the rib first missed the plate and made a body of its own.
    let got = names(&plate_and_rib(json!({"f1:0": "body1", "f2:0": "body2", "f3:0": "body3"})));
    let merged = got.iter().find(|(_, n)| n != "Peg").expect("the merged body");
    assert_eq!(merged.1, "Plate", "{got:?}");
}
