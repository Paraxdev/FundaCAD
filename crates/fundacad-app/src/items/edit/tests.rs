use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Map, Value};

use super::*;
use crate::items::{BodyRef, Category, Rename};

fn doc() -> Map<String, Value> {
    json!({
        "features": [{"id": "s1", "type": "sketch"}, {"id": "s2", "type": "sketch", "name": "Old"}, {"id": "dp", "type": "datumPlane"}],
        "elements": [{"id": "e1", "name": "Rig"}],
        "bodyVisibility": {"body2": false},
    })
    .as_object()
    .unwrap()
    .clone()
}

fn built() -> Vec<BodyRef> {
    vec![BodyRef::new("body1", "Box"), BodyRef::new("body2", "Lid"), BodyRef::new("body3", "Pin")]
}

fn changes(v: &[(&str, bool)]) -> Vec<(String, bool)> {
    v.iter().map(|(k, b)| (k.to_string(), *b)).collect()
}

#[test]
fn each_category_writes_its_own_table() {
    let mut d = doc();
    set_visibility(&mut d, Category::Sketches, &changes(&[("s1", true)]), &HashMap::new()).unwrap();
    set_visibility(&mut d, Category::Datums, &changes(&[("dp", false)]), &HashMap::new()).unwrap();
    set_visibility(&mut d, Category::Bodies, &changes(&[("body1", false)]), &HashMap::new()).unwrap();
    assert_eq!(d["sketchVisibility"], json!({"s1": true}));
    assert_eq!(d["planeVisibility"], json!({"dp": false}));
    assert_eq!(d["bodyVisibility"], json!({"body1": false, "body2": false}));
}

#[test]
fn a_folder_head_stands_for_every_body_under_it() {
    let mut d = doc();
    let groups = HashMap::from([("g:e:e1".to_string(), vec!["body1".to_string(), "body3".to_string()])]);
    set_visibility(&mut d, Category::Bodies, &changes(&[("g:e:e1", false)]), &groups).unwrap();
    assert_eq!(d["bodyVisibility"], json!({"body1": false, "body2": false, "body3": false}));
}

#[test]
fn rows_cover_the_whole_category_with_its_defaults() {
    let d = doc();
    let rows = vis_rows(&d, &built(), Category::Bodies);
    assert_eq!(rows, BTreeMap::from([("body1".into(), true), ("body2".into(), false), ("body3".into(), true)]));
    let sketches = vis_rows(&d, &[], Category::Sketches);
    assert_eq!(sketches, BTreeMap::from([("s1".into(), false), ("s2".into(), false)]));
}

#[test]
fn show_only_hides_the_rest_and_invert_flips_each() {
    let rows = vis_rows(&doc(), &built(), Category::Bodies);
    let mut only = show_only(&rows, &["body2".to_string()]);
    only.sort();
    assert_eq!(only, changes(&[("body1", false), ("body2", true), ("body3", false)]));
    assert_eq!(invert(&rows), changes(&[("body1", false), ("body2", true), ("body3", false)]));
}

#[test]
fn a_second_alt_click_puts_the_rest_back() {
    let rows = BTreeMap::from([("a".to_string(), true), ("b".to_string(), false), ("c".to_string(), true)]);
    let mut solo = Solo::default();
    let mut first = solo.toggle(Category::Sketches, "b", &rows);
    first.sort();
    assert_eq!(first, changes(&[("a", false), ("b", true), ("c", false)]));
    let soloed = BTreeMap::from([("a".to_string(), false), ("b".to_string(), true), ("c".to_string(), false)]);
    assert_eq!(solo.toggle(Category::Sketches, "b", &soloed), changes(&[("a", true), ("b", false), ("c", true)]));
}

#[test]
fn an_ordinary_change_forgets_the_solo() {
    let rows = BTreeMap::from([("a".to_string(), true), ("b".to_string(), true)]);
    let mut solo = Solo::default();
    solo.toggle(Category::Sketches, "a", &rows);
    solo.forget(Category::Sketches);
    let mut again = solo.toggle(Category::Sketches, "a", &rows);
    again.sort();
    assert_eq!(again, changes(&[("a", true), ("b", false)]));
}

