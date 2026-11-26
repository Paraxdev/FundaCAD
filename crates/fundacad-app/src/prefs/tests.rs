use super::{as_size, step, theme_from, Background};
use crate::theme::Contrast;

#[test]
fn a_stored_size_snaps_to_a_step_and_steps_stop_at_the_ends() {
    assert_eq!([as_size(None), as_size(Some(f64::NAN)), as_size(Some(127.)), as_size(Some(10.))], [100, 100, 125, 80]);
    assert_eq!(as_size(Some(900.)), 200);
    assert_eq!([step(100, true), step(100, false), step(200, true), step(80, false)], [110, 90, 200, 80]);
    assert_eq!(step(127, true), 150);
}

#[test]
fn theme_settings_read_back_with_garbage_at_the_defaults() {
    let s = theme_from(Some("light".into()), Some("maximum"), Some("off"), Some(true));
    assert_eq!((s.choice.as_str(), s.contrast, s.motion, s.large_targets), ("light", Contrast::Maximum, false, true));
    assert_eq!(theme_from(Some(String::new()), Some("loud"), Some("??"), None), crate::theme::Settings::default());
}

#[test]
fn backgrounds_parse_by_id_and_the_theme_one_has_no_colour() {
    assert_eq!(Background::parse(Some("grey")), Background::Grey);
    assert_eq!(Background::parse(Some("pink")), Background::Theme);
    assert_eq!((Background::Theme.rgb(), Background::Light.rgb()), (None, Some([0xd8, 0xdb, 0xe0])));
}
