use fundacad_geom::builder::{py_g, py_g_prec};

#[test]
fn matches_python_general_format() {
    for (v, want) in [
        (0.0, "0"),
        (95.0, "95"),
        (-2.5, "-2.5"),
        (-0.0001, "-0.0001"),
        (0.00001, "1e-05"),
        (1234567.0, "1.23457e+06"),
        (123456.0, "123456"),
        (0.1 + 0.2, "0.3"),
        (1e22, "1e+22"),
        (999999.5, "1e+06"),
    ] {
        assert_eq!(py_g(v), want, "{v}");
    }
}

#[test]
fn matches_python_four_significant_digits() {
    for (v, want) in [(1.38, "1.38"), (2.0, "2"), (12345.0, "1.234e+04"), (9999.5, "1e+04"), (0.123456, "0.1235")] {
        assert_eq!(py_g_prec(v, 4), want, "{v}");
    }
}
