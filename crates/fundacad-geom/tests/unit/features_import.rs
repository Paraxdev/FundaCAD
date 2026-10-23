use fundacad_geom::features::import::*;

#[test]
fn base64_round_trips_and_refuses_junk() {
    assert_eq!(base64_decode("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
    assert_eq!(base64_decode("aGVs\nbG8h").as_deref(), Some(&b"hello!"[..]));
    assert!(base64_decode("a$b=").is_none());
}
