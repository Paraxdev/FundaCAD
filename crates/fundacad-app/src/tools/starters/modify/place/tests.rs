use glam::Vec3;
use serde_json::{json, Value};

use super::*;

fn doc(features: Value) -> Doc {
    json!({"features": features}).as_object().cloned().unwrap()
}

fn face(point: [f32; 3], normal: [f32; 3]) -> Pick {
    Pick::Face { body: "b1".into(), face: 4, point, normal }
}

fn edge(mid: [f32; 3]) -> Pick {
    Pick::Edge { body: "b1".into(), edge: 7, mid }
}

fn sel(picks: Vec<Pick>) -> Selection {
    Selection { picks }
}

fn features(d: &Doc) -> &Vec<Value> {
    d["features"].as_array().unwrap()
}

#[test]
fn a_tool_offers_its_plane_or_axis_pick_only_when_the_selection_gave_none() {
    let body = Pick::Body { body: "b1".into() };
    let plane = Pick::Plane { id: "p3".into() };
    for tool in ["split", "mirror"] {
        assert_eq!(offer(tool, &sel(vec![])), Some(PLANE));
        assert_eq!(offer(tool, &sel(vec![body.clone()])), Some(PLANE));
        assert_eq!(offer(tool, &sel(vec![body.clone(), face([2.0, -4.0, 9.5], [0.0, 0.0, 1.0])])), None);
        assert_eq!(offer(tool, &sel(vec![plane.clone()])), None);
        assert_eq!(offer(tool, &sel(vec![edge([1.0, 2.0, 3.0])])), Some(PLANE));
    }
    assert_eq!(offer("pattern-circular", &sel(vec![body.clone()])), Some(AXIS));
    assert_eq!(offer("pattern-circular", &sel(vec![edge([1.0, 2.0, 3.0])])), None);
    assert_eq!(offer("pattern-circular", &sel(vec![face([1.0, 2.0, 3.0], [1.0, 0.0, 0.0])])), None);
    assert_eq!(offer("pattern-circular", &sel(vec![plane.clone()])), Some(AXIS));
    assert_eq!(offer("pattern-linear", &sel(vec![])), None);
    assert_eq!(offer("move", &sel(vec![])), None);
    assert!(places(&PLANE) && places(&AXIS));
    assert!(!places(&Target { field: "edges", kind: PickKind::Edge, many: true }));
}

#[test]
fn a_split_cuts_by_the_clicked_face_and_drops_its_datum() {
    let mut d = doc(json!([{"id": "f1", "type": "box"}, {"id": "f2", "type": "split", "planeId": "f9", "keep": "both"}]));
    let v = place(&mut d, "f2", "plane", &face([3.0, -2.0, 12.5], [0.0, 0.0, 1.0]), None).unwrap();
    assert_eq!(v, json!({"origin": [3.0, -2.0, 12.5], "normal": [0.0, 0.0, 1.0], "xdir": [1.0, 0.0, 0.0]}));
    assert_eq!(features(&d)[1], json!({"id": "f2", "type": "split", "keep": "both"}));
    assert_eq!(place(&mut d, "f2", "plane", &edge([1.0, 1.0, 1.0]), None), Err("Click a flat face".into()));
    let missing = place(&mut d, "f7", "plane", &face([0.0; 3], [0.0, 0.0, 1.0]), None);
    assert_eq!(missing, Err("the document has no feature f7".into()));
}

