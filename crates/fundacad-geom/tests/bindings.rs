//! Kernel tests for the OpenCASCADE classes added to the vendored bindings for
//! the Rust engine port (docs/RUST-PIVOT.md section 4.1). Each asserts on what
//! the kernel computed, never only that a call returned.

use glam::{dvec3, DVec3};
use opencascade::{
    extrema::SupportKind,
    heal::FixOptions,
    primitives::{Direction, Edge, Shape, ShapeType, SurfaceType, Vertex},
};
use opencascade_sys as ffi;

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

fn near(a: DVec3, b: DVec3, tol: f64) -> bool {
    (a - b).length() <= tol
}

fn solid_from_shell(shell: &Shape) -> Shape {
    let mut make = ffi::b_rep_builder_api::BRepBuilderAPI_MakeSolid_new(ffi::topo_ds::Shell(shell.raw()));
    Shape::from_raw_ref(make.pin_mut().Shape())
}

// Two ways a solid ends up inside out: a REVERSED flag on the solid, or a
// FORWARD solid around a reversed shell (what sewing an inward shell gives).
// ShapeFix rights both, but ShapeFix_Solid::Perform only records the flip in
// its status (DONE2) and returns false, so `modified` stays false. BRepCheck
// calls both valid, which is why the sidecar tests the volume sign instead.
#[test]
fn shape_fix_turns_an_inside_out_solid_the_right_way() {
    let cube = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let shell = cube.subshapes(ShapeType::Shell).remove(0);
    let flagged = cube.reversed();
    let inward = solid_from_shell(&shell.reversed());

    for inside_out in [&flagged, &inward] {
        assert!(close(inside_out.volume(), -1000.0, 1e-6), "{}", inside_out.volume());
        assert!(inside_out.is_valid().unwrap());

        let fixed = inside_out.fix(FixOptions::default()).unwrap();
        assert!(!fixed.modified);
        assert!(close(fixed.shape.volume(), 1000.0, 1e-6), "{}", fixed.shape.volume());
        assert_eq!(fixed.shape.shape_type(), ShapeType::Solid);

        let righted = inside_out.fix_solid(0.0, 0.0).unwrap();
        assert!(close(righted.volume(), 1000.0, 1e-6), "{}", righted.volume());
    }
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

fn point(p: DVec3) -> Shape {
    Shape::from(Vertex::new(p))
}

#[test]
fn brep_extrema_measures_between_shapes_and_names_the_supports() {
    let a = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let b = Shape::box_with_dimensions(10.0, 10.0, 10.0).translated(dvec3(15.0, 2.0, 3.0));
    let d = a.distance(&b, 0.0).unwrap();
    assert!(close(d.value, 5.0, 1e-9), "{}", d.value);
    assert!(!d.inner_solution);
    assert!(!d.solutions.is_empty());
    for s in &d.solutions {
        assert!(close(s.on_first.point.x, 10.0, 1e-9));
        assert!(close(s.on_second.point.x, 15.0, 1e-9));
        assert!(close((s.on_first.point - s.on_second.point).length(), 5.0, 1e-9));
    }

    let d = a.distance(&point(dvec3(15.0, 5.0, 4.0)), 0.0).unwrap();
    assert_eq!(d.solutions.len(), 1);
    let end = &d.solutions[0].on_first;
    assert!(close(d.value, 5.0, 1e-9));
    assert!(near(end.point, dvec3(10.0, 5.0, 4.0), 1e-9));
    assert_eq!(end.kind, SupportKind::Face);
    assert_eq!(end.support.shape_type(), ShapeType::Face);
    assert!(close(end.support.as_face().unwrap().center_of_mass().x, 10.0, 1e-9));
    assert_eq!(d.solutions[0].on_second.kind, SupportKind::Vertex);

    let corner = a.distance(&point(dvec3(13.0, 5.0, 14.0)), 0.0).unwrap();
    assert!(close(corner.value, 5.0, 1e-9));
    assert_eq!(corner.solutions[0].on_first.kind, SupportKind::Edge);
    assert!(near(corner.solutions[0].on_first.point, dvec3(10.0, 5.0, 10.0), 1e-9));

    let inside = a.distance_to_point(dvec3(5.0, 5.0, 5.0)).unwrap();
    assert!(close(inside, 0.0, 1e-9), "{inside}");
}

#[test]
fn face_distance_is_to_the_trimmed_face_not_its_surface() {
    let cube = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let top = cube.faces().farthest(Direction::PosZ);
    assert!(close(top.distance_to(dvec3(5.0, 5.0, 13.0)), 3.0, 1e-9));
    // Coplanar with the top face and 10 beyond its edge: the unbounded plane said 0.
    assert!(close(top.distance_to(dvec3(20.0, 5.0, 10.0)), 10.0, 1e-9));
    assert!(close(top.distance_to(dvec3(13.0, 14.0, 10.0)), 5.0, 1e-9));

    let tube = Shape::cylinder(dvec3(0.0, 0.0, 0.0), 5.0, dvec3(0.0, 0.0, 1.0), 10.0);
    let wall = tube.faces().find(|f| f.surface_type() == SurfaceType::Cylinder).unwrap();
    assert!(close(wall.distance_to(dvec3(8.0, 0.0, 5.0)), 3.0, 1e-7));
    assert!(close(wall.distance_to(dvec3(8.0, 0.0, 14.0)), 5.0, 1e-7));
}

#[test]
fn gprop_mass_centre_and_inertia_of_solids_faces_and_edges() {
    let block = Shape::box_with_dimensions(10.0, 20.0, 30.0);
    let v = block.volume_properties().unwrap();
    assert!(close(v.mass, 6000.0, 1e-6));
    assert!(near(v.centre_of_mass, dvec3(5.0, 10.0, 15.0), 1e-9));
    assert!(close(v.inertia[0][0], 6000.0 * (400.0 + 900.0) / 12.0, 1e-3), "{:?}", v.inertia);
    assert!(close(v.inertia[1][1], 6000.0 * (100.0 + 900.0) / 12.0, 1e-3));
    assert!(close(v.inertia[2][2], 6000.0 * (100.0 + 400.0) / 12.0, 1e-3));
    assert!(close(v.inertia[0][1], 0.0, 1e-6));
    let mut principal = v.principal_moments;
    principal.sort_by(f64::total_cmp);
    assert!(close(principal[0], 250_000.0, 1e-3), "{principal:?}");
    assert!(close(principal[2], 650_000.0, 1e-3), "{principal:?}");

    let s = block.surface_properties().unwrap();
    assert!(close(s.mass, 2.0 * (200.0 + 300.0 + 600.0), 1e-6));
    assert!(near(s.centre_of_mass, dvec3(5.0, 10.0, 15.0), 1e-9));

    let l = block.linear_properties().unwrap();
    assert!(close(l.mass, 4.0 * (10.0 + 20.0 + 30.0), 1e-6));

    let top = block.faces().farthest(Direction::PosZ).properties().unwrap();
    assert!(close(top.mass, 200.0, 1e-9));
    assert!(near(top.centre_of_mass, dvec3(5.0, 10.0, 30.0), 1e-9));
    // A thin plate: Izz = A (a^2 + b^2) / 12.
    assert!(close(top.inertia[2][2], 200.0 * (100.0 + 400.0) / 12.0, 1e-6));

    let segment = Edge::segment(dvec3(0.0, 0.0, 0.0), dvec3(10.0, 0.0, 0.0)).properties().unwrap();
    assert!(close(segment.mass, 10.0, 1e-9));
    assert!(near(segment.centre_of_mass, dvec3(5.0, 0.0, 0.0), 1e-9));
    assert!(close(segment.inertia[1][1], 1000.0 / 12.0, 1e-6));

    let ring = Edge::circle(dvec3(1.0, 2.0, 3.0), dvec3(0.0, 0.0, 1.0), 5.0).properties().unwrap();
    assert!(close(ring.mass, 10.0 * std::f64::consts::PI, 1e-9));
    assert!(near(ring.centre_of_mass, dvec3(1.0, 2.0, 3.0), 1e-9));
    // A hoop about its axis: I = m r^2.
    assert!(close(ring.inertia[2][2], ring.mass * 25.0, 1e-6));

    let tube = Shape::cylinder(dvec3(0.0, 0.0, 0.0), 5.0, dvec3(0.0, 0.0, 1.0), 10.0);
    let wall = tube.faces().find(|f| f.surface_type() == SurfaceType::Cylinder).unwrap();
    let w = wall.properties().unwrap();
    assert!(close(w.mass, 100.0 * std::f64::consts::PI, 1e-6));
    assert!(near(w.centre_of_mass, dvec3(0.0, 0.0, 5.0), 1e-7));
}
