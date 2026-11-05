use super::*;

const DAEMON_HINT: &str = "start spacenavd (sudo systemctl enable --now spacenavd) or install the udev rule";

#[test]
fn the_flatpak_hint_wins_over_the_daemon_hint() {
    assert_eq!(blocked_hint(true, Some(DAEMON_HINT)), Some(FLATPAK_HINT));
    assert_eq!(blocked_hint(true, None), Some(FLATPAK_HINT));
}

#[test]
fn outside_the_flatpak_the_daemon_hint_stays() {
    assert_eq!(blocked_hint(false, Some(DAEMON_HINT)), Some(DAEMON_HINT));
    assert_eq!(blocked_hint(false, None), None);
}

#[test]
fn the_flatpak_hint_names_spacenavd_and_the_override() {
    assert!(FLATPAK_HINT.contains("spacenavd"));
    assert!(FLATPAK_HINT.contains("flatpak override --user --device=all dev.fundacad.app"));
}
