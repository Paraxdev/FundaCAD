//! A field a built-in feature does not read is named in a build diagnostic,
//! so a misspelt `bodies` does not quietly move the active body.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use serde_json::{json, Value};

fn rebuild(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("parses");
    builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled")
}

fn unread(r: &Rebuild) -> Vec<(String, String)> {
    r.diagnostics
        .iter()
        .filter(|d| d["kind"] == "unreadFields")
        .map(|d| {
            (
                d["feature_id"].as_str().unwrap_or("").to_owned(),
                d["reason"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect()
}

#[test]
fn a_move_with_targets_says_the_field_is_ignored() {
    let r = rebuild(&json!({"features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b2", "type": "box", "length": 4, "width": 4, "height": 4},
        {"id": "mv", "type": "move", "dx": 20, "targets": ["body1"], "note": 1},
    ]}));
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(
        unread(&r),
        vec![("mv".to_owned(), "a move has no fields \"targets\", \"note\", the build ignores them".to_owned())]
    );
    let d = r.diagnostics.iter().find(|d| d["kind"] == "unreadFields").expect("one");
    assert_eq!(d["lossy"], false, "an advisory, not a selector note");
}

#[test]
fn one_unread_field_reads_in_the_singular() {
    let r = rebuild(&json!({"features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "sc", "type": "scale", "factor": 2, "targets": ["body1"]},
    ]}));
    assert_eq!(
        unread(&r),
        vec![("sc".to_owned(), "a scale has no field \"targets\", the build ignores it".to_owned())]
    );
}

#[test]
fn a_name_an_inactive_feature_and_a_plugin_feature_say_nothing() {
    let r = rebuild(&json!({"features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10, "name": "Base"},
        {"id": "off", "type": "move", "dx": 5, "targets": ["body1"], "activeWhen": 0},
        {"id": "pl", "type": "somePlugin.widget", "size": 3},
    ]}));
    assert_eq!(unread(&r), Vec::<(String, String)>::new());
}

#[test]
fn the_diagnostic_does_not_change_the_geometry() {
    let with = rebuild(&json!({"features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "mv", "type": "move", "dx": 20, "targets": ["body1"]},
    ]}));
    let without = rebuild(&json!({"features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "mv", "type": "move", "dx": 20},
    ]}));
    let bbox = |r: &Rebuild| fundacad_geom::kernel::bbox(&r.bodies[0].shape).expect("a box");
    assert_eq!(bbox(&with), bbox(&without));
    assert!(unread(&without).is_empty());
}
