use std::sync::Arc;

use glam::Vec3;

use super::*;
use crate::viewport::scene::tests::block;

#[test]
fn an_axis_cut_goes_through_the_centre_and_keeps_the_low_side() {
    let s = Section::along(1, Vec3::new(3.0, -2.0, 5.0));
    assert_eq!(s, Section { normal: Vec3::Y, offset: -2.0, flip: false });
    assert_eq!(s.plane(), [0.0, 1.0, 0.0, -2.0]);
    assert_eq!(s.axis(), "Y");
    assert!(s.keeps(Vec3::new(9.0, -2.5, 1.0)));
    assert!(s.keeps(Vec3::new(9.0, -2.0, 1.0)));
    assert!(!s.keeps(Vec3::new(9.0, -1.9, 1.0)));
}

#[test]
fn a_flipped_cut_keeps_the_other_side() {
    let s = Section { flip: true, ..Section::along(2, Vec3::new(3.0, -2.0, 5.0)) };
    assert_eq!(s.plane(), [-0.0, -0.0, -1.0, -5.0]);
    assert!(s.keeps(Vec3::new(0.0, 0.0, 5.5)));
    assert!(!s.keeps(Vec3::new(0.0, 0.0, 4.5)));
}

#[test]
fn a_face_cut_takes_its_unit_normal_and_a_flat_normal_is_refused() {
    let s = Section::on_face(Vec3::new(3.0, -2.0, 5.0), Vec3::new(0.0, 0.0, -4.0)).unwrap();
    assert_eq!(s, Section { normal: Vec3::NEG_Z, offset: -5.0, flip: false });
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
