use serde_json::{json, Value};

use super::*;
use crate::selection::PickKind;

fn doc(v: Value) -> Doc {
    v.as_object().unwrap().clone()
}

const TARGET: Target = Target { field: "target", kind: PickKind::Body, many: false };
const TOOLS: Target = Target { field: "tools", kind: PickKind::Body, many: true };
const EDGES: Target = Target { field: "edges", kind: PickKind::Edge, many: true };

fn edge_at(x: f64) -> Value {
    json!({"kind": "edge", "by": "nearest", "point": [x, -3.5, 7.25], "body": "body2"})
}

fn union_run() -> (Run, Doc) {
    let before = doc(json!({"features": [{"id": "f1"}, {"id": "f2"}, {"id": "f3"}]}));
    let mut now = before.clone();
    crate::tools::insert(&mut now, json!({"id": "f4", "type": "boolean", "operation": "union", "tools": []})).unwrap();
    let run = Run::new(before, "Union".into(), "Add Union 1".into(), "f4".into(), vec![TARGET, TOOLS]);
    (run, now)
}

#[test]
fn arming_rolls_the_build_back_to_just_before_the_feature_and_disarming_puts_the_marker_back() {
    let mut d = doc(json!({"features": [{"id": "f1"}, {"id": "f2"}, {"id": "f3"}]}));
    let mut r = Run::new(d.clone(), "Edges of Fillet 1".into(), "edges of Fillet 1".into(), "f2".into(), Vec::new());
    r.set_arm(&mut d, Some(EDGES));
    assert_eq!(d["rollback"], json!(1));
    r.set_arm(&mut d, None);
    assert_eq!(d, r.before);

    let mut d = doc(json!({"features": [{"id": "f1"}, {"id": "f2"}, {"id": "f3"}], "rollback": 3.0}));
    let mut r = Run::new(d.clone(), "t".into(), "l".into(), "f3".into(), Vec::new());
    r.set_arm(&mut d, Some(EDGES));
    assert_eq!(d["rollback"], json!(2));
    r.set_arm(&mut d, Some(TOOLS));
    assert_eq!(d["rollback"], json!(2));
    r.set_arm(&mut d, None);
    assert_eq!(d["rollback"], json!(3.0));

    let mut d = doc(json!({"features": [{"id": "f1"}, {"id": "f2"}, {"id": "f3"}], "rollback": 1}));
    let mut r = Run::new(d.clone(), "t".into(), "l".into(), "f3".into(), Vec::new());
    r.set_arm(&mut d, Some(EDGES));
    assert_eq!(d["rollback"], json!(1));
}

#[test]
fn a_suppressed_feature_stays_suppressed_through_arming_and_ok() {
    let mut d = doc(json!({"features": [{"id": "f1"}, {"id": "f2", "type": "fillet", "edges": [edge_at(4.5)]}],
        "suppressed": ["f2"]}));
    let mut r = Run::new(d.clone(), "t".into(), "edges of Fillet 1".into(), "f2".into(), Vec::new());
    r.set_arm(&mut d, Some(EDGES));
    assert_eq!(d["suppressed"], json!(["f2"]));
    r.pick(&mut d, edge_at(-6.0), None).unwrap();
    let (before, label) = r.finish(&mut d, true).unwrap().unwrap();
    assert_eq!(d["suppressed"], json!(["f2"]));
    assert!(d.get("rollback").is_none());
    assert_eq!(d["features"][1]["edges"], json!([edge_at(4.5), edge_at(-6.0)]));
    assert_eq!((before, label.as_str()), (r.before.clone(), "edges of Fillet 1"));
}

#[test]
fn a_union_moves_from_the_kept_body_to_the_used_ones_and_refuses_the_kept_one_as_a_tool() {
    let (mut r, mut d) = union_run();
    r.set_arm(&mut d, Some(TARGET));
    assert_eq!(d["rollback"], json!(3));
    r.pick(&mut d, json!("body1"), None).unwrap();
    assert_eq!(d["features"][3]["target"], json!("body1"));
    assert_eq!(r.arm, Some(TOOLS));
    assert_eq!(d["rollback"], json!(3));

    let was = d.clone();
    assert_eq!(r.pick(&mut d, json!("body1"), None), Err("That body is the one kept, pick another".into()));
    assert_eq!(d, was);

    r.pick(&mut d, json!("body2"), None).unwrap();
    r.pick(&mut d, json!("body3"), None).unwrap();
    assert_eq!(d["features"][3]["tools"], json!(["body2", "body3"]));
    assert_eq!(r.arm, Some(TOOLS));
    r.pick(&mut d, json!("body2"), Some(json!("body2"))).unwrap();
    assert_eq!(d["features"][3]["tools"], json!(["body3"]));

    r.set_arm(&mut d, Some(TARGET));
    assert_eq!(r.pick(&mut d, json!("body3"), None), Err("That body is already used, pick another".into()));
}

