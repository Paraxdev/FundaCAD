//! The numbers an `inspect` report prints.
//!
//! `describe.py` leans on two things Python does and Rust does not: `round()`
//! goes to the even neighbour on a tie, and `%g` keeps six significant digits,
//! trims trailing zeros and keeps the sign of a negative zero. Every one of
//! those was a difference between the two servers' reports at some point, and
//! a difference in a measurement is the kind nobody notices.

use fundacad_mcp::describe::{describe, fmt, g_format};
use serde_json::json;

#[test]
fn a_rounded_number_prints_the_way_python_prints_it() {
    let cases: &[(f64, i32, &str)] = &[
        (20.0, 3, "20"),
        (0.5, 0, "0"),   // halves go to the even neighbour
        (1.5, 0, "2"),
        (2.5, 0, "2"),
        (-2.5, 0, "-2"),
        (1.0 / 3.0, 3, "0.333"),
        (1234.5678, 2, "1234.57"),
        (8000.0, 1, "8000"),
        (0.000_012_345, 3, "0"),
        (-0.000_1, 3, "-0"), // a normal of (-1, -0, 0) reads this way
    ];
    for (v, places, want) in cases {
        assert_eq!(fmt(Some(&json!(v)), *places), *want, "{v} to {places}");
    }
    assert_eq!(fmt(None, 3), "?");
    assert_eq!(fmt(Some(&json!(null)), 3), "?");
    assert_eq!(fmt(Some(&json!([1.0, -0.0, 0.25])), 3), "1, -0, 0.25");
}

#[test]
fn six_significant_digits_and_no_trailing_zeros() {
    assert_eq!(g_format(9424.777_960_769_38), "9424.78");
    assert_eq!(g_format(8000.0), "8000");
    assert_eq!(g_format(0.000_012_345_6), "1.23456e-05");
    assert_eq!(g_format(1_234_567.0), "1.23457e+06");
    assert_eq!(g_format(-0.0), "-0");
    assert_eq!(g_format(0.0), "0");
}

#[test]
fn a_body_reads_as_one_line_and_its_traps_as_warnings() {
    let report = json!({"bodies": [{
        "id": "body1", "name": "Spool", "solidCount": 2,
        "bbox": {"size": [20.0, 20.0, 30.0]}, "volume": 9424.777_960_769_38,
        "faceCount": 3, "edgeCount": 3,
        "faces": [{"i": 0, "surface": "cylinder", "area": 1884.95, "radius": 10.0,
                   "point": [0.0, 0.0, 0.0], "normal": [1.0, -0.0, 0.0], "wraps": true},
                  {"i": 1, "surface": "plane", "area": 314.159,
                   "normal": [0.0, 0.0, 1.0]}],
        "edges": [{"i": 0, "curve": "line", "length": 30.0, "mid": [10.0, 0.0, 0.0],
                   "faces": [0], "seam": true, "openBoundary": true}]
    }], "errors": [{"feature_id": "fil1", "message": "the blend was refused"}]});

    let summary = describe(&report, false);
    assert!(
        summary.starts_with(
            "body1 \"Spool\" | 20 x 20 x 30 mm | vol 9424.8 mm3 | 3 faces, 3 edges | \
             2 disjoint solids | 1 cylinder, 1 plane"
        ),
        "{summary}"
    );
    assert!(summary.contains("! 1 seam edge(s) (E0)"), "{summary}");
    assert!(summary.contains("! 1 face(s) wrap all the way round (F0)"), "{summary}");
    assert!(summary.contains("! 1 edge(s) bound only ONE face"), "{summary}");
    assert!(summary.contains("this body is 2 solids that do not touch"), "{summary}");
    assert!(
        summary.contains("ERROR (feature fil1): the blend was refused"),
        "{summary}"
    );
    assert!(!summary.contains("  faces:"), "a summary lists no faces");

    let detail = describe(&report, true);
    assert!(
        detail.contains("  F0 cylinder | area 1884.95 | r 10 | at (0, 0, 0) | normal (1, -0, 0) | WRAPS"),
        "{detail}"
    );
    assert!(
        detail.contains("  E0 line | len 30 | mid (10, 0, 0) | between F0 | SEAM | OPEN"),
        "{detail}"
    );
}

#[test]
fn nothing_built_says_so() {
    assert_eq!(
        describe(&json!({"bodies": []}), true),
        "No bodies. The document built nothing."
    );
}
