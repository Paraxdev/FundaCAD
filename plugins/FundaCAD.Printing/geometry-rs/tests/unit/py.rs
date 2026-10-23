use printing_geometry::py::*;
use serde_json::json;

#[test]
fn formats_like_python() {
    assert_eq!(g(115.0, 6), "115");
    assert_eq!(g(-0.0, 6), "-0");
    assert_eq!(g(0.1 + 0.2, 6), "0.3");
    assert_eq!(g(1234567.0, 6), "1.23457e+06");
    assert_eq!(g(0.00001234, 6), "1.234e-05");
    assert_eq!(g(0.123, 2), "0.12");
    assert_eq!(repr_float(1e16), "1e+16");
    assert_eq!(repr_float(1e15), "1000000000000000.0");
    assert_eq!(repr_float(0.0001), "0.0001");
    assert_eq!(repr_float(0.00001), "1e-05");
    assert_eq!(repr_float(2.5), "2.5");
    assert_eq!(quoteattr("a\"b"), "'a\"b'");
    assert_eq!(quoteattr("a\"b'c<"), "\"a&quot;b'c&lt;\"");
    assert_eq!(int_of(&json!(" 2 ")), Some(2));
    assert_eq!(int_of(&json!(2.9)), Some(2));
    assert_eq!(int_of(&json!("x")), None);
    assert_eq!(str_of(&json!([1, "a", 2.0])), "[1, 'a', 2.0]");
    assert_eq!(
        dumps_indent1(&json!({"a": [1, "é"], "b": {}, "c": []})),
        "{\n \"a\": [\n  1,\n  \"\\u00e9\"\n ],\n \"b\": {},\n \"c\": []\n}"
    );
}
