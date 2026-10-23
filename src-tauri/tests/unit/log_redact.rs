// Kept out of log_file.rs, which CI also builds alone with rustc and so has no serde_json.
use crate::log_file::log_file::redact_user_paths;

#[test]
fn user_names_are_hidden_the_way_the_shared_cases_say() {
    let cases: Vec<(String, String)> =
        serde_json::from_str(include_str!("../../../tests/fixtures/redact_cases.json")).unwrap();
    assert!(cases.len() > 10);
    for (text, want) in cases {
        assert_eq!(redact_user_paths(&text), want, "{text}");
    }
}
