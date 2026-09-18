//! The plugin kernel's delaunay-planar against scipy.spatial.Delaunay on the
//! same points (tests/qhull/cases.json, written by tests/qhull/make_cases.py on the legacy branch):
//! the same triangles, each with the same first vertex, in the same order.
#![cfg(feature = "plugins")]

use serde_json::Value;

#[test]
fn delaunay_is_scipys_triangle_for_triangle() {
    let cases: Value = serde_json::from_str(include_str!("qhull/cases.json")).expect("cases parse");
    for case in cases["cases"].as_array().expect("a case list") {
        let name = case["name"].as_str().unwrap_or("?");
        let pts: Vec<f64> = case["points"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let want: Vec<u32> = case["simplices"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
        let got = fundacad_geom::plugins::delaunay_planar(&pts).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(got.len(), want.len(), "{name}: {} triangles vs {}", got.len() / 3, want.len() / 3);
        let first = got.iter().zip(&want).position(|(a, b)| a != b);
        assert!(first.is_none(), "{name}: triangle {} differs", first.unwrap_or(0) / 3);
    }
}

#[test]
fn delaunay_refuses_what_qhull_refuses() {
    assert!(fundacad_geom::plugins::delaunay_planar(&[0.0, 0.0, 1.0, 1.0]).is_err());
    assert!(fundacad_geom::plugins::delaunay_planar(&[0.0, 0.0, 1.0, f64::NAN, 2.0, 0.0]).is_err());
}
