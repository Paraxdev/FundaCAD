use serde_json::{json, Value};

use super::*;
use crate::tools::run::Run;
use crate::tools::{insert, started, tool};

fn doc(v: Value) -> Doc {
    v.as_object().unwrap().clone()
}

fn sel(picks: Vec<Pick>) -> Selection {
    Selection { picks }
}

fn face(point: [f32; 3]) -> Pick {
    Pick::Face { body: "body2".into(), face: 3, point, normal: [0., 0., 1.] }
}

fn area(sketch: &str, point: [f64; 3]) -> Pick {
    Pick::Area { sketch: sketch.into(), point }
}

fn rect_sketch(id: &str, plane: &str, construction: bool) -> Value {
    let mut entities = vec![json!({"type": "rectangle", "id": "r1", "x": 12, "y": 4, "width": 10, "height": 6})];
    if construction {
        entities.push(json!({"type": "line", "id": "l1", "x1": 30, "y1": -2, "x2": 30, "y2": 9, "construction": true}));
    }
    json!({"id": id, "type": "sketch", "plane": plane, "entities": entities})
}

fn path_sketch(id: &str) -> Value {
    json!({"id": id, "type": "sketch", "plane": "XZ", "entities": [{"type": "line", "id": "l1", "x1": 0, "y1": 0, "x2": 0, "y2": 25}]})
}

fn feat(start: &Start) -> Value {
    let mut f = start.feature.clone();
    f.as_object_mut().unwrap().remove("id");
    f
}

fn run_of(d: &Doc, id: &str, picks: Vec<Pick>) -> (Run, Doc, Start) {
    let (fid, start) = started(tool(id).unwrap(), d, &sel(picks)).unwrap();
    let mut now = d.clone();
    insert(&mut now, start.feature.clone()).unwrap();
    let mut r = Run::new(d.clone(), id.into(), format!("Add {id}"), fid, start.need.clone());
    r.set_arm(&mut now, start.arm());
    (r, now, start)
}

/// The feature the run added, the last in the list.
fn last(d: &Doc) -> Value {
    let mut f = d["features"].as_array().unwrap().last().unwrap().clone();
    f.as_object_mut().unwrap().remove("id");
    f
}

#[test]
fn operation_is_new_until_something_makes_a_solid() {
    assert_eq!(operation(&doc(json!({}))), "new");
    assert_eq!(operation(&doc(json!({"features": [rect_sketch("s1", "XY", false), {"id": "d1", "type": "datumPlane"}]}))), "new");
    let boxed = json!({"features": [{"id": "b1", "type": "box"}, rect_sketch("s1", "XY", false)]});
    assert_eq!(operation(&doc(boxed.clone())), "join");
    let mut d = doc(boxed);
    d.insert("suppressed".into(), json!(["b1"]));
    assert_eq!(operation(&d), "new");
    d.remove("suppressed");
    d.insert("rollback".into(), json!(0));
    assert_eq!(operation(&d), "new");
}

#[test]
fn extrude_takes_a_face_as_press_pull_a_sketch_whole_its_areas_or_waits_for_areas() {
    let d = doc(json!({"features": [{"id": "b1", "type": "box"}, rect_sketch("s1", "XY", false)]}));
    let (_, s) = started(tool("extrude").unwrap(), &d, &sel(vec![face([4.5, -2.0, 7.0])])).unwrap();
    assert_eq!(
        feat(&s),
        json!({"type": "press-pull", "distance": 10, "mode": "auto", "body": "body2",
            "face": {"kind": "face", "by": "nearest", "point": [4.5, -2.0, 7.0], "body": "body2"}})
    );
    assert_eq!(s.need, vec![Target { field: "face", kind: PickKind::Face, many: false }]);
    assert_eq!(s.arm(), None);
    let (_, s) = started(tool("extrude").unwrap(), &d, &sel(vec![Pick::Sketch { feature: "s1".into() }])).unwrap();
    assert_eq!(feat(&s), json!({"type": "extrude", "distance": 10, "operation": "join", "sketch": "s1"}));
    assert!(s.need.is_empty());
    let picks = vec![area("s1", [13.0, 5.0, 0.0]), area("s9", [1.0, 1.0, 1.0]), area("s1", [15.0, 6.0, 0.0])];
    let (_, s) = started(tool("extrude").unwrap(), &d, &sel(picks)).unwrap();
    assert_eq!(
        feat(&s),
        json!({"type": "extrude", "distance": 10, "operation": "join", "sketch": "s1", "regions": [[13.0, 5.0, 0.0], [15.0, 6.0, 0.0]]})
    );
    assert_eq!(s.arm(), None);
    let (_, s) = started(tool("extrude").unwrap(), &d, &sel(vec![])).unwrap();
    assert_eq!(feat(&s), json!({"type": "extrude", "distance": 10, "operation": "join", "regions": []}));
    assert_eq!(s.arm(), Some(REGIONS));
}

