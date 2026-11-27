use glam::DVec2;
use serde_json::{json, Value};

use crate::sketch::{add_sketch, escape, Editor, Tool};

const PPM: f64 = 10.0;

fn editor(shapes: Value) -> Editor {
    let mut d = json!({"features": []}).as_object().cloned().unwrap();
    add_sketch(&mut d, json!("XY")).unwrap();
    let mut e = Editor::open(&d, "sketch1").unwrap();
    e.entities = shapes.as_array().unwrap().clone();
    e.resolve(false);
    e
}

fn p(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

fn ids(e: &Editor) -> Vec<&str> {
    e.entities.iter().map(|x| x["id"].as_str().unwrap()).collect()
}

fn cross() -> Value {
    json!([
        {"id": "l1", "type": "line", "x1": 0, "y1": 0, "x2": 30, "y2": 0},
        {"id": "l2", "type": "line", "x1": 10, "y1": -5, "x2": 10, "y2": 5},
        {"id": "l3", "type": "line", "x1": 20, "y1": -5, "x2": 20, "y2": 5}
    ])
}

#[test]
fn trim_splits_the_clicked_line_in_place_and_drops_its_constraints() {
    let mut e = editor(cross());
    e.constraints.push(json!({"type": "horizontal", "line": "l1"}));
    e.arm(Tool::Trim);
    assert_eq!(e.click(p(15.0, 0.0), PPM).as_deref(), Some("Trim"));
    assert_eq!(ids(&e), ["line1", "line2", "l2", "l3"]);
    assert!(e.constraints.is_empty());
    assert_eq!(e.tool, Tool::Trim, "the tool stays armed");
}

#[test]
fn extend_keeps_the_line_id() {
    let mut e = editor(json!([
        {"id": "l1", "type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0},
        {"id": "l2", "type": "line", "x1": 25, "y1": -5, "x2": 25, "y2": 5}
    ]));
    e.arm(Tool::Extend);
    assert!(e.click(p(9.0, 0.0), PPM).is_some());
    assert_eq!(e.entities[0]["id"], "l1");
    assert!((e.entities[0]["x2"].as_f64().unwrap() - 25.0).abs() < 1e-6);
}

#[test]
fn fillet_picks_two_lines_then_takes_a_typed_radius() {
    let mut e = editor(json!([
        {"id": "a", "type": "line", "x1": 0, "y1": 0, "x2": 20, "y2": 0},
        {"id": "b", "type": "line", "x1": 20, "y1": 0, "x2": 20, "y2": 20}
    ]));
    e.arm(Tool::Fillet);
    assert!(e.click(p(10.0, 0.0), PPM).is_none());
    assert_eq!(e.first.as_deref(), Some("a"));
    assert!(e.click(p(20.0, 10.0), PPM).is_none());
    assert_eq!(e.entry.as_deref(), Some(""));
    e.entry_key("5", Some("5"));
    assert!(e.entry_key("enter", None).is_some());
    assert_eq!(ids(&e), ["a", "b", "arc1"]);
    assert!((e.entities[0]["x2"].as_f64().unwrap() - 15.0).abs() < 1e-6);
    let kinds: Vec<&Value> = e.constraints.iter().map(|c| &c["type"]).collect();
    assert_eq!(kinds, ["tangent2", "tangent2"]);
    assert_eq!((e.first.as_ref(), e.entry.as_ref()), (None, None));
}

#[test]
fn offset_follows_the_cursor_and_a_typed_sign_picks_the_side() {
    let mut e = editor(json!([{"id": "c1", "type": "circle", "x": 0, "y": 0, "radius": 5}]));
    e.arm(Tool::Offset);
    assert!(e.click(p(5.0, 0.0), PPM).is_none());
    assert_eq!(e.prompt(), "Move to pick the side, or type a distance · Enter · Esc");
    e.hover(p(8.0, 0.0), PPM);
    assert_eq!(e.modify_preview()[0]["radius"], 8.0);
    e.entry_key("-", Some("-"));
    e.entry_key("2", Some("2"));
    assert_eq!(e.modify_preview()[0]["radius"], 3.0);
    assert!(e.entry_key("enter", None).is_some());
    assert_eq!(ids(&e), ["c1", "circle1"]);
    assert_eq!(e.constraints[0]["type"], "offset");
    assert_eq!(e.constraints[0]["value"], -2.0);
    assert_eq!(e.constraints[0]["pairs"], json!([{"src": "c1", "cpy": "circle1"}]));
}

#[test]
fn offset_of_a_rectangle_pairs_its_four_sides() {
    let mut e = editor(json!([{"id": "r1", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 4}]));
    e.arm(Tool::Offset);
    e.click(p(5.0, 0.0), PPM);
    assert!(e.click(p(6.0, 0.0), PPM).is_some(), "the second click applies");
    assert_eq!(e.constraints[0]["pairs"].as_array().unwrap().len(), 4);
    assert_eq!(e.constraints[0]["pairs"][2], json!({"src": "r1~2", "cpy": "rect1~2"}));
}

#[test]
fn esc_drops_a_half_placed_offset_then_the_tool() {
    let mut e = editor(json!([{"id": "c1", "type": "circle", "x": 0, "y": 0, "radius": 5}]));
    e.arm(Tool::Offset);
    e.click(p(5.0, 0.0), PPM);
    assert_eq!(escape::action(e.escape_state()), escape::Action::CancelPending);
    e.escape();
    assert_eq!((e.offset.as_ref(), e.entry.as_ref()), (None, None));
    e.escape();
    assert_eq!(e.tool, Tool::Select);
}

#[test]
fn mirror_takes_the_selection_then_a_line_and_enter_applies() {
    let mut e = editor(json!([
        {"id": "c1", "type": "circle", "x": 5, "y": 3, "radius": 1, "construction": true},
        {"id": "ax", "type": "line", "x1": 0, "y1": -10, "x2": 0, "y2": 10}
    ]));
    e.selected = Some("c1".into());
    e.arm(Tool::Mirror);
    assert_eq!(e.mirror.as_ref().unwrap().objects, ["c1"]);
    assert!(e.mirror_key("enter").is_none());
    assert!(e.mirror.as_ref().unwrap().picking_line);
    e.click(p(0.0, 5.0), PPM);
    assert_eq!(e.modify_preview()[0]["x"], -5.0);
    assert!(e.mirror_key("enter").is_some());
    let copy = &e.entities[2];
    assert_eq!((copy["x"].as_f64(), copy["construction"].as_bool()), (Some(-5.0), Some(true)));
    assert_eq!(e.tool, Tool::Select);
}

#[test]
fn mirror_across_the_origin_axis_and_a_mirrored_line_leaves_the_objects() {
    let mut e = editor(json!([
        {"id": "c1", "type": "circle", "x": 5, "y": 3, "radius": 1},
        {"id": "l1", "type": "line", "x1": 0, "y1": 8, "x2": 10, "y2": 8}
    ]));
    e.arm(Tool::Mirror);
    e.click(p(5.0, 4.0), PPM);
    e.click(p(5.0, 8.0), PPM);
    e.mirror_key("tab");
    e.click(p(5.0, 8.0), PPM);
    assert_eq!(e.mirror.as_ref().unwrap().objects, ["c1"]);
    assert!(e.notice.take().is_some());
    e.mirror_key("tab");
    e.click(p(30.0, 0.0), PPM);
    assert_eq!(e.modify_preview()[0]["y"], -3.0);
}

#[test]
fn move_needs_a_selection_then_two_clicks() {
    let mut e = editor(json!([{"id": "c1", "type": "circle", "x": 0, "y": 0, "radius": 2}]));
    e.arm(Tool::Move);
    assert!(e.click(p(0.0, 0.0), PPM).is_none());
    assert!(e.notice.take().is_some());
    e.selected = Some("c1".into());
    e.arm(Tool::Move);
    assert_eq!(e.selected.as_deref(), Some("c1"));
    assert!(e.click(p(0.0, 0.0), PPM).is_none());
    assert_eq!(e.prompt(), "Click the destination point");
    assert!(e.click(p(10.0, 6.0), PPM).is_some(), "on the grid");
    assert_eq!((e.entities[0]["x"].as_f64(), e.entities[0]["y"].as_f64()), (Some(10.0), Some(6.0)));
    assert_eq!(e.entities[0]["id"], "c1");
}

#[test]
fn projected_geometry_is_refused() {
    let mut e = editor(json!([
        {"id": "p1", "type": "projected", "source": {"kind": "edge", "body": "b1", "sel": {"kind": "edge", "by": "nearest", "point": [0, 0, 0]}},
            "curve": {"kind": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0}},
        {"id": "l2", "type": "line", "x1": 5, "y1": -5, "x2": 5, "y2": 5}
    ]));
    e.arm(Tool::Trim);
    assert!(e.click(p(2.0, 0.0), PPM).is_none());
    assert_eq!(e.notice.as_deref(), Some("Projected geometry is fixed, Break Link to edit it"));
    assert_eq!(e.entities.len(), 2);
}

#[test]
fn fillet_drops_the_snap_join_at_its_corner_and_keeps_an_untouched_one() {
    let mut e = editor(json!([
        {"id": "a", "type": "line", "x1": 0, "y1": 0, "x2": 20, "y2": 0},
        {"id": "b", "type": "line", "x1": 20, "y1": 0, "x2": 20, "y2": 20},
        {"id": "c", "type": "line", "x1": 0, "y1": 0, "x2": -10, "y2": -10}
    ]));
    e.constraints.push(json!({"type": "coincident", "e1": "b", "p1": 0, "e2": "a", "p2": 1, "snap": true}));
    e.constraints.push(json!({"type": "coincident", "e1": "c", "p1": 0, "e2": "a", "p2": 0, "snap": true}));
    e.resolve(false);
    e.arm(Tool::Fillet);
    e.click(p(10.0, 0.0), PPM);
    e.click(p(20.0, 10.0), PPM);
    e.entry_key("2", Some("2"));
    assert!(e.entry_key("enter", None).is_some());
    let kinds: Vec<&Value> = e.constraints.iter().map(|c| &c["type"]).collect();
    assert_eq!(kinds, ["coincident", "tangent2", "tangent2"]);
    assert_eq!(e.constraints[0]["e1"], "c");
    assert!((e.entities[0]["x2"].as_f64().unwrap() - 18.0).abs() < 1e-6, "the corner is not pulled back together");
    assert!((e.entities[1]["y1"].as_f64().unwrap() - 2.0).abs() < 1e-6);
}

#[test]
fn move_keeps_a_size_held_by_a_parameter() {
    let mut e = editor(json!([{"id": "c1", "type": "circle", "x": 0, "y": 0, "radius": "r"}]));
    e.params.insert("r".into(), 2.0);
    e.resolve(false);
    e.selected = Some("c1".into());
    e.arm(Tool::Move);
    e.click(p(0.0, 0.0), PPM);
    assert!(e.click(p(4.0, 0.0), PPM).is_some());
    assert_eq!(e.entities[0]["radius"], "r");
    assert_eq!(e.entities[0]["x"].as_f64(), Some(4.0));
}
