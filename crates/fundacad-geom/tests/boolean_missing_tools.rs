//! A boolean that loses some of its listed tools still applies the rest, and
//! says which ones it could not find.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r
}

fn target_and_two_tools() -> Value {
    json!({
        "parameters": {},
        "features": [
            {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20},
            {"id": "b2", "type": "box", "length": 4, "width": 4, "height": 40},
            {"id": "b3", "type": "box", "length": 40, "width": 4, "height": 4},
            {"id": "cut", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2", "body3"]}
        ]
    })
}

fn notes_on_cut(r: &Rebuild) -> Vec<&Value> {
    r.diagnostics.iter().filter(|d| d["feature_id"] == "cut").collect()
}

fn target_volume(r: &Rebuild) -> f64 {
    let b1 = r.bodies.iter().find(|b| b.id == "body1").expect("the target survives");
    kernel::volume_precise(&b1.shape).abs()
}

#[test]
fn a_cut_missing_one_tool_names_it_and_applies_the_other() {
    let mut doc = target_and_two_tools();
    doc["features"].as_array_mut().unwrap().remove(2);
    let r = build(&doc);
    let notes = notes_on_cut(&r);
    assert_eq!(notes.len(), 1, "{:?}", r.diagnostics);
    assert_eq!(notes[0]["kind"], "toolsMissing");
    let reason = notes[0]["reason"].as_str().unwrap();
    assert!(reason.contains("body3") && !reason.contains("body2"), "{reason}");
    let want = 20.0f64.powi(3) - 4.0 * 4.0 * 20.0;
    assert!((target_volume(&r) - want).abs() < 1e-3, "{} is not the box less body2", target_volume(&r));
}

#[test]
fn a_cut_with_every_tool_present_says_nothing() {
    let r = build(&target_and_two_tools());
    assert!(notes_on_cut(&r).is_empty(), "{:?}", r.diagnostics);
}
