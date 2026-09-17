//! Kernel tests for the OpenCASCADE classes added to the vendored bindings for
//! the Rust engine port (docs/RUST-PIVOT.md section 4.1). Each asserts on what
//! the kernel computed, never only that a call returned.

use glam::dvec3;
use opencascade::{
    heal::FixOptions,
    primitives::{Shape, ShapeType},
};

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn shape_fix_turns_an_inside_out_solid_the_right_way() {
    let cube = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let inside_out = cube.reversed();
    assert!(close(inside_out.volume(), -1000.0, 1e-6), "{}", inside_out.volume());

    let fixed = inside_out.fix(FixOptions::default()).unwrap();
    assert!(fixed.modified);
    assert!(close(fixed.shape.volume(), 1000.0, 1e-6), "{}", fixed.shape.volume());
    assert!(fixed.shape.is_valid().unwrap());
}

#[test]
fn shape_fix_solid_closes_a_shell_into_a_solid() {
    let cube = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let shells = cube.subshapes(ShapeType::Shell);
    assert_eq!(shells.len(), 1);
    let shell = &shells[0];
    assert!(close(shell.volume(), 4000.0, 1e-6));

    let solid = shell.fix_solid(1e-7, 1e-3).unwrap();
    assert_eq!(solid.shape_type(), ShapeType::Solid);
    assert!(close(solid.volume(), 4000.0, 1e-6));
    assert!(solid.is_valid().unwrap());

    assert!(cube.subshapes(ShapeType::Face)[0].fix_solid(1e-7, 1e-3).is_err());
}

#[test]
fn shape_fix_wire_and_face_keep_a_sound_face_intact() {
    let cube = Shape::box_with_dimensions(10.0, 20.0, 30.0);
    let face = cube.faces().next().unwrap();
    let area = face.surface_area();

    let fixed_face = face.fix(1e-7).unwrap();
    assert!(close(fixed_face.shape.surface_area(), area, 1e-9));
    assert_eq!(fixed_face.shape.subshapes(ShapeType::Edge).len(), 4);

    let wire = face.outer_wire();
    let fixed_wire = wire.fix(&face, 1e-7).unwrap();
    let edges = opencascade::primitives::Shape::from(&fixed_wire.shape).subshapes(ShapeType::Edge);
    assert_eq!(edges.len(), 4);
}

#[test]
fn brep_check_accepts_a_boolean_result() {
    let cube = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let hole = Shape::cylinder(dvec3(10.0, 10.0, -1.0), 3.0, dvec3(0.0, 0.0, 1.0), 12.0);
    let cut: Shape = cube.subtract(&hole).into();
    assert!(cut.is_valid().unwrap());
    assert!(Shape::empty().is_valid().unwrap());
}
