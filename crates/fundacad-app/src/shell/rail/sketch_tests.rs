use std::collections::HashSet;

use super::sketch::{face_of, family, family_of, tools, Slot, SLOTS};

#[test]
fn the_rail_carries_fundacad_1s_eighteen_slots_and_every_tool_once() {
    assert_eq!(SLOTS.len(), 18);
    let actions: Vec<&str> = tools().map(|t| t.action).collect();
    assert_eq!(actions.len(), actions.iter().collect::<HashSet<_>>().len());
    assert_eq!(actions.len(), 43);
}

#[test]
fn a_familys_face_is_the_variant_last_picked_else_its_first() {
    let (_, circles) = family("circle").unwrap();
    assert_eq!(face_of(circles, None).action, "circle");
    assert_eq!(face_of(circles, Some("circle3")).action, "circle3");
    assert_eq!(face_of(circles, Some("line")).action, "circle", "a tool from another family leaves the face");
}

#[test]
fn a_tool_armed_from_a_key_finds_its_family() {
    assert_eq!(family_of("centerRectangle"), Some("rectangle"));
    assert_eq!(family_of("fix"), Some("constrain"));
    assert_eq!(family_of("line"), None);
    for s in SLOTS {
        if let Slot::Family { id, items, .. } = s {
            assert!(items.iter().all(|t| family_of(t.action) == Some(*id)));
        }
    }
}
