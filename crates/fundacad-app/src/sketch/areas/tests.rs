use glam::{DVec2, DVec3, Vec3};
use serde_json::{json, Map, Value};

use super::*;

fn square(x: f64, y: f64, s: f64) -> Vec<DVec2> {
    vec![DVec2::new(x, y), DVec2::new(x + s, y), DVec2::new(x + s, y + s * 0.5), DVec2::new(x, y + s * 0.5)]
}

fn raised(z: f64) -> Plane {
    Plane { origin: DVec3::new(3.0, -2.0, z), u: DVec3::X, v: DVec3::Y, n: DVec3::Z }
}

#[test]
fn an_outline_with_one_inside_is_one_area_with_a_hole_and_an_island_is_its_own() {
    let outer = square(10.0, 5.0, 40.0);
    let hole = square(14.0, 7.0, 20.0);
    let island = square(16.0, 8.0, 4.0);
    assert!(of_outlines("s", raised(4.0), &[]).is_empty());
    let one = of_outlines("s", raised(4.0), std::slice::from_ref(&outer));
    assert_eq!(one.len(), 1);
    assert_eq!((one[0].sketch.as_str(), one[0].outline.clone(), one[0].holes.clone()), ("s", outer.clone(), vec![]));
    let many = of_outlines("s", raised(4.0), &[outer.clone(), hole.clone(), island.clone()]);
    assert_eq!(many.len(), 2);
    assert_eq!((many[0].outline.clone(), many[0].holes.clone()), (outer, vec![hole]));
    assert_eq!((many[1].outline.clone(), many[1].holes.clone()), (island, vec![]));
    for a in &many {
        assert_eq!(a.point[2], 4.0);
        assert!(a.holds("s", a.point));
    }
    assert!(!many[0].holds("s", many[1].point));
    assert!(!many[0].holds("t", many[0].point));
    assert!(!many[0].holds("s", [many[0].point[0], many[0].point[1], 5.0]));
}

#[test]
fn a_ray_takes_the_nearest_area_it_lands_in() {
    let low = of_outlines("low", raised(0.0), &[square(-10.0, -10.0, 40.0)]);
    let high = of_outlines("high", raised(6.0), &[square(-10.0, -10.0, 40.0), square(0.0, -5.0, 8.0)]);
    let all: Vec<Area> = low.iter().chain(&high).cloned().collect();
    let down = Vec3::new(0.0, 0.0, -1.0);
    let at = |x: f32, y: f32| under(&all, Vec3::new(x, y, 50.0), down).map(|a| a.sketch.clone());
    assert_eq!(at(0.0, 0.0), Some("high".into()));
    assert_eq!(at(6.0, -5.0), Some("low".into()), "through the hole of the upper one");
    assert_eq!(at(80.0, 0.0), None);
    let up = under(&all, Vec3::new(0.0, 0.0, -50.0), Vec3::Z).map(|a| a.sketch.clone());
    assert_eq!(up, Some("low".into()));
    assert!(under(&[], Vec3::ZERO, down).is_none());
}

fn doc(features: Value, extra: Value) -> Map<String, Value> {
    let mut d = json!({"features": features}).as_object().cloned().unwrap();
    d.extend(extra.as_object().cloned().unwrap());
    d
}

fn sketch(id: &str, plane: &str) -> Value {
    json!({"id": id, "type": "sketch", "plane": plane,
        "entities": [{"type": "rectangle", "id": "r1", "x": 10, "y": 5, "width": 30, "height": 20},
                     {"type": "circle", "id": "c1", "x": 17, "y": 10, "radius": 2}]})
}

#[test]
fn shown_sketches_follow_visibility_suppression_rollback_and_the_open_one() {
    let fs = json!([sketch("s1", "XY"), sketch("s2", "XZ"), sketch("s3", "XY")]);
    let ids = |d: &Map<String, Value>, all: bool, open: Option<&str>| {
        shown(d, all, open).into_iter().map(|s| s.sketch).collect::<Vec<_>>()
    };
    let d = doc(fs.clone(), json!({}));
    assert!(ids(&d, false, None).is_empty());
    assert_eq!(ids(&d, true, None), vec!["s1", "s2", "s3"]);
    assert_eq!(ids(&d, true, Some("s2")), vec!["s1", "s3"]);
    let d = doc(fs.clone(), json!({"sketchVisibility": {"s2": true}, "suppressed": ["s3"], "rollback": 2}));
    assert_eq!(ids(&d, false, None), vec!["s2"]);
    assert_eq!(ids(&d, true, None), vec!["s1", "s2"]);
    let s = shown(&d, false, None).remove(0);
    assert_eq!(s.plane, Plane::named("XZ").unwrap());
    assert_eq!(s.lines.len(), 2);
    assert_eq!(s.areas.len(), 1, "the circle is a hole in the rectangle");
    assert_eq!(s.areas[0].holes.len(), 1);
    assert_eq!(s.areas[0].point[1], 0.0);
    assert!(!s.areas[0].contains(DVec2::new(17.0, 10.0)));
    assert!(!s.areas[0].contains(DVec2::new(30.0, 10.0)));
    assert!(s.areas[0].contains(DVec2::new(22.0, 10.0)));
}
