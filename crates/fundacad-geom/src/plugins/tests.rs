use super::*;

#[test]
fn a_pass_key_carries_minus_one_for_an_unknown_pass() {
    let specs = vec![json!({"pass": "nobody-has-this", "depth": 1})];
    let key = pass_cache_key(&specs).expect("a key");
    assert!(key.starts_with("{\"nobody-has-this\":-1}:"), "{key}");
    assert!(pass_cache_key(&[]).is_none());
}
