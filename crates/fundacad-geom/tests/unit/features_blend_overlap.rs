use fundacad_geom::features::blend::ops;
use fundacad_geom::features::blend::overlap::*;
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;

fn face_at_x(s: &Shape, x: f64) -> Shape {
    kernel::subshapes(s, Kind::Face)
        .into_iter()
        .find(|f| kernel::face_area_centre(f).is_some_and(|a| (a[1] - x).abs() < 1e-9))
        .expect("a face at x")
}

#[test]
fn coincident_faces_are_doubled_and_apart_ones_are_not() {
    let a = kernel::make_box(10.0, 10.0, 10.0).unwrap();
    let b = kernel::translated(&a, [10.0, 0.0, 0.0]).unwrap();
    let doubled = doubled_area(&[face_at_x(&a, 5.0), face_at_x(&b, 5.0)]).unwrap();
    assert!((doubled - 200.0).abs() < 1.0, "both sides count, {doubled}");
    let apart = doubled_area(&[face_at_x(&a, 5.0), face_at_x(&b, 15.0)]).unwrap();
    assert_eq!(apart, 0.0);
}

#[test]
fn a_sound_fillet_does_not_fold() {
    let a = kernel::make_box(20.0, 20.0, 10.0).unwrap();
    let edges = kernel::subshapes(&a, Kind::Edge);
    let (out, built) = ops::fillet(&a, &edges, &vec![2.0; edges.len()]).unwrap();
    assert_eq!(built, ops::Built::Done);
    assert!(!new_faces(&a, &out).is_empty());
    assert!(!folds_over_itself(&a, &out, 2.0));
}
