//! A cut only takes material away. The kernel can hand back the body with the
//! whole tool as a loose solid beside it, and the two sum to the body's own
//! volume, so by volume alone it passes for a cut that removed next to nothing.

use fundacad_geom::kernel::{self, BoolKind, Kind};

#[test]
fn a_cut_result_that_reaches_outside_its_body_is_not_taken() {
    let body = kernel::make_box(20.0, 20.0, 10.0).unwrap();
    let tool = kernel::translated(&kernel::make_box(10.0, 10.0, 10.0).unwrap(), [10.0, 0.0, 0.0]).unwrap();
    let right = kernel::serial_bool(&body, &[&tool], BoolKind::Cut).unwrap();
    let loose = kernel::translated(&kernel::make_box(2.0, 2.0, 2.0).unwrap(), [20.0, 0.0, 0.0]).unwrap();
    let wrong = kernel::compound([&right, &loose]);
    let (got, _) = kernel::bool_checked(&wrong, &body, &[&tool], BoolKind::Cut).unwrap();
    assert_eq!(kernel::count(&got, Kind::Solid), 1, "the loose solid came through");
    let (inner, outer) = (kernel::bbox(&got).unwrap(), kernel::bbox(&body).unwrap());
    for k in 0..3 {
        assert!(inner[k] >= outer[k] - 1e-6 && inner[k + 3] <= outer[k + 3] + 1e-6, "{inner:?} reaches outside {outer:?}");
    }
    assert!((kernel::volume_precise(&got) - 3500.0).abs() < 1e-6);
}
