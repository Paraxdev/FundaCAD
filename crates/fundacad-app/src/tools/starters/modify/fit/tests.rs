use std::sync::Arc;

use glam::Vec3;
use serde_json::{json, Value};

use super::{fit, Fitted};
use crate::selection::{Pick, PickKind, Selection};
use crate::tools::{started, tool, Doc, Target};
use crate::viewport::scene::tests::block;
use crate::viewport::scene::Body;

fn doc(features: Value) -> Doc {
    json!({ "features": features }).as_object().cloned().unwrap()
}

fn plain() -> Doc {
    doc(json!([{"id": "f1", "type": "box"}, {"id": "f2", "type": "box"}]))
}

fn holed() -> Doc {
    doc(json!([
        {"id": "f1", "type": "box"},
        {"id": "f2", "type": "extrude", "operation": "cut"},
        {"id": "f3", "type": "hole"},
        {"id": "f4", "type": "extrude", "operation": "new"},
    ]))
}

fn named(id: &str, mut b: Body) -> Arc<Body> {
    b.id = id.into();
    Arc::new(b)
}

/// `blocks` joined into one body, block k's faces numbered from 6k.
fn joined(id: &str, blocks: &[(Vec3, Vec3, &str)]) -> Arc<Body> {
    let mut out = Body { id: id.into(), ..Default::default() };
    for (k, (lo, hi, owner)) in blocks.iter().enumerate() {
        let b = block(*lo, *hi, owner);
        let base = out.positions.len() as u32 / 3;
        out.positions.extend(&b.positions);
        out.indices.extend(b.indices.iter().map(|i| i + base));
        out.face_ids.extend(b.face_ids.iter().map(|f| f + 6 * k as u32));
        out.face_owners.extend(b.face_owners);
    }
    Arc::new(out)
}

fn face(body: &str, face: u32) -> Pick {
    Pick::Face { body: body.into(), face, point: [4.0, -2.5, 7.0], normal: [0.0, 0.0, 1.0] }
}

fn fitted(id: &str, d: &Doc, picks: Vec<Pick>, shown: &[Arc<Body>]) -> Fitted {
    let s = Selection { picks };
    let (_, start) = started(tool(id).unwrap(), d, &s).unwrap();
    fit(id, start, d, &s, shown)
}

fn feature(id: &str, d: &Doc, picks: Vec<Pick>, shown: &[Arc<Body>]) -> Value {
    let f = fitted(id, d, picks, shown);
    assert_eq!(f.before, Vec::<Value>::new());
    f.start.feature
}

fn two_bodies() -> Vec<Arc<Body>> {
    vec![
        named("b1", block(Vec3::new(5.0, -3.0, 2.0), Vec3::new(35.0, 9.0, 9.0), "f1")),
        named("b2", block(Vec3::new(-40.0, 1.0, 0.5), Vec3::new(-27.5, 18.25, 4.0), "f2")),
    ]
}

#[test]
fn a_linear_pattern_spaces_the_active_body_by_its_length() {
    let f = feature("pattern-linear", &plain(), vec![], &two_bodies());
    assert_eq!(f, json!({"id": "f3", "type": "patternLinear", "count": 4, "spacing": 12.5, "axis": "X"}));
}

#[test]
fn a_pattern_with_nothing_built_keeps_twenty() {
    let f = feature("pattern-linear", &plain(), vec![], &[]);
    assert_eq!(f, json!({"id": "f3", "type": "patternLinear", "count": 4, "spacing": 20.0, "axis": "X"}));
    let flat = vec![named("b1", block(Vec3::new(3.0, 1.0, 0.0), Vec3::new(3.0, 8.0, 5.0), "f1"))];
    let f = feature("pattern-linear", &plain(), vec![], &flat);
    assert_eq!(f["spacing"], json!(20.0));
}

#[test]
fn a_rect_pattern_spaces_the_picked_bodies_both_ways() {
    let picks = vec![Pick::Body { body: "b1".into() }];
    let f = feature("pattern-rect", &plain(), picks, &two_bodies());
    assert_eq!(
        f,
        json!({"id": "f3", "type": "patternRect", "countX": 3, "countY": 3, "spacingX": 30.0, "spacingY": 12.0,
            "bodies": ["b1"]})
    );
    let picks = vec![Pick::Body { body: "b2".into() }, Pick::Body { body: "b1".into() }];
    let f = feature("pattern-rect", &plain(), picks, &two_bodies());
    assert_eq!((f["spacingX"].clone(), f["spacingY"].clone()), (json!(75.0), json!(21.25)));
}

fn drilled() -> Vec<Arc<Body>> {
    vec![joined(
        "b1",
        &[
            (Vec3::new(5.0, -3.0, 2.0), Vec3::new(35.0, 9.0, 9.0), "f1"),
            (Vec3::new(10.0, 0.0, 2.0), Vec3::new(14.5, 4.0, 9.0), "f3"),
            (Vec3::new(20.0, 1.0, 2.0), Vec3::new(21.0, 6.0, 9.0), "f2"),
            (Vec3::new(30.0, 1.0, 2.0), Vec3::new(31.0, 2.0, 9.0), "f4"),
        ],
    )]
}

