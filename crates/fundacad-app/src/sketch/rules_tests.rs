use glam::DVec2;
use serde_json::json;

use crate::sketch::{add_sketch, escape, Editor, Tool};

fn editor() -> Editor {
    let mut d = json!({"features": []}).as_object().cloned().unwrap();
    add_sketch(&mut d, json!("XY")).unwrap();
    let mut e = Editor::open(&d, "sketch1").unwrap();
    e.entities.push(json!({"id": "l1", "type": "line", "x1": 0, "y1": 0, "x2": 20, "y2": 3}));
    e.entities.push(json!({"id": "l2", "type": "line", "x1": 0, "y1": 10, "x2": 20, "y2": 15}));
    e.resolve(false);
    e
}

fn p(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

#[test]
fn horizontal_applies_to_a_selected_line_and_arms_without_one() {
    let mut e = editor();
    e.selected = Some("l1".into());
    assert!(e.rule_key("horizontal").is_some());
    assert_eq!(e.constraints.last().unwrap(), &json!({"type": "horizontal", "line": "l1"}));
    assert_eq!(e.tool, Tool::Select);
    e.selected = None;
    assert_eq!(e.rule_key("vertical"), None);
    assert_eq!(e.tool, Tool::Constrain("vertical"));
    assert!(e.click(p(10.0, 12.5), 10.0).is_some());
    assert_eq!(e.constraints.last().unwrap(), &json!({"type": "vertical", "line": "l2"}));
}

#[test]
fn parallel_takes_two_picks_and_esc_drops_the_first() {
    let mut e = editor();
    e.rule_key("parallel");
    assert_eq!(e.click(p(10.0, 1.5), 10.0), None);
    assert_eq!(e.first.as_deref(), Some("l1"));
    assert!(e.escape());
    assert_eq!((e.first.as_deref(), e.tool), (None, Tool::Constrain("parallel")));
    e.click(p(10.0, 1.5), 10.0);
    assert_eq!(e.click(p(10.0, 1.5), 10.0), None, "the same line twice adds nothing");
    e.click(p(10.0, 1.5), 10.0);
    assert!(e.click(p(10.0, 12.5), 10.0).is_some());
    assert_eq!(e.constraints.last().unwrap(), &json!({"type": "parallel", "l1": "l1", "l2": "l2"}));
}

#[test]
fn a_selected_line_is_the_first_pick_of_a_pair_tool() {
    let mut e = editor();
    e.selected = Some("l2".into());
    e.rule_key("perpendicular");
    assert_eq!((e.first.as_deref(), e.selected.as_deref()), (Some("l2"), None));
}

#[test]
fn esc_in_the_editor_peels_drag_then_shape_then_selection_then_tool() {
    let mut e = editor();
    let before = e.entities.clone();
    assert!(e.drag_start(p(20.0, 3.0), 1.0));
    e.drag_to(p(30.0, 9.0));
    assert_ne!(e.entities, before);
    e.selected = Some("l1".into());
    assert_eq!(escape::action(e.escape_state()), escape::Action::CancelDrag);
    assert!(e.escape());
    assert_eq!((e.drag.is_none(), &e.entities), (true, &before), "the drag is undone");
    assert_eq!(e.drag_end(), None);
    assert!(e.escape());
    assert_eq!(e.selected, None);
    assert!(!e.escape(), "an idle sketch closes");
    e.set_tool(Tool::Line);
    e.click(p(40.0, 40.0), 10.0);
    assert!(e.escape());
    assert_eq!((e.clicks.len(), e.tool), (0, Tool::Line));
    assert!(e.escape());
    assert_eq!(e.tool, Tool::Select);
    assert!(!e.escape());
}

#[test]
fn every_tool_has_fundacad_1_prompt() {
    let tools = [Tool::Select, Tool::Line, Tool::Rectangle, Tool::Circle, Tool::Arc, Tool::Polygon, Tool::Dimension];
    let rules = super::ONE_LINE.iter().chain(super::TWO_LINES).map(|k| Tool::Constrain(k));
    for t in tools.into_iter().chain(rules) {
        let key = format!("sketch.hint.{}", t.action().unwrap_or("select"));
        assert_ne!(t.prompt(), key, "{key} is missing from en.json");
    }
    assert_eq!(Tool::Line.prompt(), "Click points · length Tab angle · Enter · Esc");
    assert_eq!(Tool::Constrain("parallel").prompt(), "Click two lines · Esc");
    assert_eq!(Tool::Select.prompt(), "Line (L) · Rectangle (R) · Circle (C) · Arc (A) · Trim (T)");
}
