use serde_json::{json, Map, Value};

use super::*;

fn doc(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn all(d: &Map<String, Value>) -> Vec<&Map<String, Value>> {
    d["features"].as_array().unwrap().iter().filter_map(Value::as_object).collect()
}

fn values(c: &[Choice]) -> Vec<(&str, &str)> {
    c.iter().map(|c| (c.value.as_str(), c.label.as_str())).collect()
}

fn sketch(id: &str) -> Value {
    json!({"id": id, "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "id": "r1", "x": 12, "y": 4, "width": 10, "height": 6}]})
}

fn with(revolve: Value) -> Map<String, Value> {
    doc(json!({"features": [
        sketch("f1"),
        {"id": "f2", "type": "datumAxis", "name": "Spindle", "origin": [4, -1, 2], "dir": [0, 0, 1]},
        revolve,
        {"id": "f4", "type": "datumAxis", "origin": [0, 0, 0], "dir": [1, 0, 0]},
    ]}))
}

#[test]
fn the_revolve_axis_row_lists_world_sketch_and_datum_axes_above_it() {
    let y = json!({"origin": [0.0, 0.0, 0.0], "dir": [0.0, 1.0, 0.0]});
    let cases = [
        (json!("X"), None, "X", None),
        (Value::Null, None, "Z", None),
        (y.clone(), None, SKETCH, None),
        (json!({"origin": [4, -1, 2], "dir": [0, 0, 1]}), None, "f2", None),
        (json!({"origin": [9, 9, 9], "dir": [0, 1, 0]}), None, PLACED, Some("Line")),
        (y, Some(json!({"kind": "edge", "by": "nearest", "point": [1, 2, 3], "body": "b"})), PLACED, Some("Edge")),
    ];
    for (axis, edge, want, extra) in cases {
        let mut r = json!({"id": "f3", "type": "revolve", "sketch": "f1", "axis": axis});
        if let Some(e) = edge {
            r["axisEdge"] = e;
        }
        let d = with(r);
        let f = all(&d)[2];
        let (options, current) = revolve_axis_choice(&d, f, &all(&d));
        let mut expect = vec![("X", "X"), ("Y", "Y"), ("Z", "Z"), (SKETCH, "Sketch"), ("f2", "Spindle")];
        if let Some(label) = extra {
            expect.push((PLACED, label));
        }
        assert_eq!((values(&options), current.as_str()), (expect, want));
    }
    let d = with(json!({"id": "f3", "type": "revolve", "axis": "W"}));
    let (options, current) = revolve_axis_choice(&d, all(&d)[2], &all(&d));
    assert_eq!((values(&options), current.as_str()), (vec![("X", "X"), ("Y", "Y"), ("Z", "Z"), ("f2", "Spindle"), ("W", "W")], "W"));
}

#[test]
fn picking_an_axis_writes_its_line_and_drops_the_edge() {
    let d = with(json!({"id": "f3", "type": "revolve", "sketch": "f1", "axis": "Z", "axisEdge": {"kind": "edge"}}));
    let (f, a) = (all(&d)[2], all(&d));
    let patch = |v: &str| revolve_axis_patch(&d, f, &a, v);
    assert_eq!(patch("Y"), Some(vec![("axis".into(), Some(json!("Y"))), ("axisEdge".into(), None)]));
    assert_eq!(
        patch(SKETCH),
        Some(vec![("axis".into(), Some(json!({"origin": [0.0, 0.0, 0.0], "dir": [0.0, 1.0, 0.0]}))), ("axisEdge".into(), None)])
    );
    assert_eq!(
        patch("f2"),
        Some(vec![("axis".into(), Some(json!({"origin": [4, -1, 2], "dir": [0, 0, 1]}))), ("axisEdge".into(), None)])
    );
    assert_eq!(patch("f4"), None, "a datum below the revolve is not offered");
    assert_eq!(patch(PLACED), None);
    let bare = with(json!({"id": "f3", "type": "revolve", "axis": "Z"}));
    assert_eq!(revolve_axis_patch(&bare, all(&bare)[2], &all(&bare), SKETCH), None);
}

#[test]
fn the_sweep_path_row_lists_the_other_sketches_above() {
    let d = doc(json!({"features": [
        sketch("f1"), {"id": "f2", "type": "sketch", "name": " Rail "}, {"id": "f3", "type": "box"},
        {"id": "f4", "type": "sweep", "profile": "f1", "path": "f2"}, sketch("f5"),
    ]}));
    let (options, current) = sweep_path_choice(all(&d)[3], &all(&d));
    assert_eq!((values(&options), current.as_str()), (vec![("f2", "Rail")], "f2"));
    let none = doc(json!({"features": [sketch("f1"), {"id": "f2", "type": "sweep", "profile": "f1"}]}));
    let (options, current) = sweep_path_choice(all(&none)[1], &all(&none));
    assert_eq!((values(&options), current.as_str()), (vec![("", "None")], ""));
    let gone = doc(json!({"features": [sketch("f1"), sketch("f2"), sketch("f3"), {"id": "f4", "type": "sweep", "profile": "f2", "path": "f9"}]}));
    let (options, current) = sweep_path_choice(all(&gone)[3], &all(&gone));
    assert_eq!((values(&options), current.as_str()), (vec![("f1", "f1"), ("f3", "f3"), ("f9", "f9 (missing)")], "f9"));
}
