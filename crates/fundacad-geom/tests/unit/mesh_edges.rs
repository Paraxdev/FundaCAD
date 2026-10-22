use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::mesh::edges::*;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::Shape;

fn agrees(shape: &Shape) {
    let access = MeshAccess::new(shape);
    let cos_tol = SMOOTH_EDGE_DEG.to_radians().cos();
    for e in 0..access.edge_count() {
        assert_eq!(meets_smoothly(&access, e), access.edge_smooth(e, cos_tol), "edge {e} disagrees");
    }
}

/// The batched kernel call must decide exactly what the per sample walk
/// decides, or a saved selector and an etag move under the client.
#[test]
fn the_batched_smooth_test_matches_the_sampled_one() {
    agrees(&kernel::make_box(20.0, 20.0, 10.0).expect("a box"));
    agrees(&kernel::make_cylinder(6.0, 12.0).expect("a cylinder"));
    agrees(&kernel::make_sphere(7.0).expect("a sphere"));
    agrees(&kernel::make_cone(6.0, 2.0, 9.0).expect("a cone"));
    agrees(&kernel::make_torus(10.0, 3.0).expect("a torus"));
    let b = kernel::make_box(20.0, 20.0, 10.0).expect("a box");
    let edges = kernel::subshapes(&b, Kind::Edge);
    let (filleted, _) =
        fundacad_geom::features::blend::ops::fillet(&b, &edges, &vec![2.0; edges.len()]).expect("a fillet");
    agrees(&filleted);
}
