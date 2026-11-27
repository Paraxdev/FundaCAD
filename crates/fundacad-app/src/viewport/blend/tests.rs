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
