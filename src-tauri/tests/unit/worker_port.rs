use fundacad_lib::engine::announced_port;

fn ports(lines: &[&str]) -> Vec<u16> {
    let mut announced = false;
    lines.iter().filter_map(|l| announced_port(&mut announced, l)).collect()
}

#[test]
fn the_first_listening_line_names_the_port() {
    assert_eq!(ports(&["kernel banner", "LISTENING 40123", "[plugin-geometry] ready"]), vec![40123]);
}

#[test]
fn a_later_listening_line_never_moves_the_port() {
    assert_eq!(ports(&["LISTENING 40123", "feature a", "LISTENING 40000", "b failed: TypeError"]), vec![40123]);
}

#[test]
fn only_the_exact_form_counts() {
    for line in [
        "LISTENING  40123",
        "LISTENING 40123 ",
        "LISTENING +40123",
        "LISTENING 0",
        "LISTENING 70000",
        "LISTENING",
        "LISTENING 4o123",
    ] {
        assert_eq!(ports(&[line]), Vec::<u16>::new(), "{line:?}");
    }
}

#[test]
fn a_malformed_first_announcement_still_closes_the_door_to_later_ones() {
    assert_eq!(ports(&["LISTENING  40123", "LISTENING 40000"]), Vec::<u16>::new());
}
