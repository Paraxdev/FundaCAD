use super::*;

#[test]
fn a_wide_window_centres_the_widest_panel_in_the_gap() {
    assert_eq!(place(1920.), (468. + (1080. - 720.) / 2., 720.));
}

#[test]
fn a_mid_window_fills_the_gap_and_clears_the_rail_and_history() {
    let (left, w) = place(1440.);
    assert_eq!((left, w), (468., 600.));
    assert_eq!(1440. - (left + w), RIGHT_CLEAR);
}

#[test]
fn a_gap_of_exactly_the_bounds_keeps_them() {
    assert_eq!(place(468. + 372. + 560.), (468., 560.));
    assert_eq!(place(468. + 372. + 720.), (468., 720.));
}

#[test]
fn the_minimum_window_keeps_the_narrowest_panel_on_screen() {
    let (left, w) = place(1000.);
    assert_eq!((left, w), (468. + 80. - 280., 560.));
    assert!(left >= FLOAT_GAP && left + w <= 1000. - FLOAT_GAP);
}

#[test]
fn a_window_narrower_than_the_panel_shrinks_it_to_the_gutters() {
    assert_eq!(place(500.), (FLOAT_GAP, 500. - 2. * FLOAT_GAP));
    assert_eq!(place(10.), (FLOAT_GAP, 0.));
}
