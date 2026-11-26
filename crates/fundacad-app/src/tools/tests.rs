use serde_json::json;

use super::*;

fn doc(v: Value) -> Doc {
    v.as_object().unwrap().clone()
}

fn face(body: &str, face: u32, point: [f32; 3]) -> Pick {
    Pick::Face { body: body.into(), face, point, normal: [0., 0., 1.] }
}

fn edge(body: &str, edge: u32, mid: [f32; 3]) -> Pick {
    Pick::Edge { body: body.into(), edge, mid, dir: None }
}

fn run(id: &str, d: &Doc, picks: Vec<Pick>) -> Result<(String, Start), String> {
    started(tool(id).unwrap(), d, &Selection { picks })
}

#[test]
fn ids_count_up_past_taken_ones() {
    assert_eq!(next_id(&doc(json!({}))), "f1");
    assert_eq!(next_id(&doc(json!({"features": [{"id": "box_1"}]}))), "f2");
    assert_eq!(next_id(&doc(json!({"features": [{"id": "f2"}, {"id": "f3"}]}))), "f4");
}

#[test]
fn inserts_at_the_rollback_marker() {
    let mut d = doc(json!({"features": [{"id": "a"}, {"id": "b"}]}));
    insert(&mut d, json!({"id": "c"})).unwrap();
    assert_eq!(d["features"], json!([{"id": "a"}, {"id": "b"}, {"id": "c"}]));
    assert!(d.get("rollback").is_none());
    let mut d = doc(json!({"features": [{"id": "a"}, {"id": "b"}], "rollback": 1}));
    insert(&mut d, json!({"id": "c"})).unwrap();
    assert_eq!(d["features"], json!([{"id": "a"}, {"id": "c"}, {"id": "b"}]));
    assert_eq!(d["rollback"], json!(2));
    let mut d = doc(json!({}));
    insert(&mut d, json!({"id": "c"})).unwrap();
    assert_eq!(d["features"], json!([{"id": "c"}]));
}

#[test]
fn targets_add_drop_and_replace() {
    let mut d = doc(json!({"features": [{"id": "f2", "type": "fillet", "edges": []}, {"id": "f3", "type": "boolean"}]}));
    set_target(&mut d, "f2", "edges", json!("e1"), true, false).unwrap();
    set_target(&mut d, "f2", "edges", json!("e2"), true, false).unwrap();
    set_target(&mut d, "f2", "edges", json!("e1"), true, false).unwrap();
    assert_eq!(d["features"][0]["edges"], json!(["e1", "e2"]));
    set_target(&mut d, "f2", "edges", json!("e1"), true, true).unwrap();
    assert_eq!(d["features"][0]["edges"], json!(["e2"]));
    set_target(&mut d, "f3", "target", json!("b1"), false, false).unwrap();
    set_target(&mut d, "f3", "target", json!("b2"), false, false).unwrap();
    assert_eq!(d["features"][1]["target"], json!("b2"));
    set_target(&mut d, "f3", "target", json!("b2"), false, true).unwrap();
    assert!(d["features"][1].get("target").is_none());
    assert!(set_target(&mut d, "nope", "edges", json!("e1"), true, false).is_err());
}

#[test]
fn a_box_starts_whole_with_its_id_first() {
    let (id, s) = run("primitive-box", &doc(json!({"features": [{"id": "f1"}]})), vec![]).unwrap();
    assert_eq!(id, "f2");
    assert_eq!(s.feature, json!({"id": "f2", "type": "box", "length": 20, "width": 20, "height": 20}));
    assert_eq!(serde_json::to_string(&s.feature).unwrap().find("\"id\""), Some(1));
    assert_eq!(s.arm(), None);
}