#[test]
fn extrude_needs_a_profile_and_walls_an_open_sketch() {
    let words = "Extrude needs a profile, draw a closed sketch first";
    assert_eq!(started(tool("extrude").unwrap(), &doc(json!({})), &sel(vec![])).unwrap_err(), words);
    let d = doc(json!({"features": [path_sketch("p1"), {"id": "p2", "type": "sketch", "plane": "XY", "entities": [
        {"type": "line", "id": "c1", "x1": 3, "y1": 1, "x2": 9, "y2": 1, "construction": true}]}]}));
    assert_eq!(started(tool("extrude").unwrap(), &d, &sel(vec![])).unwrap_err(), words);
    let (_, s) = started(tool("extrude").unwrap(), &d, &sel(vec![Pick::Sketch { feature: "p1".into() }])).unwrap();
    assert_eq!(
        feat(&s),
        json!({"type": "extrude", "sketch": "p1", "distance": 10, "operation": "new", "thin": true, "curves": ["l1"],
            "thickness": 2, "side": "center"})
    );
    assert!(s.need.is_empty());
    let err = started(tool("extrude").unwrap(), &d, &sel(vec![Pick::Sketch { feature: "p2".into() }])).unwrap_err();
    assert_eq!(err, "The sketch has no curve to extrude");
}

#[test]
fn area_clicks_name_the_sketch_add_and_drop_regions_and_refuse_another_sketch() {
    let d = doc(json!({"features": [rect_sketch("s1", "XY", false), rect_sketch("s2", "XZ", false)]}));
    let (mut r, mut now, _) = run_of(&d, "extrude", vec![]);
    assert_eq!(r.missing(&now), Some("Pick the profiles first".into()));
    let pick = |sketch: &str, p: [f64; 3]| json!({"sketch": sketch, "point": p});
    r.pick(&mut now, pick("s1", [13.0, 5.0, 0.0]), None).unwrap();
    assert_eq!(last(&now)["sketch"], "s1");
    assert_eq!(last(&now)["regions"], json!([[13.0, 5.0, 0.0]]));
    r.pick(&mut now, pick("s1", [16.0, 3.0, 0.0]), None).unwrap();
    let err = r.pick(&mut now, pick("s2", [13.0, 0.0, 5.0]), None).unwrap_err();
    assert_eq!(err, "Pick areas of one sketch");
    assert_eq!(last(&now)["regions"], json!([[13.0, 5.0, 0.0], [16.0, 3.0, 0.0]]));
    r.pick(&mut now, Value::Null, Some(json!([13.0, 5.0, 0.0]))).unwrap();
    r.pick(&mut now, Value::Null, Some(json!([16.0, 3.0, 0.0]))).unwrap();
    assert_eq!(last(&now)["regions"], json!([]));
    r.pick(&mut now, pick("s2", [13.0, 0.0, 5.0]), None).unwrap();
    assert_eq!(last(&now)["sketch"], "s2", "an empty list takes another sketch");
    assert_eq!(r.missing(&now), None);
    let err = r.pick(&mut now, json!({"point": [0, 0, 0]}), None).unwrap_err();
    assert_eq!(err, "Click inside a closed sketch area");
}

