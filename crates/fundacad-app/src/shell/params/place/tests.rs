use super::*;

const H: f32 = 1000.;

#[test]
fn a_wide_window_centres_the_widest_panel_in_the_gap() {
    assert_eq!(place(1920., H, 0., None), (468. + (1080. - 720.) / 2., FLOAT_GAP, 720.));
}

#[test]
fn a_mid_window_fills_the_gap_and_clears_the_rail_and_history() {
    let (left, top, w) = place(1440., H, 0., None);
    assert_eq!((left, top, w), (468., FLOAT_GAP, 600.));
    assert_eq!(1440. - (left + w), RIGHT_CLEAR);
}

#[test]
fn a_gap_of_exactly_the_bounds_keeps_them() {
    assert_eq!(place(468. + 372. + 560., H, 0., None), (468., FLOAT_GAP, 560.));
    assert_eq!(place(468. + 372. + 720., H, 0., None), (468., FLOAT_GAP, 720.));
}

#[test]
fn a_gap_under_the_minimum_caps_the_panel_to_it() {
    assert_eq!(place(1100., H, 0., None), (468., FLOAT_GAP, 260.));
}

#[test]
fn the_least_width_holds_in_the_minimum_window_and_stays_on_screen() {
    let (left, _, w) = place(1000., H, 0., None);
    assert_eq!(w, LEAST_W);
    assert_eq!(left + w / 2., 468. + 80.);
    let (left, _, w) = place(300., H, 0., None);
    assert!(left >= FLOAT_GAP && left + w <= 300. - FLOAT_GAP);
}

#[test]
fn a_wide_window_keeps_the_panel_beside_the_inspect_card() {
    let (left, top, w) = place(1920., H, 300., Some(200.));
    assert_eq!((top, w), (FLOAT_GAP, 720.));
    assert!(left + w <= 1920. - RIGHT_CLEAR - 300. - FLOAT_GAP);
}

#[test]
fn too_little_room_beside_the_card_takes_the_shelf_under_it() {
    assert_eq!(place(1440., H, 300., Some(200.)), (468., 2. * FLOAT_GAP + 200., 600.));
    let (left, top, w) = place(1100., H, card_w(1100.), Some(150.));
    assert_eq!((left, top, w), (468., 2. * FLOAT_GAP + 150., 260.));
}

#[test]
fn an_unpainted_card_caps_the_panel_beside_it() {
    let (left, top, w) = place(1440., H, 300., None);
    assert_eq!((top, w), (FLOAT_GAP, 288.));
    assert_eq!(left, 468.);
}

#[test]
fn the_card_shrinks_to_clear_the_rail_labels_down_to_its_least() {
    assert_eq!(card_w(1440.), CARD_W);
    assert_eq!(card_w(1100.), 1100. - LEFT_CLEAR - RIGHT_CLEAR);
    assert_eq!(card_w(1000.), CARD_LEAST);
}

#[test]
fn a_shelf_too_short_for_the_panel_keeps_it_beside_the_card() {
    let (_, top, w) = place(1000., 554., card_w(1000.), Some(450.));
    assert_eq!((top, w), (FLOAT_GAP, LEAST_W));
    let (_, top, _) = place(1000., 554., card_w(1000.), Some(200.));
    assert_eq!(top, 2. * FLOAT_GAP + 200.);
}
