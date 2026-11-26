use super::languages::match_system_language;
use super::multi_sz_tags;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

#[test]
fn windows_list_splits_into_tags() {
    assert_eq!(multi_sz_tags(&wide("de-DE\0en-US\0\0")), ["de-DE", "en-US"]);
    assert!(multi_sz_tags(&wide("\0\0")).is_empty());
    assert!(multi_sz_tags(&[]).is_empty());
}

#[test]
fn windows_tags_pick_a_language_that_follows_the_system() {
    let tags = multi_sz_tags(&wide("de-DE\0fr-FR\0\0"));
    assert_eq!(match_system_language(&tags, &["en"]), "en");
    assert_eq!(match_system_language(&tags, &["en", "fr"]), "fr");
    assert_eq!(match_system_language(&tags, &["en", "de", "fr"]), "de");
}