#[test]
fn revolve_turns_about_the_construction_line_the_sketch_y_axis_or_a_straight_edge() {
    let d = doc(json!({"features": [rect_sketch("s1", "XZ", true), rect_sketch("s2", "XY", false)]}));
    let line = json!({"origin": [30.0, 0.0, -2.0], "dir": [0.0, 0.0, 11.0]});
    let y_axis = json!({"origin": [0.0, 0.0, 0.0], "dir": [0.0, 1.0, 0.0]});
    let (_, s) = started(tool("revolve").unwrap(), &d, &sel(vec![Pick::Sketch { feature: "s1".into() }])).unwrap();
    assert_eq!(feat(&s), json!({"type": "revolve", "angle": 360, "operation": "new", "sketch": "s1", "axis": line}));
    assert!(s.need.is_empty());
    let (_, s) = started(tool("revolve").unwrap(), &d, &sel(vec![Pick::Sketch { feature: "s2".into() }])).unwrap();
    assert_eq!(feat(&s), json!({"type": "revolve", "angle": 360, "operation": "new", "sketch": "s2", "axis": y_axis}));
    let edge = |dir| Pick::Edge { body: "b".into(), edge: 2, mid: [1.5, 2.0, -3.0], dir };
    let picks = vec![Pick::Sketch { feature: "s2".into() }, edge(Some([0.0, 0.6, 0.8]))];
    let (_, s) = started(tool("revolve").unwrap(), &d, &sel(picks)).unwrap();
    assert_eq!(s.feature["axis"], json!({"origin": [1.5, 2.0, -3.0], "dir": [0.0, 0.6, 0.8]}));
    assert_eq!(s.feature["axisEdge"], json!({"kind": "edge", "by": "nearest", "point": [1.5, 2.0, -3.0], "body": "b"}));
    let picks = vec![Pick::Sketch { feature: "s2".into() }, edge(None)];
    assert_eq!(started(tool("revolve").unwrap(), &d, &sel(picks)).unwrap_err(), STRAIGHT);

    let (mut r, mut now, s) = run_of(&d, "revolve", vec![]);
    assert_eq!(s.feature["axis"], "Z");
    r.pick(&mut now, json!({"sketch": "s2", "point": [13.0, 5.0, 0.0]}), None).unwrap();
    assert_eq!(last(&now)["axis"], y_axis, "a sketch with no construction line turns about its Y axis");
    r.pick(&mut now, Value::Null, Some(json!([13.0, 5.0, 0.0]))).unwrap();
    r.pick(&mut now, json!({"sketch": "s1", "point": [13.0, 0.0, 5.0]}), None).unwrap();
    assert_eq!(last(&now)["axis"], line);
}

#[test]
fn a_revolve_axis_edge_picked_in_the_card_must_be_straight_and_stays_with_another_sketch() {
    let d = doc(json!({"features": [rect_sketch("s1", "XZ", true), rect_sketch("s2", "XY", false)]}));
    let (mut r, mut now, _) = run_of(&d, "revolve", vec![area("s2", [13.0, 5.0, 0.0])]);
    let id = r.feature.clone();
    r.set_arm(&mut now, Some(Target { field: "axisEdge", kind: PickKind::Edge, many: false }));
    let curved = Pick::Edge { body: "body1".into(), edge: 4, mid: [6.0, -2.5, 3.0], dir: None };
    assert_eq!(fits(&now, &id, "axisEdge", &curved).unwrap_err(), STRAIGHT);
    let straight = Pick::Edge { body: "body1".into(), edge: 5, mid: [6.0, -2.5, 3.0], dir: Some([0.0, 0.0, -1.0]) };
    assert_eq!(fits(&now, &id, "axisEdge", &straight), Ok(()));
    assert_eq!(fits(&now, &id, "regions", &curved), Ok(()), "only the axis edge is checked");
    r.pick(&mut now, straight.selector().unwrap(), None).unwrap();
    after_pick(&mut now, &id, "axisEdge", &straight);
    let edge_line = json!({"origin": [6.0, -2.5, 3.0], "dir": [0.0, 0.0, -1.0]});
    assert_eq!(last(&now)["axis"], edge_line);
    assert_eq!(last(&now)["axisEdge"], straight.selector().unwrap());
    r.set_arm(&mut now, Some(REGIONS));
    r.pick(&mut now, Value::Null, Some(json!([13.0, 5.0, 0.0]))).unwrap();
    r.pick(&mut now, json!({"sketch": "s1", "point": [13.0, 0.0, 5.0]}), None).unwrap();
    assert_eq!((last(&now)["sketch"].clone(), last(&now)["axis"].clone()), (json!("s1"), edge_line));
}

