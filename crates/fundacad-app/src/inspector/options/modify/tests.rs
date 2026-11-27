use serde_json::{json, Map, Value};

use crate::inspector::{rows, set_option, Choice, ChoiceRow, Row};

fn doc(features: Value) -> Map<String, Value> {
    json!({ "features": features }).as_object().cloned().unwrap()
}

fn plain(d: &Map<String, Value>, id: &str) -> Vec<Row> {
    rows(d, id, &[]).into_iter().filter(|r| !matches!(r, Row::Number(_))).collect()
}

fn c(value: &str, label: &str) -> Choice {
    Choice { value: value.into(), label: label.into() }
}

fn keep(current: &str) -> Row {
    let options = vec![c("both", "Both"), c("top", "Top"), c("bottom", "Bottom")];
    Row::Choice(ChoiceRow { field: "keep", label: "field.keep", options, current: current.into() })
}

fn plane(mut extra: Vec<Choice>, current: &str) -> Row {
    let mut options = vec![c("XY", "XY"), c("XZ", "XZ"), c("YZ", "YZ")];
    options.append(&mut extra);
    Row::Choice(ChoiceRow { field: "plane", label: "field.plane", options, current: current.into() })
}

fn bodies(text: &str, empty: bool) -> Row {
    Row::Target { label: "selectionTarget.bodies", text: text.into(), empty }
}

fn split_doc(split: Value) -> Map<String, Value> {
    doc(json!([
        {"id": "f1", "type": "box", "length": 30, "width": 12, "height": 7},
        {"id": "p1", "type": "datumPlane", "plane": "XZ", "offset": 3.5, "name": "Cut"},
        split,
        {"id": "p2", "type": "datumPlane", "plane": "YZ", "name": "Later"},
    ]))
}

#[test]
fn a_split_shows_its_side_and_plane_with_the_datums_above_it() {
    let d = split_doc(json!({"id": "f3", "type": "split", "plane": "YZ", "keep": "top", "bodies": ["f1"]}));
    assert_eq!(plain(&d, "f3"), vec![bodies("1 body", false), keep("top"), plane(vec![c("p1", "Cut")], "YZ")]);
    let d = split_doc(json!({"id": "f3", "type": "split", "planeId": "p1", "keep": "both"}));
    assert_eq!(
        plain(&d, "f3"),
        vec![bodies("the active body", true), keep("both"), plane(vec![c("p1", "Cut")], "p1")]
    );
    let face = json!({"origin": [4.5, -2, 7], "normal": [0, 0, 1], "xdir": [1, 0, 0]});
    let d = split_doc(json!({"id": "f3", "type": "split", "plane": face, "keep": "bottom"}));
    assert_eq!(plain(&d, "f3")[2], plane(vec![c("p1", "Cut"), c("picked", "Picked face")], "picked"));
    let d = split_doc(json!({"id": "f3", "type": "split", "planeId": "gone", "keep": "both"}));
    assert_eq!(plain(&d, "f3")[2], plane(vec![c("p1", "Cut"), c("gone", "gone (missing)")], "gone"));
}

#[test]
fn choosing_a_split_plane_swaps_plane_and_plane_id() {
    let mut d = split_doc(json!({"id": "f3", "type": "split", "plane": "XY", "keep": "both"}));
    set_option(&mut d, "f3", "plane", &json!("p1")).unwrap();
    assert_eq!(d["features"][2], json!({"id": "f3", "type": "split", "planeId": "p1", "keep": "both"}));
    set_option(&mut d, "f3", "plane", &json!("XZ")).unwrap();
    assert_eq!(d["features"][2], json!({"id": "f3", "type": "split", "plane": "XZ", "keep": "both"}));
    set_option(&mut d, "f3", "plane", &json!("picked")).unwrap();
    set_option(&mut d, "f3", "plane", &json!("")).unwrap();
    assert_eq!(d["features"][2], json!({"id": "f3", "type": "split", "plane": "XZ", "keep": "both"}));
    set_option(&mut d, "f3", "keep", &json!("bottom")).unwrap();
    assert_eq!(d["features"][2], json!({"id": "f3", "type": "split", "plane": "XZ", "keep": "bottom"}));
}

#[test]
fn copy_turns_a_move_into_a_duplicate_and_back() {
    let mut d = doc(json!([{"id": "f2", "type": "move", "dx": 12.5, "rz": -30, "bodies": ["f1"]}]));
    let toggle = |on| Row::Toggle { field: "copy", label: "field.copy", on };
    assert_eq!(plain(&d, "f2"), vec![bodies("1 body", false), toggle(false)]);
    set_option(&mut d, "f2", "copy", &json!(true)).unwrap();
    assert_eq!(d["features"][0], json!({"id": "f2", "type": "duplicate", "dx": 12.5, "rz": -30, "bodies": ["f1"]}));
    assert_eq!(plain(&d, "f2"), vec![bodies("1 body", false), toggle(true)]);
    set_option(&mut d, "f2", "copy", &json!(false)).unwrap();
    assert_eq!(d["features"][0]["type"], json!("move"));
    let d = doc(json!([{"id": "f2", "type": "scale", "factor": 2}]));
    assert!(!plain(&d, "f2").iter().any(|r| matches!(r, Row::Toggle { .. })));
}
