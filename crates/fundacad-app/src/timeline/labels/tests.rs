use serde_json::json;

use super::{deleted_line, menu_text, name_of, numbered, step_label, stepped};
use crate::timeline::fixture::{doc, strings};
use crate::timeline::{features, ops};

#[test]
fn an_unnamed_step_is_counted_among_its_type_and_a_named_one_keeps_its_name() {
    let d = doc();
    let all = features(&d);
    let names: Vec<String> = all.iter().map(|f| numbered(f, &all)).collect();
    assert_eq!(names, strings(&["Outline", "Extrude 1", "Sketch 2", "Extrude 2", "Fillet 1", "Box 1", "Fillet 2"]));
    assert_eq!(name_of(&d, "ghost"), "ghost");
}

#[test]
fn deletes_and_adds_name_the_one_step_or_count_them() {
    let d = doc();
    let mut one = d.clone();
    ops::delete(&mut one, &strings(&["hole"])).unwrap();
    assert_eq!(step_label(&d, &one), "Delete Sketch 2");
    let mut two = d.clone();
    ops::delete(&mut two, &strings(&["hole", "lid"])).unwrap();
    assert_eq!(step_label(&d, &two), "Delete 2 steps");
    assert_eq!(step_label(&one, &d), "Sketch 2");
    assert_eq!(step_label(&two, &d), "Add 2 steps");
}

#[test]
fn a_move_names_the_step_that_moved() {
    let d = doc();
    let mut m = d.clone();
    ops::move_to(&mut m, "lid", 1).unwrap();
    assert_eq!(step_label(&d, &m), "Move Box 1");
    assert_eq!(step_label(&m, &d), "Move Box 1");
    let mut many = d.clone();
    many["features"].as_array_mut().unwrap().reverse();
    assert_eq!(step_label(&d, &many), "Move 6 steps");
}

#[test]
fn an_edit_of_one_step_is_a_rename_or_an_edit_of_it() {
    let d = doc();
    let mut r = d.clone();
    ops::rename(&mut r, "pad", "Plate").unwrap();
    assert_eq!(step_label(&d, &r), "Rename Extrude 1");
    assert_eq!(step_label(&r, &d), "Rename Plate");
    let mut e = d.clone();
    e["features"][1]["distance"] = json!(9);
    assert_eq!(step_label(&d, &e), "edit of Extrude 1");
    e["features"][4]["radius"] = json!(2.5);
    assert_eq!(step_label(&d, &e), "Edit 2 steps");
}

#[test]
fn suppression_rollback_and_notes_have_their_own_words() {
    let d = doc();
    let mut s = d.clone();
    ops::set_suppressed(&mut s, &strings(&["pad"]), true).unwrap();
    assert_eq!(step_label(&d, &s), "Suppress Extrude 1");
    ops::set_suppressed(&mut s, &strings(&["bore"]), true).unwrap();
    assert_eq!(step_label(&d, &s), "Suppress 2 steps");
    let mut u = d.clone();
    ops::set_suppressed(&mut u, &strings(&["lone"]), false).unwrap();
    assert_eq!(step_label(&d, &u), "Unsuppress Fillet 2");
    let mut r = d.clone();
    ops::set_rollback(&mut r, 2);
    assert_eq!(step_label(&d, &r), "Roll back before Sketch 2");
    ops::set_rollback(&mut r, 7);
    assert_eq!(step_label(&d, &r), "Roll to the end");
    let mut n = d.clone();
    ops::set_note(&mut n, "pad", "check").unwrap();
    assert_eq!(step_label(&d, &n), "Note on Extrude 1");
    assert_eq!(step_label(&n, &d), "Note on Extrude 1");
    ops::set_note(&mut n, "lid", "check").unwrap();
    assert_eq!(step_label(&d, &n), "Notes");
}

#[test]
fn a_parameter_change_names_it_and_nothing_at_all_is_an_edit() {
    let d = doc();
    let mut p = d.clone();
    fundacad_client::set_param(&mut p, "w", 16.).unwrap();
    assert_eq!(step_label(&d, &p), "Parameters", "h follows w, so two changed");
    let mut q = d.clone();
    q["paramDefs"]["r2"]["unit"] = json!("deg");
    assert_eq!(step_label(&d, &q), "Parameter r2");
    assert_eq!(step_label(&d, &d), "Edit");
}

#[test]
fn undo_texts_clip_a_long_name() {
    assert_eq!(menu_text(true, None), "Undo");
    assert_eq!(menu_text(false, None), "Redo");
    assert_eq!(menu_text(true, Some("Fillet 2")), "Undo Fillet 2");
    let long = "Delete the left mounting flange web";
    assert_eq!(menu_text(false, Some(long)), "Redo Delete the left mounting flange…");
    assert_eq!(stepped(true, "Fillet 2"), "Undid Fillet 2");
    assert_eq!(stepped(false, "edit of Extrude 1"), "Redid edit of Extrude 1");
}

#[test]
fn a_delete_says_what_went_and_what_used_it() {
    let d = doc();
    assert_eq!(deleted_line(&d, &strings(&["lid"]), &[]), "Deleted Box 1");
    assert_eq!(deleted_line(&d, &strings(&["base"]), &strings(&["pad"])), "Deleted Outline, Extrude 1 used it");
    assert_eq!(
        deleted_line(&d, &strings(&["pad", "hole"]), &strings(&["bore", "round", "lone"])),
        "Deleted 2 steps, Extrude 2, Fillet 1 and Fillet 2 used them"
    );
}
