//! FundaCAD 1's tests/params/decimalForm.test.ts.

use super::decimal::*;

#[test]
fn commas_to_points_swaps_a_decimal_comma_and_keeps_the_length() {
    let cases = [
        ("12,375", "12.375"),
        ("-0,35", "-0.35"),
        (",5", ".5"),
        ("1,500", "1.500"),
        ("width*1,5", "width*1.5"),
        ("max(1,5;2,25)", "max(1.5;2.25)"),
        ("2,5mm", "2.5mm"),
        ("1,5e3", "1.5e3"),
        ("10x2,5", "10x2.5"),
        ("1,5X2,25 mm", "1.5X2.25 mm"),
        ("(1,5+2)x3,5", "(1.5+2)x3.5"),
        ("10x,5", "10x.5"),
        ("10x.5", "10x.5"),
        ("12.5", "12.5"),
        ("", ""),
    ];
    for (typed, read) in cases {
        assert_eq!(commas_to_points(typed).unwrap(), read, "{typed}");
        assert_eq!(read.len(), typed.len());
    }
}

#[test]
fn commas_after_a_name_or_bracket_stay_for_the_reader_to_refuse() {
    for typed in ["w2,5", "a,5", "(2),5", "1, 5", "w,", "3,", "max(w,5)", "a_1,25", "x2,5", "ax2,5", "w2x,5", "10x,"] {
        assert_eq!(commas_to_points(typed).unwrap(), typed);
    }
    assert_eq!(commas_to_points("1,5,5").unwrap(), "1.5.5");
    assert_eq!(commas_to_points("1.234,5").unwrap(), "1.234.5");
}

#[test]
fn a_point_before_three_digits_could_be_a_thousands_point() {
    let refused = [
        ("1.500", "1.500", 0),
        ("12.000", "12.000", 0),
        ("-1.500", "1.500", 1),
        ("01.500", "01.500", 0),
        ("breite * 1.500", "1.500", 9),
        ("2.500mm", "2.500", 0),
        ("10x1.500", "1.500", 3),
        ("max(1,5; 2.125)", "2.125", 9),
    ];
    for (typed, number, at) in refused {
        let e = commas_to_points(typed).unwrap_err();
        assert_eq!(e, Ambiguous { number: number.into(), at }, "{typed}");
        assert_eq!(e.to_string(), format!("\"{number}\" is ambiguous, write a comma for decimals or leave the point out"));
    }
    for typed in ["1.50", "1.5000", "1.500e3", "0.250", "-0.250", "00.250", ".500", "breite * 0.250"] {
        assert_eq!(commas_to_points(typed).unwrap(), typed);
    }
}

#[test]
fn points_to_commas_shows_the_stored_form_with_a_decimal_comma() {
    let cases = [
        ("width*1.5", "width*1,5"),
        ("max(1.5;2.25)", "max(1,5;2,25)"),
        ("2.5mm", "2,5mm"),
        ("1e-7", "1e-7"),
        ("1.5e+21", "1,5e+21"),
        ("2.75E3 + .5", "2,75E3 + ,5"),
        ("a - 12.375 / b_1 - 0.25", "a - 12,375 / b_1 - 0,25"),
        ("5. + 5.e3 + 5.25", "5. + 5.e3 + 5,25"),
        ("22.125°", "22,125°"),
        ("10x2.500", "10x2,500"),
        ("1,5", "1,5"),
        ("a.b", "a.b"),
        ("x.5", "x.5"),
        ("", ""),
    ];
    for (stored, shown) in cases {
        assert_eq!(points_to_commas(stored), shown, "{stored}");
    }
    for stored in ["22.125°", "10x2.500", "10x.5 + 1.500°", "a = 1.5", "1.5.5"] {
        assert_eq!(commas_to_points(&points_to_commas(stored)).unwrap(), stored);
    }
}

#[test]
fn a_point_language_passes_text_through() {
    assert_eq!(read_typed("1,5", '.').unwrap(), "1,5");
    assert_eq!(show_stored("1.5", '.'), "1.5");
    assert_eq!(read_typed("1,5", ',').unwrap(), "1.5");
    assert_eq!(show_stored("1.5", ','), "1,5");
}
