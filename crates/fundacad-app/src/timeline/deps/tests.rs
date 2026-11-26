use serde_json::json;

use super::{can_move, dependents, related, users, uses};
use crate::timeline::fixture::{doc, strings};

#[test]
fn a_feature_uses_its_sketch_and_the_maker_of_each_body_it_names() {
    let d = doc();
    let want: Vec<Vec<String>> =
        [&[][..], &["base"], &[], &["pad", "hole"], &["pad"], &[], &[]].iter().map(|l| strings(l)).collect();
    assert_eq!(uses(&d), want);
    let by: Vec<Vec<String>> =
        [&["pad"][..], &["bore", "round"], &["bore"], &[], &[], &[], &[]].iter().map(|l| strings(l)).collect();
    assert_eq!(users(&d), by);
}

#[test]
fn a_parameter_named_like_a_step_is_a_value_not_a_reference() {
    let mut d = doc();
    d["parameters"]["hole"] = json!(4);
    assert_eq!(uses(&d)[3], strings(&["pad"]), "the sketch name now reads as the parameter");
    d["parameters"].as_object_mut().unwrap().remove("hole");
    assert_eq!(uses(&d)[3], strings(&["pad", "hole"]));
}

#[test]
fn an_empty_document_uses_nothing() {
    let d = json!({}).as_object().unwrap().clone();
    assert!(uses(&d).is_empty() && users(&d).is_empty());
    assert!(related(&d, &strings(&["x"])).is_empty());
    assert!(dependents(&d, &strings(&["x"])).is_empty());
}

#[test]
fn related_takes_what_the_picked_use_and_what_uses_them() {
    let d = doc();
    assert_eq!(related(&d, &[]), Vec::<String>::new());
    assert_eq!(related(&d, &strings(&["round"])), strings(&["pad", "round"]));
    assert_eq!(related(&d, &strings(&["pad"])), strings(&["base", "pad", "bore", "round"]));
    assert_eq!(related(&d, &strings(&["lid", "base"])), strings(&["base", "pad", "lid"]));
    assert_eq!(related(&d, &strings(&["ghost"])), Vec::<String>::new());
}

#[test]
fn a_step_cannot_move_above_what_it_uses_or_below_what_uses_it() {
    let d = doc();
    assert_eq!(can_move(&d, "pad", 0), Err("Extrude 1 uses Outline, so it stays after it".into()));
    assert_eq!(can_move(&d, "pad", 4), Err("Extrude 2 uses Extrude 1, so it stays before it".into()));
    assert_eq!(can_move(&d, "bore", 2), Err("Extrude 2 uses Sketch 2, so it stays after it".into()));
    assert_eq!(can_move(&d, "pad", 2), Ok(()));
    assert_eq!(can_move(&d, "pad", 1), Ok(()), "staying put is no move");
    assert_eq!(can_move(&d, "lid", 0), Ok(()));
    assert_eq!(can_move(&d, "lone", 99), Ok(()));
    assert_eq!(can_move(&d, "ghost", 0), Err("the document has no step ghost".into()));
}

#[test]
fn an_order_the_document_already_breaks_does_not_hold_a_move_back() {
    let mut d = doc();
    d["features"][1]["sketch"] = json!("hole");
    assert_eq!(can_move(&d, "pad", 6), Err("Extrude 2 uses Extrude 1, so it stays before it".into()));
    d["bodyIds"] = json!({});
    assert_eq!(can_move(&d, "pad", 6), Ok(()), "pad already sits above the sketch it uses");
}

#[test]
fn a_delete_names_the_steps_left_that_used_it() {
    let d = doc();
    assert_eq!(dependents(&d, &strings(&["base"])), strings(&["pad"]));
    assert_eq!(dependents(&d, &strings(&["pad"])), strings(&["bore", "round"]));
    assert_eq!(dependents(&d, &strings(&["pad", "bore"])), strings(&["round"]));
    assert_eq!(dependents(&d, &strings(&["lid"])), Vec::<String>::new());
    assert_eq!(dependents(&d, &[]), Vec::<String>::new());
}
