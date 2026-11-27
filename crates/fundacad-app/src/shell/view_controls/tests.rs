use std::time::{Duration, Instant};

use super::{Pop, State};

#[test]
fn a_button_opens_its_popover_and_closes_it_again() {
    let mut s = State::default();
    let now = Instant::now();
    s.toggle(Pop::Snap, now);
    assert!(s.is_open(Pop::Snap));
    s.toggle(Pop::Views, now);
    assert!(s.is_open(Pop::Views) && !s.is_open(Pop::Snap), "one popover at a time");
    s.toggle(Pop::Views, now);
    assert!(!s.is_open(Pop::Views));
}

#[test]
fn the_press_that_closed_a_popover_does_not_reopen_it_on_its_own_button() {
    let mut s = State::default();
    let now = Instant::now();
    s.toggle(Pop::Display, now);
    s.close_outside(now);
    s.toggle(Pop::Display, now + Duration::from_millis(80));
    assert!(!s.is_open(Pop::Display));
}

#[test]
fn another_button_still_opens_after_a_press_outside() {
    let mut s = State::default();
    let now = Instant::now();
    s.toggle(Pop::Display, now);
    s.close_outside(now);
    s.toggle(Pop::Grid, now + Duration::from_millis(80));
    assert!(s.is_open(Pop::Grid));
}

#[test]
fn a_late_click_on_the_same_button_opens_it() {
    let mut s = State::default();
    let now = Instant::now();
    s.toggle(Pop::Snap, now);
    s.close_outside(now);
    s.toggle(Pop::Snap, now + Duration::from_secs(2));
    assert!(s.is_open(Pop::Snap));
}
