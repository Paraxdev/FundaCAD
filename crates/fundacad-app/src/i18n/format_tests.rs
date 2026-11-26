use super::format::*;

fn render(src: &str, args: &Args, locale: &str) -> String {
    format(&parse(src).unwrap(), args, locale, locale)
}

#[test]
fn arguments_numbers_and_missing_values() {
    assert_eq!(render("Hello {name}", &[("name", "Ada".into())], "en"), "Hello Ada");
    assert_eq!(render("Hello {name}", &[], "en"), "Hello {name}");
    assert_eq!(render("{n, number} mm", &[("n", 1234.5678.into())], "en"), "1234.568 mm");
    assert_eq!(render("{n, number} mm", &[("n", 1234.5678.into())], "de"), "1234,568 mm");
    assert_eq!(render("{n, number}", &[("n", 2.0.into())], "fr"), "2");
    assert_eq!(render("{n, number}", &[("n", (-0.0001).into())], "en"), "0");
}

#[test]
fn plural_picks_exact_then_category_then_other() {
    let src = "{n, plural, =0 {none} one {# item} other {# items}}";
    assert_eq!(render(src, &[("n", 0.into())], "en"), "none");
    assert_eq!(render(src, &[("n", 1.into())], "en"), "1 item");
    assert_eq!(render(src, &[("n", 1.5.into())], "de"), "1,5 items");
    assert_eq!(render(src, &[], "en"), "none");
    assert_eq!(plural_category(1., "ja"), "other");
    assert_eq!(plural_category(1.5, "fr"), "one");
    assert_eq!(plural_category(1_000_000., "es"), "many");
    assert_eq!(plural_category(22., "ru"), "few");
}

#[test]
fn select_falls_to_other_and_nests() {
    let src = "{kind, select, face {a face} other {{n, plural, one {# thing} other {# things}}}}";
    assert_eq!(render(src, &[("kind", "face".into())], "en"), "a face");
    assert_eq!(render(src, &[("kind", "edge".into()), ("n", 2.into())], "en"), "2 things");
}

#[test]
fn quotes_follow_icu_only_before_syntax() {
    assert_eq!(render("l'appui", &[], "fr"), "l'appui");
    assert_eq!(render("it''s '{literal}'", &[], "en"), "it's {literal}");
    assert_eq!(render("{n, plural, other {'#' is #}}", &[("n", 3.into())], "en"), "# is 3");
}

#[test]
fn bad_syntax_is_refused() {
    for src in ["{", "}", "{n, plural, on {x} other {y}}", "{n, select, a {x}}", "{n, date}", "'{unclosed"] {
        assert!(parse(src).is_err(), "{src}");
    }
}