#[test]
fn loft_takes_one_profile_per_sketch_and_waits_for_two() {
    let d = doc(json!({"features": [rect_sketch("s1", "XY", false), rect_sketch("s2", "XZ", false)]}));
    let picks = vec![area("s1", [13.0, 5.0, 0.0]), area("s1", [14.0, 5.0, 0.0]), area("s2", [13.0, 0.0, 5.0])];
    let (_, s) = started(tool("loft").unwrap(), &d, &sel(picks)).unwrap();
    assert_eq!(
        feat(&s),
        json!({"type": "loft", "operation": "new", "profiles": [{"sketch": "s1", "region": [13.0, 5.0, 0.0]},
            {"sketch": "s2", "region": [13.0, 0.0, 5.0]}]})
    );
    let (mut r, mut now, _) = run_of(&d, "loft", vec![]);
    assert_eq!(r.missing(&now), Some("Pick the profiles first".into()));
    r.pick(&mut now, json!({"sketch": "s1", "point": [13.0, 5.0, 0.0]}), None).unwrap();
    assert_eq!(r.missing(&now), Some("Pick two profiles first".into()));
    let err = r.pick(&mut now, json!({"sketch": "s1", "point": [20.0, 5.0, 0.0]}), None).unwrap_err();
    assert_eq!(err, "Pick one profile of each sketch");
    r.pick(&mut now, json!({"sketch": "s2", "point": [13.0, 0.0, 5.0]}), None).unwrap();
    assert_eq!(last(&now)["profiles"].as_array().unwrap().len(), 2);
    assert_eq!(r.missing(&now), None);
    assert!(r.finish(&mut now, true).unwrap().is_some());
}

#[test]
fn sweep_follows_an_open_sketch_and_waits_for_a_path() {
    let lone = doc(json!({"features": [rect_sketch("s1", "XY", false)]}));
    let (mut r, mut now, s) = run_of(&lone, "sweep", vec![]);
    assert_eq!(feat(&s), json!({"type": "sweep", "operation": "new"}));
    r.pick(&mut now, json!({"sketch": "s1", "point": [13.0, 5.0, 0.0]}), None).unwrap();
    assert_eq!(last(&now)["profile"], "s1");
    assert_eq!(r.missing(&now), Some("Draw a path sketch first".into()));
    let d = doc(json!({"features": [path_sketch("p1"), rect_sketch("s1", "XY", false), rect_sketch("s2", "XZ", false)]}));
    let (_, s) = started(tool("sweep").unwrap(), &d, &sel(vec![area("s2", [13.0, 0.0, 5.0])])).unwrap();
    assert_eq!(feat(&s), json!({"type": "sweep", "operation": "new", "profile": "s2", "path": "p1"}));
    let picks = vec![Pick::Sketch { feature: "s1".into() }, Pick::Sketch { feature: "s2".into() }];
    let (_, s) = started(tool("sweep").unwrap(), &d, &sel(picks)).unwrap();
    assert_eq!(s.feature["path"], "s2");
}

#[test]
fn a_hole_takes_its_face_then_a_point_per_click() {
    let (_, s) = started(tool("hole").unwrap(), &doc(json!({})), &sel(vec![face([3.25, -8.0, 12.0])])).unwrap();
    assert_eq!(
        feat(&s),
        json!({"type": "hole", "holeType": "simple", "standard": "clearance", "size": "M3", "fit": "normal",
            "extent": "through", "depth": 10, "points": [[3.25, -8.0, 12.0]],
            "face": {"kind": "face", "by": "nearest", "point": [3.25, -8.0, 12.0], "body": "body2"}})
    );
    let d = doc(json!({"features": [{"id": "f1", "type": "box"}]}));
    let (mut r, mut now, s) = run_of(&d, "hole", vec![]);
    assert_eq!(s.arm().map(|t| t.field), Some("face"));
    let at = |x: f64| json!({"kind": "face", "by": "nearest", "point": [x, 2.0, 20.0], "body": "body1"});
    r.pick(&mut now, at(4.0), None).unwrap();
    assert_eq!(r.arm.map(|t| t.field), Some("points"));
    assert_eq!(last(&now)["points"], json!([[4.0, 2.0, 20.0]]));
    r.pick(&mut now, at(9.0), None).unwrap();
    r.pick(&mut now, at(-6.5), None).unwrap();
    assert_eq!(last(&now)["points"], json!([[4.0, 2.0, 20.0], [9.0, 2.0, 20.0], [-6.5, 2.0, 20.0]]));
    assert_eq!(last(&now)["face"], at(4.0));
    assert_eq!(r.pick(&mut now, json!("body1"), None).unwrap_err(), "Click on a face");
}

