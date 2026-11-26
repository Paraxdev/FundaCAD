use serde_json::{json, Value};

use super::{delete, move_to, note, rename, set_note, set_rollback, set_suppressed, NOTES};
use crate::timeline::fixture::{doc, order, strings};

#[test]
fn a_rename_sets_the_name_and_a_blank_one_resets_it() {
    let mut d = doc();
    rename(&mut d, "pad", "  Plate ").unwrap();
    assert_eq!(d["features"][1]["name"], json!("Plate"));
    rename(&mut d, "base", "   ").unwrap();
    assert!(d["features"][0].get("name").is_none());
    let before = d.clone();
    assert_eq!(rename(&mut d, "ghost", "x"), Err("the document has no step ghost".into()));
    assert_eq!(d, before);
}

#[test]
fn a_delete_keeps_the_marker_on_its_step_and_drops_what_named_the_steps() {
    let mut d = doc();
    set_note(&mut d, "pad", "check the draft").unwrap();
    set_note(&mut d, "lid", "for the lid").unwrap();
    delete(&mut d, &strings(&["pad", "round"])).unwrap();
    assert_eq!(order(&d), strings(&["base", "hole", "bore", "lid", "lone"]));
    assert_eq!(d["rollback"], json!(4));
    assert_eq!(d["suppressed"], json!(["lone"]));
    assert_eq!(d[NOTES], json!({"lid": "for the lid"}));
}

#[test]
fn a_delete_keeps_every_parameter_even_one_bound_to_a_deleted_field() {
    let mut d = doc();
    d["paramDefs"]["w"]["target"] = json!({"kind": "feature", "feature": "lid", "field": "length"});
    let (defs, table) = (d["paramDefs"].clone(), d["parameters"].clone());
    delete(&mut d, &strings(&["pad", "round", "lid"])).unwrap();
    assert_eq!(d["paramDefs"], defs, "w is bound to the lid and typed into the outline, d1 and r1 are bound alone");
    assert_eq!(d["parameters"], table);
    assert_eq!(d["features"][0]["entities"][0]["x1"], json!("w"));
    assert_eq!(d["features"][2]["distance"], json!("h"));
}

#[test]
fn deleting_the_only_rolled_back_step_plays_to_the_end() {
    let mut d = doc();
    delete(&mut d, &strings(&["lone"])).unwrap();
    assert!(d.get("rollback").is_none());
    assert!(d.get("suppressed").is_none());
    let mut d = doc();
    d.remove("rollback");
    delete(&mut d, &strings(&["hole", "ghost"])).unwrap();
    assert!(d.get("rollback").is_none());
    assert_eq!(order(&d).len(), 6);
}

#[test]
fn a_delete_of_nothing_the_document_has_is_refused_untouched() {
    let mut d = doc();
    let before = d.clone();
    assert!(delete(&mut d, &strings(&["ghost"])).is_err());
    assert!(delete(&mut d, &[]).is_err());
    assert_eq!(d, before);
}

#[test]
fn suppression_writes_only_steps_the_document_has() {
    let mut d = doc();
    set_suppressed(&mut d, &strings(&["pad", "ghost", "lone"]), true).unwrap();
    assert_eq!(d["suppressed"], json!(["lone", "pad"]));
    set_suppressed(&mut d, &strings(&["lone"]), false).unwrap();
    assert_eq!(d["suppressed"], json!(["pad"]));
    set_suppressed(&mut d, &strings(&["pad"]), false).unwrap();
    assert!(d.get("suppressed").is_none());
    assert!(set_suppressed(&mut d, &strings(&["ghost"]), true).is_err());
    assert!(d.get("suppressed").is_none());
}

#[test]
fn the_marker_is_dropped_once_it_reaches_the_end() {
    let mut d = doc();
    set_rollback(&mut d, 2);
    assert_eq!(d["rollback"], json!(2));
    set_rollback(&mut d, 0);
    assert_eq!(d["rollback"], json!(0));
    set_rollback(&mut d, 6);
    assert_eq!(d["rollback"], json!(6));
    set_rollback(&mut d, 7);
    assert!(d.get("rollback").is_none());
    set_rollback(&mut d, 99);
    assert!(d.get("rollback").is_none());
}

#[test]
fn a_move_reorders_or_is_refused_untouched() {
    let mut d = doc();
    move_to(&mut d, "lid", 1).unwrap();
    assert_eq!(order(&d), strings(&["base", "lid", "pad", "hole", "bore", "round", "lone"]));
    move_to(&mut d, "base", 99).unwrap_err();
    let before = d.clone();
    assert_eq!(move_to(&mut d, "bore", 3), Err("Extrude 2 uses Sketch 2, so it stays after it".into()));
    assert_eq!(d, before);
    move_to(&mut d, "lone", 0).unwrap();
    assert_eq!(order(&d)[0], "lone");
    move_to(&mut d, "lid", 99).unwrap();
    assert_eq!(order(&d).last().map(String::as_str), Some("lid"));
}

#[test]
fn a_note_is_written_beside_the_features_and_a_blank_one_removes_it() {
    let mut d = doc();
    assert_eq!(note(&d, "pad"), None);
    set_note(&mut d, "pad", " check the draft ").unwrap();
    set_note(&mut d, "bore", "deeper later").unwrap();
    assert_eq!(d[NOTES], json!({"pad": "check the draft", "bore": "deeper later"}));
    assert_eq!(note(&d, "pad").as_deref(), Some("check the draft"));
    set_note(&mut d, "pad", "").unwrap();
    assert_eq!(d[NOTES], json!({"bore": "deeper later"}));
    set_note(&mut d, "bore", "  ").unwrap();
    assert!(d.get(NOTES).is_none());
    assert!(set_note(&mut d, "ghost", "x").is_err());
    assert!(d.get(NOTES).is_none());
    d.insert(NOTES.into(), Value::from(3));
    assert!(set_note(&mut d, "pad", "x").is_err());
}
