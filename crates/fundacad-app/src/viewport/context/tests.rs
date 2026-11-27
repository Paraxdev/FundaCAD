use gpui::{point, px};

use super::{target_of, CanvasTarget, RightPress};
use crate::selection::Pick;

fn face() -> Pick {
    Pick::Face { body: "b1".into(), face: 3, point: [0.0; 3], normal: [0.0, 0.0, 1.0] }
}

#[test]
fn a_still_press_is_a_click() {
    let mut r = RightPress::default();
    r.down(point(px(10.), px(10.)));
    r.moved(point(px(11.), px(10.)));
    assert_eq!(r.up(point(px(11.), px(11.))), Some(point(px(11.), px(11.))));
}

#[test]
fn a_drag_is_no_click_even_when_it_comes_back() {
    let mut r = RightPress::default();
    r.down(point(px(10.), px(10.)));
    r.moved(point(px(60.), px(10.)));
    assert_eq!(r.up(point(px(10.), px(10.))), None);
}

#[test]
fn a_release_without_a_press_here_is_no_click() {
    let mut r = RightPress::default();
    assert_eq!(r.up(point(px(10.), px(10.))), None);
}

#[test]
fn a_plane_in_front_wins_over_the_model() {
    let plane = Some(Pick::Plane { id: "XY".into() });
    assert_eq!(target_of(plane, Some(face())), CanvasTarget::Plane("XY".into()));
}

#[test]
fn the_target_follows_the_pick() {
    assert_eq!(target_of(None, Some(Pick::Body { body: "b1".into() })), CanvasTarget::Body("b1".into()));
    assert_eq!(target_of(None, Some(face())), CanvasTarget::Face(face()));
    assert_eq!(target_of(None, None), CanvasTarget::Empty);
}
