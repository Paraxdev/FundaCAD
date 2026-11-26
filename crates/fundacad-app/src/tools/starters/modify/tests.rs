use serde_json::{json, Value};

use crate::selection::{Pick, PickKind, Selection};
use crate::tools::{started, tool, Doc, Start, Target};

fn doc() -> Doc {
    json!({"features": [{"id": "f1", "type": "box", "length": 30, "width": 12, "height": 7}]}).as_object().cloned().unwrap()
}

fn face(body: &str, face: u32, point: [f32; 3], normal: [f32; 3]) -> Pick {
    Pick::Face { body: body.into(), face, point, normal }
}

fn edge(body: &str, edge: u32, mid: [f32; 3]) -> Pick {
    Pick::Edge { body: body.into(), edge, mid }
}

fn body(b: &str) -> Pick {
    Pick::Body { body: b.into() }
}

fn plane(id: &str) -> Pick {
    Pick::Plane { id: id.into() }
}

fn run(id: &str, picks: Vec<Pick>) -> Result<Start, String> {
    started(tool(id).unwrap(), &doc(), &Selection { picks }).map(|(_, s)| s)
}

fn sel(kind: &str, point: [f32; 3], body: &str) -> Value {
    json!({"kind": kind, "by": "nearest", "point": point, "body": body})
}

const FACES: Target = Target { field: "faces", kind: PickKind::Face, many: true };

#[test]
fn pull_axis_is_the_one_the_normal_leans_on_least() {
    use super::pull_axis;
    assert_eq!(pull_axis([0.97, 0.0, 0.24]), "Y");
    assert_eq!(pull_axis([0.0, -0.8, 0.6]), "X");
    assert_eq!(pull_axis([0.3, -0.9, 0.1]), "Z");
    assert_eq!(pull_axis([0.0, 0.0, 1.0]), "X");
    assert_eq!(pull_axis([1.0, 0.0, 0.0]), "Y");
}

#[test]
fn draft_takes_the_selected_faces_or_picks_them() {
    let s = run("draft", vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "draft", "faces": [], "angle": 3, "axis": "Z"}));
    assert_eq!(s.arm(), Some(FACES));
    let s = run("draft", vec![face("f1", 4, [30.0, 6.5, 3.5], [1.0, 0.0, 0.0])]).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f2", "type": "draft", "faces": [sel("face", [30.0, 6.5, 3.5], "f1")], "angle": 3, "axis": "Y"})
    );
    assert_eq!(s.arm(), None);
    assert_eq!(s.need, vec![FACES]);
    let picks = vec![
        edge("f1", 2, [1.0, 2.0, 3.0]),
        face("f1", 1, [15.0, 0.0, 3.5], [0.0, -1.0, 0.0]),
        face("f1", 3, [0.0, 6.0, 2.5], [-1.0, 0.0, 0.0]),
    ];
    let s = run("draft", picks).unwrap();
    assert_eq!(s.feature["faces"], json!([sel("face", [15.0, 0.0, 3.5], "f1"), sel("face", [0.0, 6.0, 2.5], "f1")]));
    assert_eq!(s.feature["axis"], json!("X"));
}

#[test]
fn offset_face_takes_the_selected_faces_or_picks_them() {
    let s = run("offset-face", vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "offsetFace", "faces": [], "distance": 1}));
    assert_eq!(s.arm(), Some(FACES));
    let s = run("offset-face", vec![face("f1", 6, [12.0, 4.0, 7.0], [0.0, 0.0, 1.0]), body("f1")]).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f2", "type": "offsetFace", "faces": [sel("face", [12.0, 4.0, 7.0], "f1")], "distance": 1})
    );
    assert_eq!(s.arm(), None);
}

