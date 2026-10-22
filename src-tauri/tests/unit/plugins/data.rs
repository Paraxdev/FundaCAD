use fundacad_lib::plugins::data::safe_name;

#[test]
fn names_cannot_leave_their_directory() {
    assert!(safe_name("devices.json").is_ok());
    assert!(safe_name("part_1-a.3mf").is_ok());
    for bad in ["", "../x", "a/b", "a\\b", ".hidden", "..", "c:x", &"x".repeat(101)] {
        assert!(safe_name(bad).is_err(), "{bad:?}");
    }
}
