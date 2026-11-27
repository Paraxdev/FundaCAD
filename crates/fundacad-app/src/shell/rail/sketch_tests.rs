use std::collections::HashSet;

use super::model::{face_of, family_of, find, sketch_rail, Entry, Style};
use super::sketch::{tools, SLOTS};

#[test]
fn the_rail_carries_fundacad_1s_eighteen_slots_and_every_tool_once() {
    assert_eq!(SLOTS.len(), 18);
    let actions: Vec<&str> = tools().map(|t| t.action).collect();
    assert_eq!(actions.len(), actions.iter().collect::<HashSet<_>>().len());
    assert_eq!(actions.len(), 43);
    let none = |_: &str| None;
    assert_eq!(sketch_rail(&none).len(), 18);
}

#[test]
fn a_familys_face_is_the_variant_last_picked_else_its_first() {
    let none = |_: &str| None;
    let rail = sketch_rail(&none);
    let circles = find(&rail, "sketch:circle").expect("circle family");
    assert_eq!(circles.style, Style::Variants);
    assert_eq!(face_of(circles, None).map(|t| t.action.as_ref()), Some("circle"));
    assert_eq!(face_of(circles, Some("circle3")).map(|t| t.action.as_ref()), Some("circle3"));
    assert_eq!(face_of(circles, Some("line")).map(|t| t.action.as_ref()), Some("circle"), "a tool from another family leaves the face");
}

#[test]
fn a_tool_armed_from_a_key_finds_its_family() {
    let none = |_: &str| None;
    let rail = sketch_rail(&none);
    assert_eq!(family_of(&rail, "centerRectangle").map(|f| f.id.as_ref()), Some("sketch:rectangle"));
    assert_eq!(family_of(&rail, "fix").map(|f| f.id.as_ref()), Some("sketch:constrain"));
    assert!(family_of(&rail, "line").is_none());
    assert!(matches!(&rail[0], Entry::Tool(t) if t.action == "line"));
}
