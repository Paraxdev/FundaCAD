use std::sync::Arc;

use glam::{DVec3, Vec3};

use super::properties;
use crate::inspect::tests::solid;
use crate::viewport::scene::Body;

fn body(id: &str, name: &str, min: Vec3, max: Vec3) -> Arc<Body> {
    Arc::new(Body { id: id.into(), name: name.into(), ..solid(min, max) })
}

#[test]
fn nothing_shown_measures_nothing() {
    let p = properties(&[], &[]);
    assert_eq!((p.picked.len(), p.faults.len(), p.found, p.centre_of_mass()), (0, 0, None, None));
}

#[test]
fn no_pick_sums_every_shown_body_and_a_pick_sums_only_it() {
    let shown = [
        body("b1", "Box", Vec3::new(3.0, -2.0, 5.0), Vec3::new(7.0, 5.0, 7.0)),
        body("b2", "Lid", Vec3::new(20.0, -2.0, 5.0), Vec3::new(24.0, 5.0, 7.0)),
    ];
    let all = properties(&shown, &[]);
    assert_eq!(all.picked.len(), 0);
    assert!((all.found.unwrap().volume - 112.0).abs() < 1e-9);
    assert!((all.centre_of_mass().unwrap() - Vec3::new(13.5, 1.5, 6.0)).length() < 1e-5);
    let one = properties(&shown, &["b2".into()]);
    assert_eq!(one.picked, ["Lid"]);
    assert!((one.found.unwrap().volume - 56.0).abs() < 1e-9);
    assert!((one.found.unwrap().com - DVec3::new(22.0, 1.5, 6.0)).length() < 1e-9);
}

#[test]
fn a_pick_on_a_hidden_body_measures_nothing() {
    let shown = [body("b1", "Box", Vec3::new(3.0, -2.0, 5.0), Vec3::new(7.0, 5.0, 7.0))];
    let p = properties(&shown, &["b9".into()]);
    assert_eq!((p.picked.len(), p.faults.len(), p.found), (0, 0, None));
}

#[test]
fn a_faulty_body_has_no_centre_of_mass() {
    let mut bad = Body { id: "b1".into(), name: "Box".into(), ..solid(Vec3::new(3.0, -2.0, 5.0), Vec3::new(7.0, 5.0, 7.0)) };
    bad.fields.insert("fault".into(), serde_json::json!("open edges"));
    let p = properties(&[Arc::new(bad)], &[]);
    assert_eq!(p.faults, ["Box is not a sound solid, open edges"]);
    assert!(p.found.is_some());
    assert_eq!(p.centre_of_mass(), None);
}
