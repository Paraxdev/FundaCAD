use super::inspector::unchanged;

#[test]
fn the_same_value_typed_again_is_unchanged() {
    assert!(unchanged(Some(1.5), 1.5));
    assert!(unchanged(Some(10.0), 10.0));
    assert!(!unchanged(Some(1.5), 1.25));
    assert!(!unchanged(None, 1.5));
}