#[test]
fn a_mirror_about_a_clicked_face_gets_a_mirror_plane_just_before_it() {
    let pick = face([-6.0, 4.5, 2.0], [1.0, 0.0, 0.0]);
    let plane = json!({"origin": [-6.0, 4.5, 2.0], "normal": [1.0, 0.0, 0.0], "xdir": [0.0, 1.0, 0.0]});
    let datum = json!({"id": "f3", "type": "datumPlane", "plane": plane, "offset": 0, "name": "Mirror plane",
        "face": pick.selector(), "at": [-6.0, 4.5, 2.0]});
    let mut d = doc(json!([{"id": "f1", "type": "box"}, {"id": "f2", "type": "mirror", "plane": "XY"}]));
    assert_eq!(place(&mut d, "f2", "plane", &pick, None), Ok(json!("f3")));
    let after = vec![json!({"id": "f1", "type": "box"}), datum.clone(), json!({"id": "f2", "type": "mirror", "plane": "XY"})];
    assert_eq!(features(&d), &after);

    let named = json!({"id": "f2", "type": "mirror", "plane": {"name": "XY"}, "bodies": ["b1"]});
    let mut d = doc(json!([{"id": "f1", "type": "box"}, named]));
    assert_eq!(place(&mut d, "f2", "plane", &pick, None), Ok(json!({"name": "f3"})));
    assert_eq!(features(&d), &vec![json!({"id": "f1", "type": "box"}), datum, named]);
}

#[test]
fn a_circular_pattern_turns_about_the_clicked_edge_with_its_line_to_fall_back_on() {
    let mut d = doc(json!([{"id": "f1", "type": "box"}, {"id": "f2", "type": "patternCircular", "count": 4, "axis": "Z"}]));
    let pick = edge([5.0, 2.0, 7.0]);
    let line = [Vec3::new(5.0, 2.0, 1.0), Vec3::new(5.0, 2.0, 13.0)];
    let v = place(&mut d, "f2", "axisRef", &pick, Some(&line)).unwrap();
    assert_eq!(v, pick.selector().unwrap());
    assert_eq!(features(&d)[1]["axis"], json!({"origin": [5.0, 2.0, 7.0], "dir": [0.0, 0.0, 1.0]}));
    let flat = face([1.0, 2.0, 3.0], [0.0, -1.0, 0.0]);
    place(&mut d, "f2", "axisRef", &flat, None).unwrap();
    assert_eq!(features(&d)[1]["axis"], json!({"origin": [1.0, 2.0, 3.0], "dir": [0.0, -1.0, 0.0]}));
    assert_eq!(place(&mut d, "f2", "axisRef", &Pick::Body { body: "b1".into() }, None), Err("Click an edge or a face".into()));
}

#[test]
fn the_fallback_line_runs_along_a_straight_edge_and_through_the_middle_of_a_round_one() {
    let pick = edge([4.0, -1.0, 2.0]);
    let slant = [Vec3::new(1.0, -1.0, 2.0), Vec3::new(4.0, -1.0, 6.0)];
    assert_eq!(axis_line(&pick, Some(&slant)), ([4.0, -1.0, 2.0], [0.6, 0.0, 0.8]));
    let ring: Vec<Vec3> = (0..=12)
        .map(|i| {
            let a = i as f32 / 12.0 * std::f32::consts::TAU;
            Vec3::new(10.0 + 3.0 * a.cos(), -4.0, 6.0 + 3.0 * a.sin())
        })
        .collect();
    let (mid, dir) = axis_line(&pick, Some(&ring));
    assert!(Vec3::from(mid).distance(Vec3::new(10.0, -4.0, 6.0)) < 1e-4, "{mid:?}");
    assert!(Vec3::from(dir).distance(Vec3::new(0.0, -1.0, 0.0)) < 1e-4, "{dir:?}");
    assert_eq!(axis_line(&pick, None), ([4.0, -1.0, 2.0], [0.0, 0.0, 1.0]));
    assert_eq!(axis_line(&pick, Some(&slant[..1])), ([4.0, -1.0, 2.0], [0.0, 0.0, 1.0]));
    let bump = face([0.5, 0.5, 9.0], [0.0, 1.0, 0.0]);
    assert_eq!(axis_line(&bump, None), ([0.5, 0.5, 9.0], [0.0, 1.0, 0.0]));
}
