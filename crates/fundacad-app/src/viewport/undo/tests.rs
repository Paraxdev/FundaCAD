use super::*;
use serde_json::json;

fn doc(v: i64) -> Doc {
    json!({ "v": v }).as_object().unwrap().clone()
}

#[test]
fn ten_drags_of_one_face_undo_as_one_step() {
    let mut u = UndoStack::default();
    for v in 0..10 {
        u.record(doc(v), Some("e1 distance".into()), None);
    }
    assert_eq!(u.undo(doc(10)), Some(doc(0)));
    assert!(!u.can_undo());
    assert_eq!(u.redo(doc(0)), Some(doc(10)));
}

#[test]
fn another_key_or_a_close_starts_a_new_step() {
    let mut u = UndoStack::default();
    u.record(doc(0), Some("a".into()), None);
    u.record(doc(1), Some("b".into()), None);
    u.close();
    u.record(doc(2), Some("b".into()), None);
    u.record(doc(3), None, None);
    u.record(doc(4), None, None);
    let mut back = Vec::new();
    let mut now = doc(5);
    while let Some(d) = u.undo(now.clone()) {
        back.push(d["v"].as_i64().unwrap());
        now = d;
    }
    assert_eq!(back, [4, 3, 2, 1, 0]);
}

#[test]
fn a_new_step_drops_the_redo_and_an_undo_ends_the_merge() {
    let mut u = UndoStack::default();
    u.record(doc(0), Some("a".into()), None);
    assert_eq!(u.undo(doc(1)), Some(doc(0)));
    u.record(doc(0), Some("a".into()), None);
    assert!(!u.can_redo());
    assert!(u.can_undo());
    assert_eq!(u.undo(doc(2)), Some(doc(0)));
    u.record(doc(0), Some("a".into()), None);
    u.record(doc(2), Some("a".into()), None);
    assert_eq!(u.undo(doc(3)), Some(doc(0)), "the second drag merged into the first after the undo");
}

#[test]
fn a_step_goes_by_its_own_label_or_by_what_changed() {
    let named =
        |n: &str| json!({ "features": [{"id": "f1", "type": "fillet", "name": n}] }).as_object().unwrap().clone();
    let mut u = UndoStack::default();
    assert_eq!(u.label(true, &named("A")), None);
    u.record(named("A"), None, None);
    assert_eq!(u.label(true, &named("B")).as_deref(), Some("Rename A"));
    assert_eq!(u.label(false, &named("B")), None);
    u.record(named("B"), None, Some("Move B".into()));
    assert_eq!(u.label(true, &named("C")).as_deref(), Some("Move B"));
    let back = u.undo(named("C")).unwrap();
    assert_eq!(u.label(false, &back).as_deref(), Some("Move B"), "the label travels with the step");
    assert_eq!(u.label(true, &back).as_deref(), Some("Rename A"));
}