#[test]
fn split_cuts_by_the_picked_plane_or_xy() {
    let base = json!({"id": "f2", "type": "split", "keep": "both", "groupSides": true});
    let with = |extra: Value| {
        let mut f = base.clone();
        f.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        f
    };
    let s = run("split", vec![]).unwrap();
    assert_eq!((s.feature, s.need), (with(json!({"plane": "XY"})), vec![]));
    let s = run("split", vec![plane("XZ"), body("f1")]).unwrap();
    assert_eq!(s.feature, with(json!({"plane": "XZ", "bodies": ["f1"]})));
    let s = run("split", vec![body("f1"), body("f7"), plane("p3")]).unwrap();
    assert_eq!(s.feature, with(json!({"planeId": "p3", "bodies": ["f1", "f7"]})));
    let s = run("split", vec![face("f1", 2, [30.0, 6.5, 3.5], [1.0, 0.0, 0.0])]).unwrap();
    assert_eq!(
        s.feature,
        with(json!({"plane": {"origin": [30.0, 6.5, 3.5], "normal": [1.0, 0.0, 0.0], "xdir": [0.0, 1.0, 0.0]},
            "bodies": ["f1"]}))
    );
}

#[test]
fn patterns_start_with_fundacad_1s_counts_on_the_selected_bodies() {
    let s = run("pattern-linear", vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "patternLinear", "count": 4, "spacing": 20, "axis": "X"}));
    assert_eq!(s.need, vec![]);
    let s = run("pattern-linear", vec![body("f1"), face("f4", 1, [1.0, 2.0, 3.0], [0.0, 0.0, 1.0]), body("f1")]).unwrap();
    assert_eq!(s.feature["bodies"], json!(["f1", "f4"]));
    let s = run("pattern-rect", vec![body("f1")]).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f2", "type": "patternRect", "countX": 3, "countY": 3, "spacingX": 20, "spacingY": 20, "bodies": ["f1"]})
    );
    let s = run("pattern-rect", vec![]).unwrap();
    assert!(s.feature.get("bodies").is_none());
}

#[test]
fn a_circular_pattern_turns_about_z_or_the_picked_edge_or_face() {
    let s = run("pattern-circular", vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z"}));
    let s = run("pattern-circular", vec![body("f1"), edge("f1", 9, [15.0, -6.0, 3.5])]).unwrap();
    assert_eq!(
        s.feature,
        json!({"id": "f2", "type": "patternCircular", "count": 4, "angle": 360,
            "axis": {"origin": [15.0, -6.0, 3.5], "dir": [0.0, 0.0, 1.0]},
            "axisRef": sel("edge", [15.0, -6.0, 3.5], "f1"), "bodies": ["f1"]})
    );
    let s = run("pattern-circular", vec![face("f1", 5, [2.5, 3.0, 7.0], [0.0, 1.0, 0.0]), body("f8"), body("f9")]).unwrap();
    assert_eq!(s.feature["axis"], json!({"origin": [2.5, 3.0, 7.0], "dir": [0.0, 1.0, 0.0]}));
    assert_eq!(s.feature["axisRef"], sel("face", [2.5, 3.0, 7.0], "f1"));
    assert_eq!(s.feature["bodies"], json!(["f8", "f9"]));
}

#[test]
fn mirror_names_its_plane_by_ref_once_it_names_bodies() {
    let s = run("mirror", vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "mirror", "plane": "XY"}));
    let s = run("mirror", vec![plane("YZ")]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "mirror", "plane": "YZ"}));
    let s = run("mirror", vec![body("f1"), plane("p4"), body("f6")]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "mirror", "plane": {"name": "p4"}, "bodies": ["f1", "f6"]}));
    assert_eq!(s.need, vec![]);
}

#[test]
fn move_and_scale_act_on_the_selected_bodies_or_the_active_one() {
    let s = run("move", vec![]).unwrap();
    assert_eq!((s.feature, s.need), (json!({"id": "f2", "type": "move"}), vec![]));
    let s = run("move", vec![body("f1"), edge("f3", 1, [0.5, 0.5, 0.5])]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "move", "bodies": ["f1", "f3"]}));
    let s = run("scale", vec![]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "scale", "factor": 1}));
    let s = run("scale", vec![body("f1")]).unwrap();
    assert_eq!(s.feature, json!({"id": "f2", "type": "scale", "factor": 1, "bodies": ["f1"]}));
}
