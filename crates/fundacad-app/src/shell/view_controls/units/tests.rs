use super::*;

#[test]
fn lengths_show_in_the_picked_unit() {
    assert_eq!(fmt_length(10., Unit::Mm), "10 mm");
    assert_eq!(fmt_length(10., Unit::Cm), "1 cm");
    assert_eq!(fmt_length(25.4, Unit::In), "1 in");
    assert_eq!(fmt_length(10., Unit::In), "0.394 in");
    assert_eq!(fmt_length(0.5, Unit::Mm), "0.5 mm");
}

#[test]
fn rounding_follows_fundacad_1() {
    assert_eq!(display_round(1.23456), 1.23);
    assert_eq!(display_round(0.012345), 0.0123);
    assert_eq!(display_round(2.125), 2.125);
}

#[test]
fn the_unit_is_kept() {
    set_unit(Unit::Cm);
    assert_eq!(unit(), Unit::Cm);
    set_unit(Unit::Mm);
    assert_eq!(unit(), Unit::Mm);
}
