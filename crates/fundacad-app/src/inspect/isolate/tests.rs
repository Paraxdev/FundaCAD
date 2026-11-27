use std::collections::BTreeMap;

use super::{active, unique};

fn rows(r: &[(&str, bool)]) -> BTreeMap<String, bool> {
    r.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn ids(i: &[&str]) -> Vec<String> {
    i.iter().map(|s| s.to_string()).collect()
}

#[test]
fn unique_keeps_the_first_of_each_wherever_it_repeats() {
    assert_eq!(unique(ids(&[])), Vec::<String>::new());
    assert_eq!(unique(ids(&["b7"])), ids(&["b7"]));
    assert_eq!(unique(ids(&["b7", "b2", "b7", "b2", "b9"])), ids(&["b7", "b2", "b9"]));
}

#[test]
fn active_while_the_eyes_show_only_the_kept_bodies() {
    let r = rows(&[("b1", false), ("b2", true), ("b3", false)]);
    assert_eq!(active(&r, &ids(&["b2"])), Some(1));
    let r = rows(&[("b1", true), ("b2", false), ("b3", true)]);
    assert_eq!(active(&r, &ids(&["b3", "b1"])), Some(2));
}

#[test]
fn not_active_once_an_eye_differs_or_the_kept_bodies_are_gone() {
    let r = rows(&[("b1", true), ("b2", true), ("b3", false)]);
    assert_eq!(active(&r, &ids(&["b2"])), None);
    let r = rows(&[("b1", false), ("b2", false), ("b3", false)]);
    assert_eq!(active(&r, &ids(&["b2"])), None);
    let r = rows(&[("b1", false), ("b2", false)]);
    assert_eq!(active(&r, &ids(&["gone"])), None);
    assert_eq!(active(&r, &[]), None);
    assert_eq!(active(&BTreeMap::new(), &ids(&["b1"])), None);
}

#[test]
fn a_stale_id_beside_a_live_one_counts_only_the_live_one() {
    let r = rows(&[("b1", false), ("b2", true)]);
    assert_eq!(active(&r, &ids(&["b2", "gone"])), Some(1));
}
