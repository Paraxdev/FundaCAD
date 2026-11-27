use gpui::{point, px, MouseButton, Pixels, Point};

use super::{pick, slot, Outcome, RadialItem, Ring, Trigger, DEADZONE, RADIUS, SUBMENU};
use crate::overlay::MenuItem;

fn item(label: &str) -> RadialItem {
    RadialItem::new(MenuItem::call(label.to_string(), |_, _| {}), None)
}

fn items(n: usize) -> Vec<RadialItem> {
    (0..n).map(|i| item(&format!("i{i}"))).collect()
}

fn at(x: f32, y: f32) -> Point<Pixels> {
    point(px(x), px(y))
}

const C: (f32, f32) = (400., 300.);

fn centre() -> Point<Pixels> {
    at(C.0, C.1)
}

fn off(dx: f32, dy: f32) -> Point<Pixels> {
    at(C.0 + dx, C.1 + dy)
}

fn right() -> Option<Trigger> {
    Some(Trigger::Button(MouseButton::Right))
}

#[test]
fn the_dead_zone_picks_nothing() {
    assert_eq!(pick(8, 0., 0.), None);
    assert_eq!(pick(8, DEADZONE - 1., 0.), None);
    assert_eq!(pick(0, 100., 0.), None);
}

#[test]
fn item_zero_is_up_and_the_rest_go_clockwise() {
    assert_eq!(pick(4, 0., -50.), Some(0));
    assert_eq!(pick(4, 50., 0.), Some(1));
    assert_eq!(pick(4, 0., 50.), Some(2));
    assert_eq!(pick(4, -50., 0.), Some(3));
    // Just left of straight up rounds back to item 0, not to the last.
    assert_eq!(pick(8, -5., -50.), Some(0));
    assert_eq!(pick(8, 40., -40.), Some(1));
}

#[test]
fn a_slot_sits_where_its_pick_points() {
    for n in [1, 3, 5, 8] {
        for i in 0..n {
            let (x, y) = slot(i, n, RADIUS);
            assert!((x.hypot(y) - RADIUS).abs() < 1e-3);
            assert_eq!(pick(n, x, y), Some(i), "slot {i} of {n}");
        }
    }
    let (x, y) = slot(0, 4, RADIUS);
    assert!(x.abs() < 1e-4 && (y + RADIUS).abs() < 1e-4);
}

#[test]
fn a_held_drag_released_on_an_item_runs_it() {
    let mut r = Ring::new(centre(), items(4), right());
    assert!(r.moved(off(60., 0.)));
    assert_eq!(r.hot, Some(1));
    assert!(!r.moved(off(61., 1.)));
    assert_eq!(r.release(off(60., 0.)), Outcome::Run(1));
}

#[test]
fn a_flick_picks_by_where_it_was_let_go() {
    let mut r = Ring::new(centre(), items(4), right());
    assert_eq!(r.release(off(0., 70.)), Outcome::Run(2));
}

#[test]
fn a_drag_let_go_in_the_middle_closes() {
    let mut r = Ring::new(centre(), items(4), right());
    r.moved(off(60., 0.));
    assert_eq!(r.release(off(3., 2.)), Outcome::Close);
}

#[test]
fn a_tapped_key_leaves_the_ring_up_to_click() {
    let mut r = Ring::new(centre(), items(4), Some(Trigger::Key("w".into())));
    assert_eq!(r.release(centre()), Outcome::Stay);
    assert_eq!(r.gesture, None);
    assert_eq!(r.click(off(-50., 0.)), Outcome::Run(3));
}

#[test]
fn a_click_while_held_does_nothing_and_a_click_in_the_middle_closes() {
    let mut r = Ring::new(centre(), items(4), right());
    assert_eq!(r.click(off(60., 0.)), Outcome::Stay);
    let mut r = Ring::new(centre(), items(4), None);
    assert_eq!(r.release(off(60., 0.)), Outcome::Stay);
    assert_eq!(r.click(centre()), Outcome::Close);
}

#[test]
fn a_disabled_item_is_lit_but_never_runs() {
    let mut list = items(2);
    list[1].item.disabled = true;
    let mut r = Ring::new(centre(), list, right());
    r.moved(off(0., 60.));
    assert_eq!(r.hot, Some(1));
    assert_eq!(r.release(off(0., 60.)), Outcome::Stay);
}

#[test]
fn dragging_out_past_a_group_opens_its_ring_there() {
    let mut list = items(2);
    list[1] = RadialItem::group("More", None, items(3));
    let mut r = Ring::new(centre(), list, right());
    r.moved(off(0., 60.));
    assert_eq!((r.items.len(), r.depth), (2, 0));
    r.moved(off(0., SUBMENU + 1.));
    assert_eq!((r.items.len(), r.depth, r.hot), (3, 1, None));
    assert_eq!(r.at, off(0., SUBMENU + 1.));
    assert!(r.gesture.is_some());
    // The new ring is centred on the pointer, so a move from there picks in it.
    let c = r.at;
    r.moved(point(c.x + px(60.), c.y));
    assert_eq!(r.hot, Some(1));
}

#[test]
fn clicking_a_group_opens_its_ring_for_clicks() {
    let mut list = items(2);
    list[0] = RadialItem::group("More", None, items(3));
    let mut r = Ring::new(centre(), list, None);
    assert_eq!(r.click(off(0., -60.)), Outcome::Stay);
    assert_eq!((r.items.len(), r.gesture.clone()), (3, None));
}

#[test]
fn only_the_trigger_that_opened_it_releases_it() {
    let r = Ring::new(centre(), items(2), Some(Trigger::Key("w".into())));
    assert!(r.held_by(&Trigger::Key("w".into())));
    assert!(!r.held_by(&Trigger::Key("q".into())));
    assert!(!r.held_by(&Trigger::Button(MouseButton::Right)));
}

#[test]
fn losing_the_window_focus_closes_the_ring_and_runs_nothing() {
    use std::cell::Cell;
    use std::rc::Rc;

    use gpui::TestAppContext;

    let mut app = TestAppContext::single();
    let (cx, _overlay) = crate::overlay::test_window(&mut app);
    let ran = Rc::new(Cell::new(false));
    let r = ran.clone();
    let _blur = cx.update(|window, cx| {
        window.activate_window();
        super::close_on_blur(window, cx)
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        let pick = RadialItem::new(MenuItem::call("pick".to_string(), move |_, _| r.set(true)), None);
        super::open_radial(window, cx, centre(), vec![pick], Some(Trigger::Key("w".into())));
    });
    assert!(cx.update(|_, cx| super::radial_open(cx)));
    cx.deactivate_window();
    assert!(!cx.update(|_, cx| super::radial_open(cx)));
    assert!(!ran.get());
}
