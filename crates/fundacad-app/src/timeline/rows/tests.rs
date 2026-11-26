use super::Rows;
use crate::timeline::fixture::strings;

fn order() -> Vec<String> {
    strings(&["s1", "e1", "s2", "e2", "f1"])
}

fn rows(keys: &[&str], anchor: Option<&str>) -> Rows {
    Rows { keys: strings(keys), anchor: anchor.map(str::to_owned) }
}

#[test]
fn a_plain_click_takes_one_row_and_anchors_it() {
    assert_eq!(Rows::default().click(&order(), "e1", false, false), rows(&["e1"], Some("e1")));
    assert_eq!(rows(&["s1", "s2"], Some("s1")).click(&order(), "e2", false, false), rows(&["e2"], Some("e2")));
}

#[test]
fn ctrl_toggles_one_row_and_moves_the_anchor() {
    let o = order();
    let one = Rows::default().click(&o, "e1", true, false);
    assert_eq!(one, rows(&["e1"], Some("e1")));
    let two = one.click(&o, "f1", true, false);
    assert_eq!(two, rows(&["e1", "f1"], Some("f1")));
    assert_eq!(two.click(&o, "e1", true, false), rows(&["f1"], Some("e1")));
}

#[test]
fn shift_takes_the_run_from_the_anchor_either_way_and_keeps_it() {
    let o = order();
    let at = rows(&["e1"], Some("e1"));
    assert_eq!(at.click(&o, "e2", false, true), rows(&["e1", "s2", "e2"], Some("e1")));
    assert_eq!(at.click(&o, "s1", false, true), rows(&["s1", "e1"], Some("e1")));
    assert_eq!(rows(&["e1", "s2", "e2"], Some("e1")).click(&o, "e1", false, true), rows(&["e1"], Some("e1")));
}

#[test]
fn shift_without_a_usable_anchor_takes_just_the_row() {
    assert_eq!(Rows::default().click(&order(), "s2", false, true), rows(&["s2"], Some("s2")));
    assert_eq!(rows(&["gone"], Some("gone")).click(&order(), "s2", false, true), rows(&["s2"], Some("s2")));
}

#[test]
fn ctrl_shift_adds_the_run_to_what_was_picked() {
    let picked = rows(&["f1", "e1"], Some("e1"));
    assert_eq!(picked.click(&order(), "e2", true, true), rows(&["f1", "e1", "s2", "e2"], Some("e1")));
}

#[test]
fn an_action_covers_the_selection_only_when_it_holds_the_row() {
    let picked = rows(&["e1", "e2"], Some("e1"));
    assert_eq!(picked.act_on("e2"), strings(&["e1", "e2"]));
    assert_eq!(picked.act_on("s1"), strings(&["s1"]));
    assert_eq!(Rows::default().act_on("s1"), strings(&["s1"]));
}

#[test]
fn rows_the_document_lost_are_dropped() {
    let mut picked = rows(&["e1", "e2", "f1"], Some("e2"));
    picked.keep(&strings(&["e1", "f1"]));
    assert_eq!(picked, rows(&["e1", "f1"], None));
    picked.keep(&strings(&["e1", "f1"]));
    assert_eq!(picked, rows(&["e1", "f1"], None));
}

#[test]
fn sole_is_the_one_picked_row() {
    assert_eq!(Rows::default().sole(), None);
    assert_eq!(rows(&["e2"], Some("e2")).sole(), Some("e2"));
    assert_eq!(rows(&["e1", "e2"], None).sole(), None);
    assert!(rows(&["e1"], None).has("e1") && !rows(&["e1"], None).has("e2"));
}

#[test]
fn a_delete_clears_the_selection_only_when_it_held_a_deleted_row() {
    let two = rows(&["e2", "s1"], Some("e2"));
    assert_eq!(two.after_delete(&strings(&["f1"])), two, "a menu delete on a row not picked keeps the pick");
    assert_eq!(two.after_delete(&[]), two);
    assert_eq!(two.after_delete(&strings(&["f1", "s1"])), Rows::default());
    assert_eq!(Rows::default().after_delete(&strings(&["e1"])), Rows::default());
}
