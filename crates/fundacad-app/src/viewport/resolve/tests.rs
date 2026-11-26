use std::sync::Arc;

use glam::Vec3;
use serde_json::json;

use super::*;
use crate::viewport::scene::tests::block;

fn scene() -> Scene {
    let mut s = Scene::default();
    s.set(&[Arc::new(block(Vec3::new(2.0, -1.0, 3.0), Vec3::new(7.0, 4.0, 5.0), "f1"))]);
    s
}

fn lines() -> Vec<Vec<Vec<Vec3>>> {
    vec![vec![
        vec![Vec3::new(2.0, -1.0, 5.0), Vec3::new(7.0, -1.0, 5.0)],
        vec![Vec3::new(7.0, -1.0, 5.0), Vec3::new(7.0, 4.0, 5.0)],
        vec![Vec3::new(2.0, 4.0, 3.0), Vec3::new(2.0, 4.0, 4.0), Vec3::new(2.0, 4.0, 5.0)],
    ]]
}

#[test]
fn a_face_selector_finds_the_face_its_point_lies_on() {
    let at = json!({"kind": "face", "by": "nearest", "point": [6.5, 1.25, 5.0], "body": "body1"});
    assert_eq!(
        resolve(&scene(), &lines(), &at),
        Some(Pick::Face { body: "body1".into(), face: 5, point: [6.5, 1.25, 5.0], normal: [0.0, 0.0, 1.0] })
    );
    let side = json!({"kind": "face", "by": "nearest", "point": [2.0, 0.5, 3.75], "body": "body1"});
    assert!(matches!(resolve(&scene(), &lines(), &side), Some(Pick::Face { face: 0, .. })));
}

#[test]
fn an_edge_selector_finds_the_nearest_edge_and_its_midpoint() {
    let at = json!({"kind": "edge", "by": "nearest", "point": [7.0, 2.5, 5.0], "body": "body1"});
    assert_eq!(
        resolve(&scene(), &lines(), &at),
        Some(Pick::Edge { body: "body1".into(), edge: 1, mid: [7.0, 1.5, 5.0] })
    );
    let bent = json!({"kind": "edge", "by": "nearest", "point": [2.1, 4.0, 3.25], "body": "body1"});
    assert!(matches!(resolve(&scene(), &lines(), &bent), Some(Pick::Edge { edge: 2, .. })));
    assert_eq!(resolve(&scene(), &[vec![]], &at), None);
}

#[test]
fn a_body_id_resolves_while_the_build_has_it() {
    assert_eq!(resolve(&scene(), &lines(), &json!("body1")), Some(Pick::Body { body: "body1".into() }));
    assert_eq!(resolve(&scene(), &lines(), &json!("body9")), None);
    let gone = json!({"kind": "face", "by": "nearest", "point": [6.5, 1.25, 5.0], "body": "body9"});
    assert_eq!(resolve(&scene(), &lines(), &gone), None);
    assert_eq!(resolve(&scene(), &lines(), &json!({"kind": "face", "body": "body1"})), None);
}

#[test]
fn closest_points_land_inside_on_an_edge_or_on_a_corner() {
    let (a, b, c) = (Vec3::new(1.0, 1.0, 2.0), Vec3::new(5.0, 1.0, 2.0), Vec3::new(1.0, 4.0, 2.0));
    assert_eq!(closest_on_triangle(Vec3::new(2.0, 2.0, 7.0), a, b, c), Vec3::new(2.0, 2.0, 2.0));
    assert_eq!(closest_on_triangle(Vec3::new(3.0, -2.0, 2.0), a, b, c), Vec3::new(3.0, 1.0, 2.0));
    assert_eq!(closest_on_triangle(Vec3::new(-1.0, -1.0, 2.0), a, b, c), a);
}
