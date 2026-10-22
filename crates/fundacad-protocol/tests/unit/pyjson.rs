use fundacad_protocol::pyjson::*;
use serde_json::json;

fn f(x: f64) -> String {
    let mut s = String::new();
    write_float(&mut s, x);
    s
}

#[test]
fn floats_match_python_repr() {
    assert_eq!(f(0.0), "0.0");
    assert_eq!(f(-0.0), "-0.0");
    assert_eq!(f(1.0), "1.0");
    assert_eq!(f(0.1), "0.1");
    assert_eq!(f(0.0001), "0.0001");
    assert_eq!(f(0.00001), "1e-05");
    assert_eq!(f(1.5e-7), "1.5e-07");
    assert_eq!(f(1e16), "1e+16");
    assert_eq!(f(1234567890123456.0), "1234567890123456.0");
    assert_eq!(f(1.25e300), "1.25e+300");
    assert_eq!(f(-123.456), "-123.456");
    assert_eq!(f(100.0), "100.0");
    assert_eq!(f(f64::INFINITY), "Infinity");
}

#[test]
fn strings_are_ascii_escaped() {
    let mut s = String::new();
    write_str(&mut s, "a\"b\\c\n\u{1}\u{7f}\u{e9}\u{201c}\u{1f600}");
    let bs = char::from(92u8);
    let want = format!("\"a{bs}\"b{bs}{bs}c{bs}n{bs}u0001{bs}u007f{bs}u00e9{bs}u201c{bs}ud83d{bs}ude00\"");
    assert_eq!(s, want);
}

#[test]
fn containers_use_python_separators() {
    let v = json!({"id": "x", "ok": true, "a": [1, -2, 2.5], "e": {}, "l": [], "n": null});
    assert_eq!(to_string(&v), r#"{"id": "x", "ok": true, "a": [1, -2, 2.5], "e": {}, "l": [], "n": null}"#);
}

#[test]
fn truthiness() {
    assert!(!truthy(None));
    assert!(!truthy(Some(&json!(0))));
    assert!(!truthy(Some(&json!(""))));
    assert!(truthy(Some(&json!(1))));
    assert!(truthy(Some(&json!(true))));
}