#[test]
fn renames_write_where_each_row_keeps_its_name() {
    let mut d = doc();
    rename(&mut d, &Rename::Body("body1".into()), "  Base ").unwrap();
    assert_eq!(d["bodyNames"], json!({"body1": "Base"}));
    rename(&mut d, &Rename::Body("body1".into()), " ").unwrap();
    assert!(!d.contains_key("bodyNames"));
    rename(&mut d, &Rename::Feature("s1".into()), "Profile").unwrap();
    assert_eq!(d["features"][0]["name"], "Profile");
    rename(&mut d, &Rename::Feature("s2".into()), "").unwrap();
    assert!(d["features"][1].get("name").is_none());
    rename(&mut d, &Rename::Element("e1".into()), "").unwrap();
    rename(&mut d, &Rename::Element("e1".into()), "Frame").unwrap();
    assert_eq!(d["elements"][0]["name"], "Frame");
    assert!(rename(&mut d, &Rename::Feature("gone".into()), "x").is_err());
}

const ORDER: [&str; 5] = ["a", "b", "c", "d", "e"];

fn order() -> Vec<String> {
    ORDER.map(String::from).to_vec()
}

const PLAIN: Mods = Mods { toggle: false, range: false };
const CTRL: Mods = Mods { toggle: true, range: false };
const SHIFT: Mods = Mods { toggle: false, range: true };

fn keys(s: &Selection) -> Vec<&str> {
    s.keys.iter().map(String::as_str).collect()
}

#[test]
fn a_plain_click_selects_one_and_ctrl_toggles() {
    let one = select_row(&Selection::default(), &order(), "b", PLAIN);
    assert_eq!((keys(&one), one.anchor.as_deref()), (vec!["b"], Some("b")));
    let two = select_row(&one, &order(), "d", CTRL);
    assert_eq!((keys(&two), two.anchor.as_deref()), (vec!["b", "d"], Some("d")));
    let back = select_row(&two, &order(), "b", CTRL);
    assert_eq!((keys(&back), back.anchor.as_deref()), (vec!["d"], Some("b")));
}

#[test]
fn shift_runs_from_the_same_anchor_either_way() {
    let anchored = select_row(&Selection::default(), &order(), "b", PLAIN);
    let wide = select_row(&anchored, &order(), "e", SHIFT);
    assert_eq!(keys(&wide), ["b", "c", "d", "e"]);
    let narrow = select_row(&wide, &order(), "c", SHIFT);
    assert_eq!((keys(&narrow), narrow.anchor.as_deref()), (vec!["b", "c"], Some("b")));
    let up = select_row(&select_row(&Selection::default(), &order(), "d", PLAIN), &order(), "a", SHIFT);
    assert_eq!(keys(&up), ["a", "b", "c", "d"]);
    assert_eq!(keys(&select_row(&Selection::default(), &order(), "c", SHIFT)), ["c"]);
}

#[test]
fn ctrl_shift_adds_the_run() {
    let mut sel = select_row(&Selection::default(), &order(), "a", PLAIN);
    sel = select_row(&sel, &order(), "c", CTRL);
    sel = select_row(&sel, &order(), "e", Mods { toggle: true, range: true });
    assert_eq!(keys(&sel), ["a", "c", "d", "e"]);
}

#[test]
fn a_folder_click_takes_adds_or_removes_its_members() {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(select_group(&s(&["x"]), &s(&["a", "b"]), PLAIN), s(&["a", "b"]));
    assert_eq!(select_group(&s(&["x", "a"]), &s(&["a", "b"]), CTRL), s(&["x", "a", "b"]));
    assert_eq!(select_group(&s(&["x", "a", "b"]), &s(&["a", "b"]), CTRL), s(&["x"]));
    assert_eq!(act_on(&s(&["a", "b"]), "b"), s(&["a", "b"]));
    assert_eq!(act_on(&s(&["a", "b"]), "c"), s(&["c"]));
}

#[test]
fn showing_what_is_shown_writes_nothing() {
    let mut d = doc();
    let before = d.clone();
    set_visibility(&mut d, Category::Bodies, &changes(&[("body1", true), ("body2", false)]), &HashMap::new()).unwrap();
    set_visibility(&mut d, Category::Sketches, &changes(&[("s1", false)]), &HashMap::new()).unwrap();
    assert_eq!(d, before);
}
