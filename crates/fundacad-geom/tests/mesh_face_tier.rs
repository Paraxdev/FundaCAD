//! One body of tens of thousands of faces starts on a coarser tier, but one whose full quality payload surely fits
//! the single body frame cap climbs back to full quality.

use fundacad_geom::kernel;
use fundacad_geom::mesh::{self, MeshBody};
use glam::DVec3;
use opencascade::primitives::Shape;
use serde_json::Map;

#[test]
fn a_body_past_the_face_tier_that_fits_keeps_full_quality_like_its_neighbour() {
    let boxes: Vec<Shape> = (0..3_334)
        .map(|i| Shape::box_with_dimensions(1.0, 1.0, 1.0).translated(DVec3::new(2.0 * i as f64, 0.0, 0.0)))
        .collect();
    let big = kernel::compound(&boxes);
    let small = Shape::box_with_dimensions(1.0, 1.0, 1.0);
    let bodies = [
        MeshBody { id: "big".into(), name: "big".into(), shape: Some(&big), ..Default::default() },
        MeshBody { id: "small".into(), name: "small".into(), shape: Some(&small), ..Default::default() },
    ];
    let res = mesh::mesh_result(&bodies, 0.1, &Map::new());
    let normals = |i: usize| match &res.bodies[i] {
        fundacad_protocol::WireBody::Full(b) => b.normals.is_some(),
        _ => panic!("body {i} is not a full payload"),
    };
    assert!(normals(0), "the body of 20,004 small faces lost its full quality normals");
    assert!(normals(1), "the small body lost its full quality normals");
}