#[test]
fn fillet_takes_the_selected_edges_or_picks_them() {
    let d = doc(json!({}));
    let (_, s) = run("fillet", &d, vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f1", "type": "fillet", "radius": 2, "edges": []}));
    assert_eq!(s.arm(), Some(Target { field: "edges", kind: PickKind::Edge, many: true }));
    let picks = vec![edge("b1", 3, [12.5, -4., 7.]), face("b1", 2, [1., 2., 3.]), edge("b1", 8, [3., 9.5, -2.])];
    let (_, s) = run("chamfer", &d, picks).unwrap();
    assert_eq!(
        s.feature["edges"],
        json!([
            {"kind": "edge", "by": "nearest", "point": [12.5, -4.0, 7.0], "body": "b1"},
            {"kind": "edge", "by": "nearest", "point": [3.0, 9.5, -2.0], "body": "b1"},
        ])
    );
    assert_eq!(s.feature["distance"], json!(1));
    assert_eq!(s.arm(), None);
}

#[test]
fn booleans_keep_the_first_body() {
    let d = doc(json!({}));
    let (_, s) = run("boolean-subtract", &d, vec![]).unwrap();
    assert_eq!(s.arm(), Some(Target { field: "target", kind: PickKind::Body, many: false }));
    let (_, s) = run("boolean-union", &d, vec![Pick::Body { body: "b2".into() }]).unwrap();
    assert_eq!(s.feature, json!({"id": "f1", "type": "boolean", "operation": "union", "tools": [], "target": "b2"}));
    assert_eq!(s.arm(), Some(Target { field: "tools", kind: PickKind::Body, many: true }));
    let picks = vec![face("b4", 1, [0., 0., 0.]), Pick::Body { body: "b1".into() }, edge("b4", 2, [1., 1., 1.]), Pick::Body { body: "b7".into() }];
    let (_, s) = run("boolean-intersect", &d, picks).unwrap();
    assert_eq!(s.feature["target"], json!("b4"));
    assert_eq!(s.feature["tools"], json!(["b1", "b7"]));
    assert_eq!(s.arm(), None);
}

#[test]
fn shell_opens_the_selected_faces() {
    let (_, s) = run("shell", &doc(json!({})), vec![face("b1", 5, [4., 6., 20.])]).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f1", "type": "shell", "thickness": 2,
            "faces": [{"kind": "face", "by": "nearest", "point": [4.0, 6.0, 20.0], "body": "b1"}]})
    );
    assert_eq!(s.arm(), None);
    let (_, s) = run("shell", &doc(json!({})), vec![]).unwrap();
    assert_eq!(s.arm(), Some(Target { field: "faces", kind: PickKind::Face, many: true }));
}

#[test]
fn an_offset_plane_follows_a_face_a_plane_or_waits_for_one() {
    let d = doc(json!({}));
    let (_, s) = run("offset-plane", &d, vec![face("b1", 5, [4., 6., 20.])]).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f1", "type": "datumPlane",
            "plane": {"origin": [4.0, 6.0, 20.0], "normal": [0.0, 0.0, 1.0], "xdir": [1.0, 0.0, 0.0]},
            "offset": 10.0, "name": "Offset plane",
            "face": {"kind": "face", "by": "nearest", "point": [4.0, 6.0, 20.0], "body": "b1"}, "at": [4.0, 6.0, 20.0]})
    );
    let (_, s) = run("datum-plane", &d, vec![Pick::Plane { id: "XZ".into() }]).unwrap();
    assert_eq!(s.feature["plane"], json!("XZ"));
    let (_, s) = run("datum-plane", &d, vec![Pick::Plane { id: "f4".into() }]).unwrap();
    assert_eq!((s.feature["plane"].clone(), s.feature["planeId"].clone()), (json!("XY"), json!("f4")));
    let (_, s) = run("offset-plane", &d, vec![]).unwrap();
    assert_eq!(s.arm(), Some(Target { field: "face", kind: PickKind::Face, many: false }));
}

#[test]
fn reference_datums_need_their_selection() {
    let d = doc(json!({}));
    assert_eq!(
        run("midplane", &d, vec![face("b1", 1, [0., 0., 0.])]).unwrap_err(),
        "Select two flat faces or planes, then Midplane"
    );
    let (_, s) = run("midplane", &d, vec![face("b1", 1, [2., 0., 4.]), face("b1", 2, [2., 0., 10.])]).unwrap();
    assert_eq!(s.feature["plane"]["origin"], json!([2.0, 0.0, 7.0]));
    assert_eq!(s.feature["through"]["kind"], json!("mid"));
    assert!(run("axis-cylinder", &d, vec![]).is_err());
    let axis_words = "Select two edges to run the axis through, then Datum Axis";
    assert_eq!(run("datum-axis", &d, vec![]).unwrap_err(), axis_words);
    assert_eq!(run("datum-axis", &d, vec![edge("b1", 4, [1., 2., 13.])]).unwrap_err(), axis_words);
    let spots = vec![face("b1", 1, [1., 2., 3.]), edge("b1", 4, [1., 2., 13.])];
    assert_eq!(run("datum-axis", &d, spots).unwrap_err(), axis_words, "a face spot is not what the engine reads");
    let picks = vec![Pick::Body { body: "b1".into() }, edge("b1", 4, [1., 2., 13.]), face("b1", 1, [8., 8., 8.]),
        edge("b1", 6, [4., 2., 13.]), edge("b1", 7, [9., 9., 9.])];
    let (_, s) = run("datum-axis", &d, picks).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f1", "type": "datumAxis", "origin": [1.0, 2.0, 13.0], "dir": [3.0, 0.0, 0.0], "name": "Axis",
            "through": {"kind": "points",
                "a": {"edge": {"kind": "edge", "by": "nearest", "point": [1.0, 2.0, 13.0], "body": "b1"}, "t": 0.5},
                "b": {"edge": {"kind": "edge", "by": "nearest", "point": [4.0, 2.0, 13.0], "body": "b1"}, "t": 0.5}}})
    );
    let same = vec![edge("b1", 1, [1., 2., 3.]), edge("b1", 4, [1., 2., 3.])];
    assert_eq!(run("datum-axis", &d, same).unwrap_err(), "Pick two different spots");
    let (_, s) = run("datum-point", &d, vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f1", "type": "datumPoint", "point": [0.0, 0.0, 0.0], "name": "Point"}));
}

