use opencascade_sys::mesh_import::{planar_rebuild_add, planar_rebuild_new};

const PLANE: [f64; 6] = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0];
const SQUARE: [f64; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];

#[test]
fn a_planar_region_whose_loops_match_its_points_is_added() {
    let mut r = planar_rebuild_new();
    assert!(planar_rebuild_add(r.pin_mut(), &PLANE, &SQUARE, &[4]).unwrap());
}

#[test]
fn a_planar_region_whose_loops_ask_for_more_points_than_it_holds_is_an_error() {
    let mut r = planar_rebuild_new();
    let err = planar_rebuild_add(r.pin_mut(), &PLANE, &SQUARE[..9], &[4]).unwrap_err();
    assert!(err.what().contains("do not match"), "{}", err.what());
}

#[test]
fn a_planar_region_with_a_short_plane_is_an_error() {
    let mut r = planar_rebuild_new();
    let err = planar_rebuild_add(r.pin_mut(), &PLANE[..3], &SQUARE, &[4]).unwrap_err();
    assert!(err.what().contains("do not match"), "{}", err.what());
}