#[test]
fn a_face_picked_into_a_datum_plane_brings_its_plane_and_spot() {
    let mut d = doc(json!({"features": [{"id": "f1", "type": "datumPlane", "plane": "XY", "offset": 10}, {"id": "f2", "type": "hole"}]}));
    let tilted = Pick::Face { body: "body1".into(), face: 2, point: [4.5, -3.0, 8.0], normal: [1.0, 0.0, 0.0] };
    after_pick(&mut d, "f1", "face", &tilted);
    assert_eq!(d["features"][0]["plane"], json!({"origin": [4.5, -3.0, 8.0], "normal": [1.0, 0.0, 0.0], "xdir": [0.0, 1.0, 0.0]}));
    assert_eq!(d["features"][0]["at"], json!([4.5, -3.0, 8.0]));
    let before = d.clone();
    after_pick(&mut d, "f2", "face", &tilted);
    after_pick(&mut d, "f1", "upTo", &tilted);
    after_pick(&mut d, "f1", "face", &Pick::Body { body: "body1".into() });
    assert_eq!(d, before);
}

#[test]
fn a_click_near_a_hole_point_finds_the_nearest_within_reach() {
    let held = vec![json!([4.0, 2.0, 20.0]), json!([9.0, 2.0, 20.0]), json!("f1"), json!([5.0, 2.0])];
    assert_eq!(point_near(&held, [4.5, 2.5, 20.0], 1.0), Some(json!([4.0, 2.0, 20.0])));
    assert_eq!(point_near(&held, [7.0, 2.0, 20.0], 2.0), Some(json!([9.0, 2.0, 20.0])), "both reach, the nearer wins");
    assert_eq!(point_near(&held, [7.0, 2.0, 20.0], 2.5), Some(json!([9.0, 2.0, 20.0])));
    assert_eq!(point_near(&held, [6.5, 2.0, 20.0], 2.5), Some(json!([4.0, 2.0, 20.0])));
    assert_eq!(point_near(&held, [6.5, 2.0, 20.0], 2.49), None);
    assert_eq!(point_near(&[], [4.0, 2.0, 20.0], 5.0), None);
    let (mut r, mut now, _) = run_of(&doc(json!({})), "hole", vec![face([3.25, -8.0, 12.0])]);
    r.set_arm(&mut now, Some(Target { field: "points", kind: PickKind::Point, many: true }));
    r.pick(&mut now, json!({"point": [6.0, -8.0, 12.0]}), None).unwrap();
    let had = point_near(&entries(&now, &r.feature, "points"), [3.5, -8.0, 12.0], 1.7);
    r.pick(&mut now, json!({"point": [3.5, -8.0, 12.0]}), had).unwrap();
    assert_eq!(last(&now)["points"], json!([[6.0, -8.0, 12.0]]));
}

#[test]
fn a_waiting_datum_plane_takes_a_face_a_world_plane_or_a_datum_plane() {
    let d = doc(json!({"features": [{"id": "f1", "type": "box"}, {"id": "f2", "type": "datumPlane", "plane": "XZ", "offset": 4}]}));
    let (mut r, mut now, s) = run_of(&d, "offset-plane", vec![]);
    let id = r.feature.clone();
    assert_eq!(s.arm(), Some(PLANE));
    assert!(takes_plane(&now, &id, "plane"));
    assert!(!takes_plane(&now, &id, "face"));
    assert!(!takes_plane(&now, "f1", "plane"));
    assert_eq!(r.missing(&now), Some("Pick the face first".into()));
    let tilted = Pick::Face { body: "body1".into(), face: 2, point: [4.5, -3.0, 8.0], normal: [1.0, 0.0, 0.0] };
    r.pick(&mut now, tilted.selector().unwrap(), None).unwrap();
    after_pick(&mut now, &id, "plane", &tilted);
    assert_eq!(
        last(&now),
        json!({"type": "datumPlane", "offset": 10.0, "name": "Offset plane",
            "plane": {"origin": [4.5, -3.0, 8.0], "normal": [1.0, 0.0, 0.0], "xdir": [0.0, 1.0, 0.0]},
            "face": tilted.selector().unwrap(), "at": [4.5, -3.0, 8.0]})
    );
    assert_eq!(r.missing(&now), None);
    r.set_arm(&mut now, Some(PLANE));
    r.pick(&mut now, json!({"plane": "f2"}), None).unwrap();
    assert_eq!(last(&now), json!({"type": "datumPlane", "offset": 10.0, "name": "Offset plane", "plane": "XY", "planeId": "f2"}));
    r.set_arm(&mut now, Some(PLANE));
    r.pick(&mut now, json!({"plane": "YZ"}), None).unwrap();
    assert_eq!(last(&now), json!({"type": "datumPlane", "offset": 10.0, "name": "Offset plane", "plane": "YZ"}));
    assert!(r.finish(&mut now, true).unwrap().is_some());
}