#[test]
fn plane_through_points_needs_three_off_a_line() {
    let d = doc(json!({}));
    let words = "Select three edges to lay the plane through, then Plane Through Points";
    assert_eq!(run("plane-points", &d, vec![]).unwrap_err(), words);
    assert_eq!(run("plane-points", &d, vec![edge("b1", 1, [3., 1., 5.]), edge("b1", 2, [7., 1., 5.])]).unwrap_err(), words);
    let faces = vec![face("b1", 1, [3., 1., 5.]), edge("b1", 2, [7., 1., 5.]), face("b1", 3, [3., 6., 5.])];
    assert_eq!(run("plane-points", &d, faces).unwrap_err(), words, "a face's spot is not the point the engine takes");
    let in_line = vec![edge("b1", 1, [3., 1., 5.]), edge("b1", 2, [7., 1., 5.]), edge("b1", 3, [11., 1., 5.])];
    assert_eq!(run("plane-points", &d, in_line).unwrap_err(), "The three points are in a line, pick one off it");
    let picks = vec![
        edge("b1", 1, [3., 1., 5.]),
        Pick::Body { body: "b2".into() },
        face("b1", 4, [9., 9., 9.]),
        edge("b1", 2, [7., 1., 5.]),
        edge("b1", 3, [3., 6., 5.]),
        edge("b1", 5, [9., 9., 9.]),
    ];
    let (_, s) = run("plane-points", &d, picks).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f1", "type": "datumPlane", "name": "Plane",
            "plane": {"origin": [0.0, 0.0, 5.0], "normal": [0.0, 0.0, 1.0], "xdir": [1.0, 0.0, 0.0]},
            "through": {"kind": "points", "points": [
                {"edge": {"kind": "edge", "by": "nearest", "point": [3.0, 1.0, 5.0], "body": "b1"}, "t": 0.5},
                {"edge": {"kind": "edge", "by": "nearest", "point": [7.0, 1.0, 5.0], "body": "b1"}, "t": 0.5},
                {"edge": {"kind": "edge", "by": "nearest", "point": [3.0, 6.0, 5.0], "body": "b1"}, "t": 0.5}]}})
    );
}

#[test]
fn every_tool_id_is_its_own() {
    let mut ids: Vec<&str> = TOOLS.iter().map(|t| t.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), TOOLS.len());
}

#[test]
fn an_axis_on_edge_follows_a_straight_edge_and_refuses_a_curved_one() {
    let d = doc(json!({}));
    let words = "Select a straight edge, then Axis on Edge";
    assert_eq!(run("datum-axis-edge", &d, vec![]).unwrap_err(), words);
    assert_eq!(run("datum-axis-edge", &d, vec![edge("b1", 2, [3., -1., 6.])]).unwrap_err(), words);
    let tilted = Pick::Edge { body: "b1".into(), edge: 2, mid: [3., -1., 6.], dir: Some([0.6, 0.0, -0.8]) };
    let (_, s) = run("datum-axis-edge", &d, vec![tilted]).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f1", "type": "datumAxis", "origin": [3.0, -1.0, 6.0], "dir": [0.6, 0.0, -0.8], "name": "Axis",
            "axisEdge": {"kind": "edge", "by": "nearest", "point": [3.0, -1.0, 6.0], "body": "b1"}})
    );
}