#[test]
fn a_single_pick_with_nothing_left_to_fill_disarms_so_the_preview_builds() {
    let (mut r, mut d) = union_run();
    r.set_arm(&mut d, Some(TARGET));
    r.pick(&mut d, json!("body1"), None).unwrap();
    r.pick(&mut d, json!("body2"), None).unwrap();
    r.set_arm(&mut d, Some(TARGET));
    r.pick(&mut d, json!("body4"), None).unwrap();
    assert_eq!(r.arm, None);
    assert!(d.get("rollback").is_none());
    assert_eq!(d["features"][3]["target"], json!("body4"));
}

#[test]
fn a_click_on_a_held_edge_drops_that_entry_and_clear_empties_the_field() {
    let mut d = doc(json!({"features": [{"id": "f1", "type": "fillet", "edges": [edge_at(4.5), edge_at(9.0)]}]}));
    let mut r = Run::new(d.clone(), "t".into(), "l".into(), "f1".into(), vec![EDGES]);
    r.set_arm(&mut d, Some(EDGES));
    r.pick(&mut d, edge_at(4.75), Some(edge_at(4.5))).unwrap();
    assert_eq!(d["features"][0]["edges"], json!([edge_at(9.0)]));
    r.clear(&mut d).unwrap();
    assert_eq!(d["features"][0]["edges"], json!([]));

    let mut d = doc(json!({"features": [{"id": "f1", "type": "boolean", "target": "body1", "tools": ["body2"]}]}));
    let mut r = Run::new(d.clone(), "t".into(), "l".into(), "f1".into(), vec![TARGET, TOOLS]);
    r.set_arm(&mut d, Some(TARGET));
    r.clear(&mut d).unwrap();
    assert_eq!(d["features"][0], json!({"id": "f1", "type": "boolean", "tools": ["body2"]}));
}

#[test]
fn ok_waits_for_each_needed_target_and_cancel_puts_the_document_back() {
    let (mut r, mut d) = union_run();
    assert_eq!(r.missing(&d), Some("Pick the body first".into()));
    r.set_arm(&mut d, Some(TARGET));
    let was = d.clone();
    assert_eq!(r.finish(&mut d, true), Err("Pick the body first".into()));
    assert_eq!((d.clone(), r.arm), (was, Some(TARGET)));
    r.pick(&mut d, json!("body1"), None).unwrap();
    assert_eq!(r.missing(&d), Some("Pick the bodies first".into()));
    r.pick(&mut d, json!("body2"), None).unwrap();
    assert_eq!(r.missing(&d), None);

    let mut cancelled = d.clone();
    let mut c = Run::new(r.before.clone(), "t".into(), "l".into(), "f4".into(), vec![TARGET, TOOLS]);
    c.set_arm(&mut cancelled, Some(TOOLS));
    assert_eq!(c.finish(&mut cancelled, false), Ok(None));
    assert_eq!(cancelled, r.before);

    let (before, label) = r.finish(&mut d, true).unwrap().unwrap();
    assert_eq!((before, label.as_str(), r.arm), (r.before.clone(), "Add Union 1", None));
    assert!(d.get("rollback").is_none());
    assert_eq!(
        d["features"][3],
        json!({"id": "f4", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]})
    );
}

#[test]
fn ok_on_a_repick_that_changed_nothing_records_no_step() {
    let mut d = doc(json!({"features": [{"id": "f1", "type": "fillet", "edges": [edge_at(4.5)]}], "rollback": 1}));
    let mut r = Run::new(d.clone(), "t".into(), "l".into(), "f1".into(), Vec::new());
    r.set_arm(&mut d, Some(EDGES));
    assert_eq!(d["rollback"], json!(0));
    assert_eq!(r.finish(&mut d, true), Ok(None));
    assert_eq!(d, r.before);
}

#[test]
fn nouns_follow_the_count_a_field_takes() {
    assert_eq!(noun(PickKind::Body, false), "body");
    assert_eq!(noun(PickKind::Body, true), "bodies");
    assert_eq!(noun(PickKind::Face, false), "face");
    assert_eq!(noun(PickKind::Edge, true), "edges");
}