#[test]
fn a_face_of_a_hole_patterns_the_hole() {
    let f = feature("pattern-linear", &holed(), vec![face("b1", 8)], &drilled());
    assert_eq!(f, json!({"id": "f5", "type": "patternLinear", "count": 4, "spacing": 4.5, "axis": "X", "features": ["f3"]}));
}

#[test]
fn faces_of_several_cuts_pattern_them_in_timeline_order() {
    let picks = vec![face("b1", 8), face("b1", 13), face("b1", 7)];
    let f = feature("pattern-rect", &holed(), picks, &drilled());
    assert_eq!(
        f,
        json!({"id": "f5", "type": "patternRect", "countX": 3, "countY": 3, "spacingX": 11.0, "spacingY": 6.0,
            "features": ["f2", "f3"]})
    );
}

#[test]
fn a_face_of_a_box_or_a_new_extrude_patterns_its_body() {
    for picked in [1, 19] {
        let f = feature("pattern-linear", &holed(), vec![face("b1", picked)], &drilled());
        assert_eq!(f, json!({"id": "f5", "type": "patternLinear", "count": 4, "spacing": 30.0, "axis": "X", "bodies": ["b1"]}));
    }
}

#[test]
fn a_circular_pattern_of_a_hole_keeps_its_angle() {
    let f = feature("pattern-circular", &holed(), vec![Pick::Body { body: "b1".into() }, face("b1", 6)], &drilled());
    assert_eq!(f["features"], json!(["f3"]));
    assert_eq!(f.get("bodies"), None);
    assert_eq!(f.get("spacing"), None);
    assert_eq!(f["angle"], json!(360));
}

#[test]
fn a_split_by_a_datum_alone_cuts_every_shown_body() {
    let picks = vec![Pick::Plane { id: "f2".into() }];
    let f = feature("split", &plain(), picks, &two_bodies());
    assert_eq!(f, json!({"id": "f3", "type": "split", "keep": "both", "groupSides": true, "planeId": "f2", "bodies": ["b1", "b2"]}));
    let picks = vec![Pick::Plane { id: "f2".into() }, Pick::Body { body: "b2".into() }];
    assert_eq!(feature("split", &plain(), picks, &two_bodies())["bodies"], json!(["b2"]));
    let picks = vec![Pick::Plane { id: "XZ".into() }];
    assert_eq!(feature("split", &plain(), picks, &two_bodies()).get("bodies"), None);
}

#[test]
fn separate_takes_the_only_body_or_waits_for_a_pick() {
    let one = vec![two_bodies().remove(1)];
    let s = fitted("separate", &plain(), vec![], &one).start;
    assert_eq!(s.feature, json!({"id": "f3", "type": "separate", "bodies": ["b2"]}));
    assert_eq!(s.arm(), None);
    let s = fitted("separate", &plain(), vec![], &two_bodies()).start;
    assert_eq!(s.feature, json!({"id": "f3", "type": "separate", "bodies": []}));
    assert_eq!(s.arm(), Some(Target { field: "bodies", kind: PickKind::Body, many: true }));
    let s = fitted("separate", &plain(), vec![face("b1", 2)], &two_bodies()).start;
    assert_eq!(s.feature["bodies"], json!(["b1"]));
}

#[test]
fn a_mirror_about_a_flat_face_puts_a_mirror_plane_before_it() {
    let f = fitted("mirror", &plain(), vec![face("b1", 5)], &two_bodies());
    assert_eq!(f.start.feature, json!({"id": "f3", "type": "mirror", "plane": {"name": "f4"}, "bodies": ["b1"]}));
    assert_eq!(
        f.before,
        vec![json!({"id": "f4", "type": "datumPlane", "offset": 0, "name": "Mirror plane",
            "plane": {"origin": [4.0, -2.5, 7.0], "normal": [0.0, 0.0, 1.0], "xdir": [1.0, 0.0, 0.0]},
            "face": {"kind": "face", "by": "nearest", "point": [4.0, -2.5, 7.0], "body": "b1"}, "at": [4.0, -2.5, 7.0]})]
    );
}

#[test]
fn a_mirror_with_a_plane_picked_needs_no_datum() {
    let picks = vec![face("b1", 5), Pick::Plane { id: "YZ".into() }];
    let f = feature("mirror", &plain(), picks, &two_bodies());
    assert_eq!(f, json!({"id": "f3", "type": "mirror", "plane": {"name": "YZ"}, "bodies": ["b1"]}));
    assert_eq!(feature("mirror", &plain(), vec![], &two_bodies()), json!({"id": "f3", "type": "mirror", "plane": "XY"}));
}
