use glam::{DVec2, DVec3, Vec3};
use serde_json::{json, Map, Value};

use super::*;

fn doc(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn features() -> Value {
    json!([
        {"id": "p1", "type": "datumPlane", "plane": "XZ", "offset": 7.5},
        {"id": "a1", "type": "datumAxis", "origin": [3, -4, 2], "dir": [0, 0, 6]},
        {"id": "pt1", "type": "datumPoint", "point": [1.5, 2.5, -3.5]},
        {"id": "b1", "type": "box"}
    ])
}

#[test]
fn origin_planes_show_only_when_turned_on() {
    let d = doc(json!({}));
    assert!(marks(&d, &Map::new()).is_empty());
    let d = doc(json!({"planeVisibility": {"XZ": true, "YZ": false}}));
    assert_eq!(marks(&d, &Map::new()), vec![Mark::Plane { id: "XZ".into(), plane: Plane::named("XZ").unwrap() }]);
    let d = doc(json!({"planeVisibility": {"XY": true, "XZ": true, "YZ": true}}));
    let ids: Vec<String> = marks(&d, &Map::new()).iter().map(|m| m.id().to_string()).collect();
    assert_eq!(ids, vec!["XY", "XZ", "YZ"]);
}

#[test]
fn datums_come_from_their_fields_until_built() {
    let d = doc(json!({"features": features()}));
    let mut p = Plane::named("XZ").unwrap();
    p.origin = DVec3::new(0.0, -7.5, 0.0);
    assert_eq!(
        marks(&d, &Map::new()),
        vec![
            Mark::Plane { id: "p1".into(), plane: p },
            Mark::Axis { id: "a1".into(), origin: DVec3::new(3.0, -4.0, 2.0), dir: DVec3::Z },
            Mark::Point { id: "pt1".into(), at: DVec3::new(1.5, 2.5, -3.5) },
        ]
    );
}

#[test]
fn built_datums_win_and_hidden_suppressed_or_rolled_back_ones_are_left_out() {
    let result = doc(json!({
        "datumPlanes": {"p1": {"origin": [2, 3, 4], "xdir": [0, 1, 0], "normal": [1, 0, 0]}},
        "datumMarks": {"a1": {"kind": "axis", "origin": [9, 8, 7], "dir": [2, 0, 0]}, "pt1": {"kind": "point", "position": [-1, -2, -3]}}
    }));
    let d = doc(json!({"features": features()}));
    let got = marks(&d, &result);
    let Mark::Plane { plane, .. } = &got[0] else { panic!("{got:?}") };
    assert_eq!((plane.origin, plane.n, plane.u), (DVec3::new(2.0, 3.0, 4.0), DVec3::X, DVec3::Y));
    assert_eq!(got[1], Mark::Axis { id: "a1".into(), origin: DVec3::new(9.0, 8.0, 7.0), dir: DVec3::X });
    assert_eq!(got[2], Mark::Point { id: "pt1".into(), at: DVec3::new(-1.0, -2.0, -3.0) });
    let d = doc(json!({"features": features(), "planeVisibility": {"p1": false}, "suppressed": ["pt1"]}));
    let ids: Vec<String> = marks(&d, &result).iter().map(|m| m.id().to_string()).collect();
    assert_eq!(ids, vec!["a1"]);
    let d = doc(json!({"features": features(), "rollback": 1}));
    let ids: Vec<String> = marks(&d, &result).iter().map(|m| m.id().to_string()).collect();
    assert_eq!(ids, vec!["p1"]);
}

#[test]
fn a_ray_takes_the_nearest_plane_square_it_lands_inside() {
    assert_eq!(square(4.0), [DVec2::new(-4.0, -4.0), DVec2::new(4.0, -4.0), DVec2::new(4.0, 4.0), DVec2::new(-4.0, 4.0)]);
    let mut high = Plane::named("XY").unwrap();
    high.origin = DVec3::new(5.0, -3.0, 6.0);
    let marks = vec![
        Mark::Plane { id: "XY".into(), plane: Plane::named("XY").unwrap() },
        Mark::Axis { id: "a1".into(), origin: DVec3::ZERO, dir: DVec3::Z },
        Mark::Plane { id: "p2".into(), plane: high },
    ];
    let down = Vec3::new(0.0, 0.0, -1.0);
    let at = |x: f32, y: f32| plane_under(&marks, 10.0, Vec3::new(x, y, 40.0), down).map(|(id, t)| (id.to_string(), t));
    assert_eq!(at(1.0, 1.0), Some(("p2".into(), 34.0)));
    assert_eq!(at(-8.0, 1.0), Some(("XY".into(), 40.0)), "outside the raised square");
    assert_eq!(at(30.0, 0.0), None);
    assert!(plane_under(&[], 10.0, Vec3::ZERO, down).is_none());
}
