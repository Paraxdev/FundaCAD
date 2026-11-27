use glam::Vec3;
use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext};
use serde_json::json;

use super::{Ask, Target};
use crate::overlay::{asking, press, test_window};
use crate::viewport::Viewport;

fn target(n: usize) -> Target {
    Target { edges: vec![json!({"type": "edge"}); n], anchor: Vec3::ZERO, tangent: None }
}

fn ask(cx: &mut VisualTestContext, ask: Ask) -> Entity<Viewport> {
    let v = cx.update(|_, cx| cx.new(|_| Viewport::new()));
    cx.update(|w, cx| {
        v.update(cx, |v, cx| {
            v.blend_ask = Some(ask);
            v.blend_ask(w, cx);
        })
    });
    v
}

#[test]
fn past_the_cap_the_question_only_says_why() {
    let mut app = TestAppContext::single();
    let (cx, _overlay) = test_window(&mut app);
    let v = ask(cx, Ask::TooMany(6000));
    let (question, choices) = cx.update(|_, cx| asking(cx)).expect("asked");
    assert!(question.contains("Too many edges"), "{question}");
    assert_eq!(choices, vec!["OK"]);
    assert!(cx.update(|_, cx| v.read(cx).blend_ask.is_none()));
}

#[test]
fn between_warn_and_cap_it_asks_and_cancel_starts_nothing() {
    let mut app = TestAppContext::single();
    let (cx, _overlay) = test_window(&mut app);
    let v = ask(cx, Ask::Many(target(4000), Default::default()));
    let (question, choices) = cx.update(|_, cx| asking(cx)).expect("asked");
    assert!(question.contains("4") && question.ends_with('?'), "{question}");
    assert_eq!(choices.len(), 2);
    assert_eq!(choices[0], "Cancel");
    cx.update(|w, cx| press(w, cx, "escape"));
    cx.run_until_parked();
    assert_eq!(cx.update(|_, cx| asking(cx)), None);
    assert!(cx.update(|_, cx| v.read(cx).blend.is_none()));
}

#[test]
fn a_yes_without_a_document_starts_nothing() {
    let mut app = TestAppContext::single();
    let (cx, _overlay) = test_window(&mut app);
    let v = ask(cx, Ask::Many(target(3500), Default::default()));
    cx.update(|w, cx| press(w, cx, "right"));
    cx.update(|w, cx| press(w, cx, "enter"));
    cx.run_until_parked();
    assert_eq!(cx.update(|_, cx| asking(cx)), None);
    assert!(cx.update(|_, cx| v.read(cx).blend.is_none()));
}

#[test]
fn a_click_away_without_a_blend_does_nothing() {
    let mut app = TestAppContext::single();
    let (cx, _overlay) = test_window(&mut app);
    let v = cx.update(|_, cx| cx.new(|_| Viewport::new()));
    cx.update(|_, cx| v.update(cx, |v, cx| v.blend_away(cx)));
    assert!(cx.update(|_, cx| v.read(cx).blend.is_none()));
}

#[test]
fn an_edit_builds_up_to_the_blend_or_just_before_it() {
    let doc: crate::tools::Doc = serde_json::from_value(json!({"features": [{"id": "a"}, {"id": "b"}, {"id": "c"}]})).unwrap();
    assert_eq!(super::rolled_back(doc.clone(), 1, false)["rollback"], json!(1));
    assert_eq!(super::rolled_back(doc.clone(), 1, true)["rollback"], json!(2));
    assert!(super::rolled_back(doc, 2, true).get("rollback").is_none());
}

#[test]
fn only_a_plain_size_on_pointed_edges_opens_for_a_drag() {
    let edge = json!({"kind": "edge", "body": "b1", "point": [0.0, 1.0, 2.0]});
    assert_eq!(super::edit_refusal(&json!({"type": "fillet", "radius": 2.0, "edges": [edge.clone()]})), None);
    assert_eq!(super::edit_refusal(&json!({"type": "chamfer", "distance": 1, "edges": edge.clone()})), None);
    assert!(super::edit_refusal(&json!({"type": "fillet", "radius": "r * 2", "edges": [edge]})).is_some());
    assert!(super::edit_refusal(&json!({"type": "fillet", "radius": 2.0, "edges": [{"kind": "edge", "index": 3}]})).is_some());
    assert!(super::edit_refusal(&json!({"type": "fillet", "radius": 2.0})).is_some());
    let matched = json!({"kind": "edge", "by": "match", "fp": {"mid": [5, 0, 55]}, "body": "body1"});
    assert_eq!(super::edit_refusal(&json!({"type": "fillet", "radius": 4, "edges": matched})), None);
}

#[test]
fn a_bound_size_writes_its_parameter_and_an_expression_refuses() {
    let target = |f: &str| json!({"kind": "feature", "feature": f, "field": "radius"});
    let doc: crate::tools::Doc = serde_json::from_value(json!({
        "parameters": {"r": 4, "d2": 4, "d3": 8, "d4": 3},
        "paramDefs": {
            "r": {"expr": "4", "value": 4},
            "d2": {"expr": "r", "value": 4, "target": target("a")},
            "d3": {"expr": "r * 2", "value": 8, "target": target("b")},
            "d4": {"expr": "3", "value": 3, "target": target("c")}
        }
    }))
    .unwrap();
    assert_eq!(super::bound_param(&doc, "a", "radius"), Ok(Some("r".into())));
    assert!(super::bound_param(&doc, "b", "radius").is_err());
    assert_eq!(super::bound_param(&doc, "c", "radius"), Ok(Some("d4".into())));
    assert_eq!(super::bound_param(&doc, "z", "radius"), Ok(None));
}
