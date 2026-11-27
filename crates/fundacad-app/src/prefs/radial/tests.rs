use gpui::Modifiers;

use super::{context_of, defaults, gesture_press, items_from, mouse_trigger, Drag, Situation};

#[test]
fn only_alt_right_is_free_for_the_mouse() {
    assert_eq!(mouse_trigger(true, Drag::AltRight), Ok(Some(Drag::AltRight)));
    assert_eq!(mouse_trigger(true, Drag::None), Ok(None));
    assert_eq!(mouse_trigger(false, Drag::AltRight), Ok(None));
    assert!(mouse_trigger(true, Drag::Right).unwrap_err().contains("orbit"));
    assert!(mouse_trigger(true, Drag::Middle).unwrap_err().contains("pan"));
}

#[test]
fn a_right_press_opens_the_ring_only_with_alt_and_the_menu_on() {
    let alt = Modifiers { alt: true, ..Default::default() };
    assert!(gesture_press(true, Drag::AltRight, &alt));
    assert!(!gesture_press(true, Drag::AltRight, &Modifiers::default()));
    assert!(!gesture_press(false, Drag::AltRight, &alt));
    assert!(!gesture_press(true, Drag::Right, &alt));
    assert!(!gesture_press(true, Drag::None, &alt));
}

#[test]
fn a_stored_trigger_that_is_not_known_is_the_default() {
    assert_eq!(Drag::parse(Some("middle")), Drag::Middle);
    assert_eq!(Drag::parse(Some("left")), Drag::AltRight);
    assert_eq!(Drag::parse(None), Drag::AltRight);
}

#[test]
fn the_context_follows_the_sketch_then_the_selection() {
    assert_eq!(context_of(true, 3), Situation::Sketch);
    assert_eq!(context_of(false, 0), Situation::Model);
    assert_eq!(context_of(false, 2), Situation::Selection);
}

#[test]
fn stored_lists_replace_the_defaults_one_context_at_a_time() {
    let stored = serde_json::json!({"model": ["fit", "measure"]});
    assert_eq!(items_from(Some(stored.clone()), Situation::Model), ["fit", "measure"]);
    assert_eq!(items_from(Some(stored), Situation::Selection), defaults(Situation::Selection));
    assert_eq!(items_from(Some(serde_json::json!({"sketch": "not a list"})), Situation::Sketch), defaults(Situation::Sketch));
    assert_eq!(items_from(None, Situation::Model).len(), 8);
}
