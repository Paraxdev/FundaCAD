//! `by:"nearest"` edge picks measure to the edge, not to its midpoint.

use fundacad_geom::kernel::{self, BoolKind};
use fundacad_geom::select::Resolver;
use opencascade::select_access as sa;
use serde_json::json;

/// (radius, centre z) of a circular edge.
fn circle(e: &opencascade::primitives::Shape) -> Option<(f64, f64)> {
    sa::edge_probe(e)?.circle.map(|(r, c)| (r, c[2]))
}

#[test]
fn a_point_on_a_full_circle_picks_that_circle() {
    let disc = kernel::make_cylinder(43.0, 10.0).unwrap();
    let post = kernel::make_cylinder(19.0, 30.0).unwrap();
    let part = kernel::boolean_op(&disc, &[&post], BoolKind::Fuse).unwrap();
    let rim_z = sa::items(&part, sa::ItemKind::Edge)
        .iter()
        .filter_map(circle)
        .filter(|(r, _)| (r - 43.0).abs() < 1e-6)
        .map(|(_, z)| z)
        .fold(f64::MIN, f64::max);
    // A full circle's midpoint sits at one fixed spot on it, so from here the
    // post's circle at the same height has the nearer midpoint.
    let sel = json!({"kind": "edge", "by": "nearest", "point": [0.0, -43.0, rim_z]});
    let got = Resolver::new(None, None).edges(&part, &sel).unwrap();
    assert_eq!(got.len(), 1);
    let (r, z) = circle(&got[0]).expect("a circle");
    assert!((r - 43.0).abs() < 1e-6 && (z - rim_z).abs() < 1e-6, "picked r={r} z={z}");
}
