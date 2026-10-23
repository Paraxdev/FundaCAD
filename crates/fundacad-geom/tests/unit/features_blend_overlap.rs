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

fn row_of_three(l: f64, w: f64, h: f64, at: [f64; 3]) -> (Shape, Shape) {
    let a = kernel::translated(&kernel::make_box(l, w, h).unwrap(), at).unwrap();
    let b = kernel::translated(&a, [l, 0.0, 0.0]).unwrap();
    let c = kernel::translated(&a, [2.0 * l, 0.0, 0.0]).unwrap();
    let out = kernel::compound([&a, &b, &c]);
    (a, out)
}

#[test]
fn faces_that_land_on_each_other_fold() {
    let (a, out) = row_of_three(10.0, 7.0, 4.0, [3.25, -6.5, 2.75]);
    assert_eq!(new_faces(&a, &out).len(), 12);
    let doubled = doubled_area(&new_faces(&a, &out)).unwrap();
    assert!((doubled - 56.0).abs() < 1e-6, "{doubled}");
    // The allowance 0.25 size2 meets 56 mm2 at a size of sqrt(224), 14.97.
    let folds: Vec<bool> = [0.1, 14.9, 15.0, 30.0].iter().map(|&s| folds_over_itself(&a, &out, s)).collect();
    assert_eq!(folds, [true, true, false, false]);
}

#[test]
fn a_fold_of_exactly_the_allowance_is_not_a_fold() {
    let (a, out) = row_of_three(1.0, 0.5, 1.0, [2.5, -1.25, 0.75]);
    assert_eq!(doubled_area(&new_faces(&a, &out)).unwrap(), 1.0);
    let folds: Vec<bool> = [1.99, 2.0, 2.01].iter().map(|&s| folds_over_itself(&a, &out, s)).collect();
    assert_eq!(folds, [true, false, false]);
}

#[test]
fn faces_a_twentieth_of_a_millimetre_apart_do_not_fold() {
    let a = kernel::translated(&kernel::make_box(10.0, 7.0, 4.0).unwrap(), [3.25, -6.5, 2.75]).unwrap();
    let b = kernel::translated(&a, [10.05, 0.0, 0.0]).unwrap();
    let before = kernel::make_box(1.0, 1.0, 1.0).unwrap();
    let out = kernel::compound([&a, &b]);
    assert_eq!(doubled_area(&new_faces(&before, &out)).unwrap(), 0.0);
    assert!(!folds_over_itself(&before, &out, 0.1));
}
