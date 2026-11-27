use super::palette::{Palette, Toggle, TOGGLES};

#[test]
fn the_switches_start_as_fundacad_1_set_them() {
    let p = Palette::default();
    let on: Vec<Option<bool>> = TOGGLES.iter().map(|(t, _)| p.get(*t)).collect();
    let want = [Some(false), None, Some(false), Some(true), Some(true), Some(true), Some(true), Some(true)];
    assert_eq!(on, want);
}

#[test]
fn a_switch_sets_only_itself_and_construction_stays_the_editors() {
    let mut p = Palette::default();
    p.set(Toggle::Snap, false);
    assert_eq!(p, Palette { snap: false, ..Palette::default() });
    p.set(Toggle::Construction, true);
    assert_eq!(p, Palette { snap: false, ..Palette::default() });
}
