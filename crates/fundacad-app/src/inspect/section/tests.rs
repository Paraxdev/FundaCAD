use std::sync::Arc;

use glam::Vec3;

use super::*;
use crate::viewport::scene::tests::block;

#[test]
fn an_axis_cut_goes_through_the_centre_and_keeps_the_high_side_as_fundacad_1() {
    let s = Section::along(1, Vec3::new(3.0, -2.0, 5.0));
    assert_eq!(s, Section { normal: Vec3::Y, offset: -2.0, anchor: -2.0, flip: true });
    assert_eq!(s.plane(), [-0.0, -1.0, -0.0, 2.0]);
    assert_eq!((s.axis(), s.slide()), ("Y", 0.0));
    assert!(s.keeps(Vec3::new(9.0, -1.5, 1.0)));
    assert!(s.keeps(Vec3::new(9.0, -2.0, 1.0)));
    assert!(!s.keeps(Vec3::new(9.0, -2.1, 1.0)));
}

#[test]
fn a_flipped_cut_keeps_the_low_side() {
    let s = Section { flip: false, ..Section::along(2, Vec3::new(3.0, -2.0, 5.0)) };
    assert_eq!(s.plane(), [0.0, 0.0, 1.0, 5.0]);
    assert!(s.keeps(Vec3::new(0.0, 0.0, 4.5)));
    assert!(!s.keeps(Vec3::new(0.0, 0.0, 5.5)));
}

#[test]
fn the_slide_counts_from_where_the_cut_was_armed() {
    let s = Section { offset: 3.5, ..Section::along(0, Vec3::new(7.0, -2.0, 5.0)) };
    assert_eq!((s.anchor, s.slide()), (7.0, -3.5));
}

#[test]
fn a_face_cut_takes_its_unit_normal_and_a_flat_normal_is_refused() {
    let s = Section::on_face(Vec3::new(3.0, -2.0, 5.0), Vec3::new(0.0, 0.0, -4.0)).unwrap();
    assert_eq!(s, Section { normal: Vec3::NEG_Z, offset: -5.0, anchor: -5.0, flip: true });
    assert_eq!(s.axis(), "Face");
    assert_eq!(Section::on_face(Vec3::ONE, Vec3::ZERO), None);
}

#[test]
fn steps_are_round_and_near_a_tenth_of_the_model() {
    assert_eq!(step(0.0), 0.001);
    assert_eq!(step(10.0), 1.0);
    assert_eq!(step(37.0), 5.0);
    assert_eq!(step(160.0), 20.0);
    assert_eq!(step(700.0), 100.0);
}

fn bodies(ids: &[&str]) -> Vec<Arc<crate::viewport::scene::Body>> {
    ids.iter()
        .map(|id| Arc::new(crate::viewport::scene::Body { id: id.to_string(), ..block(Vec3::new(3.0, -2.0, 5.0), Vec3::new(7.0, 5.0, 7.0), "ex1") }))
        .collect()
}

fn ids(b: &[Arc<crate::viewport::scene::Body>]) -> Vec<String> {
    b.iter().map(|b| b.id.clone()).collect()
}

#[test]
fn isolate_keeps_the_named_bodies_or_all_when_none_match() {
    let all = bodies(&["b1", "b2", "b3"]);
    assert_eq!(ids(&isolated::<&str>(all.clone(), None)), ["b1", "b2", "b3"]);
    assert_eq!(ids(&isolated(all.clone(), Some(&["b2"]))), ["b2"]);
    assert_eq!(ids(&isolated(all.clone(), Some(&["b3", "b1"]))), ["b1", "b3"]);
    assert_eq!(ids(&isolated(all.clone(), Some(&["gone"]))), ["b1", "b2", "b3"]);
    assert_eq!(ids(&isolated::<&str>(all, Some(&[]))), ["b1", "b2", "b3"]);
}

fn doc_with(cut: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    let mut doc = serde_json::Map::new();
    doc.insert("features".into(), serde_json::json!([]));
    doc.insert(KEY.into(), cut);
    doc
}

#[test]
fn a_saved_fundacad_1_cut_reads_with_its_slide_and_side() {
    let doc = doc_with(serde_json::json!({ "origin": [3.0, -2.0, 5.0], "normal": [0.0, 0.0, 2.0], "offset": 1.5, "side": 1, "ghost": "faint" }));
    assert_eq!(read(&doc), Some(Section { normal: Vec3::Z, offset: 6.5, anchor: 5.0, flip: true }));
    let low = doc_with(serde_json::json!({ "origin": [3.0, -2.0, 5.0], "normal": [1.0, 0.0, 0.0], "side": -1 }));
    assert_eq!(read(&low), Some(Section { normal: Vec3::X, offset: 3.0, anchor: 3.0, flip: false }));
}

#[test]
fn a_bad_or_missing_cut_reads_as_none() {
    assert_eq!(read(&serde_json::Map::new()), None);
    assert_eq!(read(&doc_with(serde_json::json!({ "origin": [3.0, -2.0, 5.0], "normal": [0.0, 0.0, 0.0] }))), None);
    assert_eq!(read(&doc_with(serde_json::json!({ "origin": [3.0, -2.0], "normal": [0.0, 0.0, 1.0] }))), None);
    assert_eq!(read(&doc_with(serde_json::json!({ "normal": [0.0, 0.0, 1.0] }))), None);
    assert_eq!(read(&doc_with(serde_json::json!("cut"))), None);
}

#[test]
fn writing_a_cut_keeps_unknown_fields_and_reads_back_the_same() {
    let mut doc = doc_with(serde_json::json!({ "origin": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0], "ghost": "strong", "dial": 7 }));
    let s = Section { normal: Vec3::Y, offset: -2.0, anchor: 4.0, flip: false };
    write(&mut doc, Some(&s));
    assert_eq!(
        doc[KEY],
        serde_json::json!({ "origin": [0.0, 4.0, 0.0], "normal": [0.0, 1.0, 0.0], "offset": -6.0, "side": -1, "ghost": "strong", "dial": 7 })
    );
    assert_eq!(read(&doc), Some(s));
    let mut fresh = serde_json::Map::new();
    write(&mut fresh, Some(&Section { flip: true, ..s }));
    assert_eq!(fresh[KEY]["ghost"], "soft");
    assert_eq!(fresh[KEY]["side"], 1);
    write(&mut fresh, None);
    assert!(fresh.is_empty());
}

#[test]
fn for_save_borrows_an_unchanged_cut_and_writes_a_changed_one() {
    let doc = doc_with(serde_json::json!({ "origin": [3.0, -2.0, 5.0], "normal": [1.0, 0.0, 0.0], "side": -1 }));
    let same = Section { normal: Vec3::X, offset: 3.0, anchor: 3.0, flip: false };
    assert!(matches!(for_save(&doc, Some(&same)), std::borrow::Cow::Borrowed(d) if *d == doc));
    let moved = Section { offset: 4.5, ..same };
    let saved = for_save(&doc, Some(&moved));
    assert!(matches!(saved, std::borrow::Cow::Owned(_)));
    assert_eq!(read(&saved), Some(moved));
    assert_ne!(*saved, doc);
    let off = for_save(&doc, None);
    assert_eq!(off.keys().collect::<Vec<_>>(), ["features"]);
    let none = serde_json::Map::new();
    assert!(matches!(for_save(&none, None), std::borrow::Cow::Borrowed(_)));
}
