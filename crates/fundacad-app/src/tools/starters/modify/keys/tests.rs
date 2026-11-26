use std::sync::Arc;

use glam::Vec3;
use serde_json::{json, Value};

use super::{press, replace};
use crate::viewport::scene::tests::block;
use crate::viewport::scene::Body;

fn shown() -> Vec<Arc<Body>> {
    let mut b = block(Vec3::new(5.0, -3.0, 2.0), Vec3::new(35.0, 9.0, 9.0), "f1");
    b.id = "b1".into();
    let mut c = block(Vec3::new(-40.0, 1.0, 0.5), Vec3::new(-27.5, 18.25, 4.0), "f2");
    c.id = "b2".into();
    vec![Arc::new(b), Arc::new(c)]
}

fn linear(count: i64) -> Value {
    json!({"id": "f3", "type": "patternLinear", "count": count, "spacing": 12.5, "axis": "X"})
}

#[test]
fn brackets_drop_and_add_a_copy_between_one_and_a_hundred() {
    assert_eq!(press(&linear(4), "]", &shown()), Some(linear(5)));
    assert_eq!(press(&linear(4), "[", &shown()), Some(linear(3)));
    assert_eq!(press(&linear(2), "[", &shown()), Some(linear(1)));
    assert_eq!(press(&linear(1), "[", &shown()), None);
    assert_eq!(press(&linear(99), "]", &shown()), Some(linear(100)));
    assert_eq!(press(&linear(100), "]", &shown()), None);
    let rect = json!({"type": "patternRect", "countX": 3, "countY": 3});
    assert_eq!(press(&rect, "]", &[]), Some(json!({"type": "patternRect", "countX": 4, "countY": 3})));
    let circ = json!({"type": "patternCircular", "count": 6, "angle": 360, "axis": "Z"});
    assert_eq!(press(&circ, "[", &[]), Some(json!({"type": "patternCircular", "count": 5, "angle": 360, "axis": "Z"})));
}

#[test]
fn x_turns_a_draft_to_the_next_axis() {
    let draft = |axis: &str| json!({"type": "draft", "faces": [], "angle": 3, "axis": axis});
    assert_eq!(press(&draft("X"), "x", &[]), Some(draft("Y")));
    assert_eq!(press(&draft("Y"), "x", &[]), Some(draft("Z")));
    assert_eq!(press(&draft("Z"), "x", &[]), Some(draft("X")));
    assert_eq!(press(&json!({"type": "draft"}), "x", &[]), Some(json!({"type": "draft", "axis": "X"})));
}

#[test]
fn c_moves_a_circular_axis_to_the_middle_and_back() {
    let at_origin = json!({"type": "patternCircular", "count": 4, "angle": 360, "axis": "Y", "bodies": ["b1"]});
    let in_middle = json!({"type": "patternCircular", "count": 4, "angle": 360, "bodies": ["b1"],
        "axis": {"origin": [20.0, 3.0, 5.5], "dir": [0.0, 1.0, 0.0]}});
    assert_eq!(press(&at_origin, "c", &shown()), Some(in_middle.clone()));
    assert_eq!(press(&in_middle, "c", &shown()), Some(at_origin.clone()));
    let active = json!({"type": "patternCircular", "axis": "Z"});
    assert_eq!(
        press(&active, "c", &shown()),
        Some(json!({"type": "patternCircular", "axis": {"origin": [-33.75, 9.63, 2.25], "dir": [0.0, 0.0, 1.0]}}))
    );
    assert_eq!(press(&active, "c", &[]), None);
    let tilted = json!({"type": "patternCircular", "axis": {"origin": [1.0, 2.0, 3.0], "dir": [0.6, 0.0, 0.8]}});
    assert_eq!(press(&tilted, "c", &shown()), None);
    let followed = json!({"type": "patternCircular", "axis": "Z", "axisRef": {"kind": "edge"}});
    assert_eq!(press(&followed, "c", &shown()), None);
}

#[test]
fn other_keys_and_tools_are_left_to_the_key_table() {
    assert_eq!(press(&linear(4), "x", &shown()), None);
    assert_eq!(press(&linear(4), "c", &shown()), None);
    assert_eq!(press(&json!({"type": "fillet", "radius": 2}), "]", &shown()), None);
    assert_eq!(press(&json!({"radius": 2}), "]", &shown()), None);
}

#[test]
fn replace_swaps_the_feature_with_that_id() {
    let mut doc = json!({"features": [{"id": "f1", "type": "box"}, linear(4)]}).as_object().cloned().unwrap();
    replace(&mut doc, "f3", linear(7)).unwrap();
    assert_eq!(Value::Object(doc.clone()), json!({"features": [{"id": "f1", "type": "box"}, linear(7)]}));
    assert_eq!(replace(&mut doc, "f9", linear(2)), Err("the document has no feature f9".into()));
}
