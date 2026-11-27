use super::{icon_of, ring_of, RING_SLOTS};
use crate::prefs::radial::{defaults, Situation};

fn ids(n: usize) -> Vec<String> {
    (0..n).map(|i| format!("c{i}")).collect()
}

fn ring(ids: &[String], have: impl Fn(&str) -> bool) -> Vec<String> {
    ring_of(ids, |id| have(id).then(|| id.to_string()), |rest| format!("More[{}]", rest.join(",")))
}

#[test]
fn eight_fit_on_the_ring() {
    assert_eq!(ring(&ids(RING_SLOTS), |_| true).len(), RING_SLOTS);
}

#[test]
fn the_overflow_goes_under_more() {
    let r = ring(&ids(10), |_| true);
    assert_eq!(r.len(), RING_SLOTS);
    assert_eq!(r[RING_SLOTS - 1], "More[c7,c8,c9]");
}

#[test]
fn ids_with_no_command_are_left_out_before_counting() {
    let mut list = ids(9);
    list.push(String::new());
    let r = ring(&list, |id| id != "c2");
    assert_eq!(r.len(), RING_SLOTS);
    assert!(!r.iter().any(|s| s == "c2"));
}

#[test]
fn every_default_has_an_icon() {
    for c in [Situation::Model, Situation::Selection, Situation::Sketch] {
        for id in defaults(c) {
            assert!(icon_of(&id).is_some(), "{id}");
        }
    }
}
