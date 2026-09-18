//! Kernel tests for the OpenCASCADE classes added to the vendored bindings for
//! the Rust engine port (docs/ENGINE.md section 2.2). Each asserts on what
//! the kernel computed, never only that a call returned.

use glam::{dvec3, DVec3};
use opencascade::{
    boolean_op::{bop_split, BooleanKind, BooleanOp, BooleanOptions, Glue},
    extrema::SupportKind,
    progress::{Progress, ProgressRange},
    heal::FixOptions,
    modify::{OffsetJoin, OffsetOptions, UnifyOptions},
    primitives::{Direction, Edge, Face, Shape, ShapeType, SurfaceType, Vertex},
    query::PointState,
    sewing::{ReShape, Sewing, SewingCounts, SewingOptions},
    shape_io::BrepWriteOptions,
};
use opencascade_sys as ffi;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

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
// calls both valid, which is why the Python engine tests the volume sign instead.
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

fn tube() -> Shape {
    Shape::cylinder(dvec3(0.0, 0.0, 0.0), 5.0, dvec3(0.0, 0.0, 1.0), 10.0)
}

#[test]
fn topexp_maps_index_shapes_and_walk_edge_to_face_adjacency() {
    let block = Shape::box_with_dimensions(10.0, 20.0, 30.0);
    let faces = block.shape_map(ShapeType::Face);
    assert_eq!(faces.len(), 6);
    assert_eq!(block.shape_map(ShapeType::Edge).len(), 12);
    assert_eq!(block.shape_map(ShapeType::Vertex).len(), 8);
    assert!(faces.get(0).is_none() && faces.get(7).is_none());

    let top: Shape = block.faces().farthest(Direction::PosZ).into();
    let top_index = faces.index_of(&top);
    assert!((1..=6).contains(&top_index));
    assert_eq!(faces.index_of(&top.reversed()), top_index);
    assert!(faces.get(top_index).unwrap().is_same(&top));
    let other: Shape = Shape::box_with_dimensions(10.0, 20.0, 30.0).faces().next().unwrap().into();
    assert_eq!(faces.index_of(&other), 0);

    let edge_faces = block.ancestor_map(ShapeType::Edge, ShapeType::Face);
    assert_eq!(edge_faces.len(), 12);
    let mut neighbours = std::collections::BTreeSet::new();
    for i in 1..=edge_faces.len() {
        let adjacent = edge_faces.ancestors_at(i);
        assert_eq!(adjacent.len(), 2);
        assert!(!adjacent[0].is_same(&adjacent[1]));
        let ids: Vec<usize> = adjacent.iter().map(|f| faces.index_of(f)).collect();
        if ids.contains(&top_index) {
            neighbours.extend(ids.into_iter().filter(|&j| j != top_index));
        }
    }
    // The top face touches the four sides and never the bottom.
    assert_eq!(neighbours.len(), 4);
    let bottom: Shape = block.faces().farthest(Direction::NegZ).into();
    assert!(!neighbours.contains(&faces.index_of(&bottom)));

    let top_edge = top.subshapes(ShapeType::Edge).remove(0);
    assert_eq!(edge_faces.ancestors(&top_edge).len(), 2);
    assert!(edge_faces.ancestors(&Edge::segment(DVec3::ZERO, DVec3::X).into()).is_empty());

    // A lone face: every edge is a free boundary with one ancestor.
    let lone = top.ancestor_map(ShapeType::Edge, ShapeType::Face);
    assert!((1..=lone.len()).all(|i| lone.ancestors_at(i).len() == 1));

    // Non-manifold: three faces on one edge takes the long path through the list.
    let fan = opencascade::primitives::Compound::from_shapes([&top, &top, &top]);
    let fan = Shape::from(fan).ancestor_map(ShapeType::Edge, ShapeType::Face);
    assert_eq!(fan.ancestors_at(1).len(), 3);

    let mut map = block.shape_map(ShapeType::Face);
    assert_eq!(map.insert(&top), top_index);
    assert_eq!(map.insert(&other), 7);
    assert_eq!(map.iter().count(), 7);
}

#[test]
fn seam_edges_and_wrapping_faces_on_a_cylinder() {
    let tube = tube();
    let wall = tube.faces().find(|f| f.surface_type() == SurfaceType::Cylinder).unwrap();
    let cap = tube.faces().farthest(Direction::PosZ);
    assert!(wall.wraps());
    assert!(!cap.wraps());
    let c = wall.closure().unwrap();
    assert!(c.u_closed && c.u_periodic && !c.v_closed && !c.v_periodic, "{c:?}");

    let edge_faces = tube.ancestor_map(ShapeType::Edge, ShapeType::Face);
    let wall_shape: Shape = (&wall).into();
    let seams: Vec<Edge> = wall_shape
        .subshapes(ShapeType::Edge)
        .iter()
        .filter_map(Shape::as_edge)
        .filter(|e| e.is_seam_of(&wall))
        .collect();
    assert_eq!(seams.len(), 2, "a seam is walked once per orientation");
    let seam: Shape = (&seams[0]).into();
    assert!(seam.is_same(&(&seams[1]).into()));
    let around = edge_faces.ancestors(&seam);
    assert_eq!(around.len(), 2);
    assert!(around.iter().all(|f| f.is_same(&wall_shape)));

    let rim = cap.edges().next().unwrap();
    assert!(!rim.is_seam_of(&wall) && !rim.is_seam_of(&cap));
    let range = rim.range().unwrap();
    assert!(range.closed && range.periodic && !range.degenerated);
    assert!(close(range.last - range.first, 2.0 * std::f64::consts::PI, 1e-9));
}

#[test]
fn face_uv_bounds_projection_normals_and_classification() {
    let tube = tube();
    let wall = tube.faces().find(|f| f.surface_type() == SurfaceType::Cylinder).unwrap();
    let uv = wall.uv_bounds().unwrap();
    assert!(close(uv.u_max - uv.u_min, 2.0 * std::f64::consts::PI, 1e-9), "{uv:?}");
    assert!(close(uv.v_min, 0.0, 1e-9) && close(uv.v_max, 10.0, 1e-9), "{uv:?}");

    let hit = wall.project_point(dvec3(0.0, 8.0, 4.0)).unwrap().unwrap();
    assert!(close(hit.distance, 3.0, 1e-9));
    assert!(near(hit.point, dvec3(0.0, 5.0, 4.0), 1e-9));
    assert!(close(hit.u, std::f64::consts::FRAC_PI_2, 1e-9));
    assert!(close(hit.v, 4.0, 1e-9));
    // The untrimmed surface: a point past the cap still projects at distance 3.
    let past = wall.project_point(dvec3(0.0, 8.0, 40.0)).unwrap().unwrap();
    assert!(close(past.distance, 3.0, 1e-9));
    assert_eq!(wall.classify_uv(past.u, past.v, 1e-7).unwrap(), PointState::Out);
    assert_eq!(wall.classify_uv(hit.u, hit.v, 1e-7).unwrap(), PointState::In);
    // u = 0 is the seam, which the classifier reports as boundary.
    assert_eq!(wall.classify_uv(0.0, 4.0, 1e-7).unwrap(), PointState::On);

    let (p, n) = wall.point_and_normal(hit.u, hit.v).unwrap();
    assert!(near(p, dvec3(0.0, 5.0, 4.0), 1e-9));
    assert!(near(n, dvec3(0.0, 1.0, 0.0), 1e-9), "{n:?}");

    let block = Shape::box_with_dimensions(10.0, 20.0, 30.0);
    let top = block.faces().farthest(Direction::PosZ);
    let bottom = block.faces().farthest(Direction::NegZ);
    let tb = top.uv_bounds().unwrap();
    let mut spans = [tb.u_max - tb.u_min, tb.v_max - tb.v_min];
    spans.sort_by(f64::total_cmp);
    assert!(close(spans[0], 10.0, 1e-9) && close(spans[1], 20.0, 1e-9), "{tb:?}");
    let (_, up) = top.point_and_normal(tb.u_min, tb.v_min).unwrap();
    assert!(near(up, DVec3::Z, 1e-12));
    let bb = bottom.uv_bounds().unwrap();
    let (_, down) = bottom.point_and_normal(bb.u_min, bb.v_min).unwrap();
    assert!(near(down, -DVec3::Z, 1e-12), "the reversed face flips its normal");

    assert_eq!(top.classify_point(dvec3(5.0, 5.0, 30.0), 1e-7).unwrap(), PointState::In);
    assert_eq!(top.classify_point(dvec3(25.0, 5.0, 30.0), 1e-7).unwrap(), PointState::Out);
    assert_eq!(top.classify_point(dvec3(10.0, 5.0, 30.0), 1e-7).unwrap(), PointState::On);
    assert!(top.tolerance() > 0.0 && top.tolerance() < 1e-6);
}

#[test]
fn edge_parameter_range_and_derivative() {
    let segment = Edge::segment(dvec3(1.0, 0.0, 0.0), dvec3(1.0, 10.0, 0.0));
    let r = segment.range().unwrap();
    assert!(!r.closed && !r.periodic && !r.degenerated);
    assert!(close(r.last - r.first, 10.0, 1e-9), "{r:?}");
    let (p, d) = segment.d1(r.first).unwrap();
    assert!(near(p, dvec3(1.0, 0.0, 0.0), 1e-12));
    assert!(near(d, dvec3(0.0, 1.0, 0.0), 1e-12));

    let ring = Edge::circle(dvec3(0.0, 0.0, 2.0), DVec3::Z, 4.0);
    let r = ring.range().unwrap();
    assert!(r.closed && r.periodic);
    let (p, d) = ring.d1(std::f64::consts::FRAC_PI_2).unwrap();
    assert!(close((p - dvec3(0.0, 0.0, 2.0)).length(), 4.0, 1e-12));
    assert!(close(d.length(), 4.0, 1e-12));
    assert!(close(d.dot(p - dvec3(0.0, 0.0, 2.0)), 0.0, 1e-9));
    assert!(ring.tolerance() > 0.0);

    let cone = Shape::cone().bottom_radius(5.0).top_radius(0.0).height(10.0).build();
    let degenerate = cone
        .subshapes(ShapeType::Edge)
        .iter()
        .filter_map(Shape::as_edge)
        .filter(|e| e.range().unwrap().degenerated)
        .count();
    assert!(degenerate >= 1, "a cone apex is a degenerated edge");
}

fn count(shape: &Shape, kind: ShapeType) -> usize {
    shape.shape_map(kind).len()
}

fn plane_face(z: f64, half: f64) -> Shape {
    let face = opencascade::primitives::Wire::rect(2.0 * half, 2.0 * half).translate(dvec3(0.0, 0.0, z)).to_face();
    let face: Shape = face.into();
    assert!(close(face.surface_area(), 4.0 * half * half, 1e-9));
    face
}

#[test]
fn boolean_op_cut_keeps_history_and_section_edges() {
    let block = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let pin = Shape::cylinder(dvec3(10.0, 10.0, -1.0), 3.0, dvec3(0.0, 0.0, 1.0), 12.0);
    let mut cut =
        BooleanOp::run(BooleanKind::Cut, [&block], [&pin], BooleanOptions::default(), &ProgressRange::detached())
            .unwrap();
    let result = cut.shape().unwrap();
    let hole = std::f64::consts::PI * 9.0 * 10.0;
    assert!(close(result.volume(), 4000.0 - hole, 1e-6), "{}", result.volume());
    assert!(!cut.has_errors());

    let top: Shape = block.faces().farthest(Direction::PosZ).into();
    let now = cut.modified(&top).unwrap();
    assert_eq!(now.len(), 1);
    assert!(close(now[0].surface_area(), 400.0 - std::f64::consts::PI * 9.0, 1e-6));
    let side: Shape = block.faces().farthest(Direction::NegX).into();
    assert!(cut.modified(&side).unwrap().is_empty());
    assert!(!cut.is_deleted(&side).unwrap());
    let pin_cap: Shape = pin.faces().farthest(Direction::PosZ).into();
    assert!(cut.is_deleted(&pin_cap).unwrap());

    let circles = cut.section_edges().unwrap();
    let length: f64 = circles.iter().map(|e| e.as_edge().unwrap().length()).sum();
    assert!(close(length, 2.0 * 2.0 * std::f64::consts::PI * 3.0, 1e-6), "{length}");
}

#[test]
fn boolean_op_fuzzy_value_closes_a_sub_tolerance_gap_and_glue_fuses_touching_boxes() {
    let a = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let near_miss = Shape::box_with_dimensions(10.0, 10.0, 10.0).translated(dvec3(10.0 + 5e-6, 0.0, 0.0));
    let detached = ProgressRange::detached();

    let exact = BooleanOp::run(BooleanKind::Fuse, [&a], [&near_miss], BooleanOptions::default(), &detached)
        .unwrap()
        .shape()
        .unwrap();
    assert_eq!(count(&exact, ShapeType::Solid), 2);

    let fuzzy = BooleanOptions { fuzzy: 1e-5, ..Default::default() };
    let merged = BooleanOp::run(BooleanKind::Fuse, [&a], [&near_miss], fuzzy, &detached).unwrap().shape().unwrap();
    assert_eq!(count(&merged, ShapeType::Solid), 1);
    assert!(close(merged.volume(), 2000.0, 1e-3), "{}", merged.volume());

    let touching = Shape::box_with_dimensions(10.0, 10.0, 10.0).translated(dvec3(10.0, 0.0, 0.0));
    for glue in [Glue::Off, Glue::Full] {
        let options = BooleanOptions { glue, non_destructive: true, parallel: true, ..Default::default() };
        let mut fuse = BooleanOp::run(BooleanKind::Fuse, [&a], [&touching], options, &detached).unwrap();
        let fused = fuse.shape().unwrap();
        assert_eq!(count(&fused, ShapeType::Solid), 1, "{glue:?}");
        assert!(close(fused.volume(), 2000.0, 1e-6));
        assert_eq!(count(&fused, ShapeType::Face), 10, "{glue:?}");
        fuse.simplify(true, true, 1e-6).unwrap();
        let simple = fuse.shape().unwrap();
        assert_eq!(count(&simple, ShapeType::Face), 6);
        assert!(close(simple.volume(), 2000.0, 1e-6));
    }
    assert!(close(a.volume(), 1000.0, 1e-9) && close(touching.volume(), 1000.0, 1e-9));
}

#[test]
fn splitters_and_general_fuse_divide_without_removing_anything() {
    let detached = ProgressRange::detached();
    let block = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let knife = plane_face(4.0, 50.0);
    let split = BooleanOp::run(BooleanKind::Split, [&block], [&knife], BooleanOptions::default(), &detached)
        .unwrap()
        .shape()
        .unwrap();
    let mut volumes: Vec<f64> = split.subshapes(ShapeType::Solid).iter().map(Shape::volume).collect();
    volumes.sort_by(f64::total_cmp);
    assert_eq!(volumes.len(), 2);
    assert!(close(volumes[0], 400.0, 1e-6) && close(volumes[1], 600.0, 1e-6), "{volumes:?}");

    let section = BooleanOp::run(BooleanKind::Section, [&block], [&knife], BooleanOptions::default(), &detached)
        .unwrap()
        .shape()
        .unwrap();
    let length: f64 = section.subshapes(ShapeType::Edge).iter().map(|e| e.as_edge().unwrap().length()).sum();
    assert!(close(length, 40.0, 1e-9), "{length}");

    let overlap = Shape::box_with_dimensions(10.0, 10.0, 10.0).translated(dvec3(5.0, 0.0, 0.0));
    let cells = BooleanOp::run(BooleanKind::GeneralFuse, [&block, &overlap], [], BooleanOptions::default(), &detached)
        .unwrap()
        .shape()
        .unwrap();
    let mut volumes: Vec<f64> = cells.subshapes(ShapeType::Solid).iter().map(Shape::volume).collect();
    volumes.sort_by(f64::total_cmp);
    assert_eq!(volumes.len(), 3);
    assert!(volumes.iter().all(|v| close(*v, 500.0, 1e-6)), "{volumes:?}");

    // Sketch region detection: a square cut by two crossing lines into four cells.
    let square = plane_face(0.0, 10.0);
    let across = Shape::from(Edge::segment(dvec3(-20.0, 0.0, 0.0), dvec3(20.0, 0.0, 0.0)));
    let down = Shape::from(Edge::segment(dvec3(0.0, -20.0, 0.0), dvec3(0.0, 20.0, 0.0)));
    let regions = bop_split([&square], [&across, &down], BooleanOptions::default(), &detached).unwrap();
    let areas: Vec<f64> = regions.subshapes(ShapeType::Face).iter().map(Shape::surface_area).collect();
    assert_eq!(areas.len(), 4);
    assert!(areas.iter().all(|a| close(*a, 100.0, 1e-9)), "{areas:?}");
}

#[test]
fn progress_indicator_reports_and_cancels_a_boolean() {
    let block = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let pins: Vec<Shape> = (0..4)
        .map(|i| Shape::cylinder(dvec3(3.0 + 4.0 * i as f64, 10.0, -1.0), 1.0, DVec3::Z, 12.0))
        .collect();

    let progress = Progress::new(|| false);
    let range = progress.start();
    let cut = BooleanOp::run(BooleanKind::Cut, [&block], pins.iter(), BooleanOptions::default(), &range).unwrap();
    drop(range);
    assert!(close(cut.shape().unwrap().volume(), 4000.0 - 4.0 * std::f64::consts::PI * 10.0, 1e-6));
    assert!(progress.break_checks() > 0);
    assert!(close(progress.position(), 1.0, 1e-9), "{}", progress.position());
    assert!(!progress.is_cancelled());

    let flag = Arc::new(AtomicBool::new(true));
    let cancelled = Progress::from_flag(flag.clone());
    let refused = BooleanOp::run(BooleanKind::Cut, [&block], pins.iter(), BooleanOptions::default(), &cancelled.start());
    assert!(matches!(refused, Err(opencascade::Error::Cancelled)));
    assert!(cancelled.is_cancelled());

    // Cancelled part way: the flag goes up on the fifth time OCCT asks.
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = asked.clone();
    let midway = Progress::new(move || counter.fetch_add(1, Ordering::Relaxed) >= 4);
    let refused = BooleanOp::run(BooleanKind::Cut, [&block], pins.iter(), BooleanOptions::default(), &midway.start());
    assert!(matches!(refused, Err(opencascade::Error::Cancelled)));
    assert_eq!(midway.break_checks() as usize, asked.load(Ordering::Relaxed));
    assert!(asked.load(Ordering::Relaxed) >= 5);
    flag.store(false, Ordering::Relaxed);
    assert!(!cancelled.is_cancelled());
}

fn intersection_join() -> OffsetOptions {
    OffsetOptions { join: OffsetJoin::Intersection, ..Default::default() }
}

#[test]
fn thick_solid_shells_a_box_open_at_the_top() {
    let block = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let top = block.faces().farthest(Direction::PosZ);
    let detached = ProgressRange::detached();

    let cup = block.thick_solid_by_join(&[&top], -1.0, intersection_join(), &detached).unwrap();
    assert!(close(cup.volume(), 4000.0 - 18.0 * 18.0 * 9.0, 1e-6), "{}", cup.volume());
    assert_eq!(count(&cup, ShapeType::Face), 11);
    assert!(cup.is_valid().unwrap());

    let same = block.offset_thick_solid(-1.0, &[&top], intersection_join(), &detached).unwrap();
    assert!(close(same.volume().abs(), cup.volume(), 1e-6), "{}", same.volume());

    // A plate thickened from one face.
    let slab = plane_face(0.0, 5.0).thick_solid_by_simple(3.0).unwrap();
    assert!(close(slab.volume().abs(), 300.0, 1e-6), "{}", slab.volume());
}

#[test]
fn offset_shape_grows_whole_solids_and_single_faces() {
    let block = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let detached = ProgressRange::detached();

    let sharp = block.offset_shape(1.0, &[], intersection_join(), &detached).unwrap();
    assert!(close(sharp.volume(), 22.0 * 22.0 * 12.0, 1e-6), "{}", sharp.volume());

    // Arc join: faces pushed out, quarter cylinders on the 200 mm of edges, sphere octants.
    let round = block.offset_shape(1.0, &[], OffsetOptions::default(), &detached).unwrap();
    let pi = std::f64::consts::PI;
    let expected = 4000.0 + 1600.0 + pi / 4.0 * 200.0 + 4.0 / 3.0 * pi;
    assert!(close(round.volume(), expected, 1e-3), "{} vs {expected}", round.volume());

    let top = block.faces().farthest(Direction::PosZ);
    let raised = block.offset_shape(0.0, &[(&top, 2.0)], intersection_join(), &detached).unwrap();
    assert!(close(raised.volume(), 4800.0, 1e-6), "{}", raised.volume());
    let bounds = raised.faces().farthest(Direction::PosZ).center_of_mass();
    assert!(close(bounds.z, 12.0, 1e-9));

    assert!(block.offset_shape(0.0, &[], intersection_join(), &detached).is_err(), "a null offset is refused");

    let cancelled = Progress::new(|| true);
    let refused = block.offset_shape(1.0, &[], intersection_join(), &cancelled.start());
    assert!(matches!(refused, Err(opencascade::Error::Cancelled)), "{:?}", refused.err());
    assert!(cancelled.break_checks() > 0);
}

#[test]
fn draft_angle_tapers_the_side_walls() {
    let block = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let sides: Vec<Face> = [Direction::PosX, Direction::NegX, Direction::PosY, Direction::NegY]
        .into_iter()
        .map(|d| block.faces().farthest(d))
        .collect();
    let sides: Vec<&Face> = sides.iter().collect();
    let angle = 5f64.to_radians();
    let drafted = block.draft(&sides, DVec3::Z, angle, DVec3::ZERO, DVec3::Z).unwrap();
    assert!(drafted.is_valid().unwrap());

    let top = drafted.faces().farthest(Direction::PosZ).surface_area();
    let bottom = drafted.faces().farthest(Direction::NegZ).surface_area();
    assert!(close(bottom, 400.0, 1e-6), "the neutral plane keeps the base: {bottom}");
    let shrink = 20.0 - 2.0 * 10.0 * angle.tan();
    let grow = 20.0 + 2.0 * 10.0 * angle.tan();
    let side = if top < 400.0 { shrink } else { grow };
    assert!(close(top, side * side, 1e-6), "{top} vs {}", side * side);
    let frustum = 10.0 / 3.0 * (400.0 + side * side + 20.0 * side);
    assert!(close(drafted.volume(), frustum, 1e-6), "{} vs {frustum}", drafted.volume());
}

#[test]
fn remove_features_fills_a_drilled_hole() {
    let block = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let pin = Shape::cylinder(dvec3(10.0, 10.0, -1.0), 3.0, DVec3::Z, 12.0);
    let drilled: Shape = block.subtract(&pin).into();
    assert_eq!(count(&drilled, ShapeType::Face), 7);
    let wall = drilled.faces().find(|f| f.surface_type() == SurfaceType::Cylinder).unwrap();

    let healed = drilled.remove_features(&[&wall], false, &ProgressRange::detached()).unwrap();
    assert!(close(healed.shape.volume(), 4000.0, 1e-6), "{}", healed.shape.volume());
    assert_eq!(count(&healed.shape, ShapeType::Face), 6);
    assert!(healed.history.is_removed(&Shape::from(&wall)).unwrap());
    let top: Shape = drilled.faces().farthest(Direction::PosZ).into();
    let top_now = healed.history.modified(&top).unwrap();
    assert_eq!(top_now.len(), 1);
    assert!(close(top_now[0].surface_area(), 400.0, 1e-6));
}

#[test]
fn unify_same_domain_merges_split_faces_and_keeps_history() {
    let a = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let b = Shape::box_with_dimensions(10.0, 10.0, 10.0).translated(dvec3(10.0, 0.0, 0.0));
    let fused = BooleanOp::run(BooleanKind::Fuse, [&a], [&b], BooleanOptions::default(), &ProgressRange::detached())
        .unwrap()
        .shape()
        .unwrap();
    assert_eq!(count(&fused, ShapeType::Face), 10);

    let unified = fused.unify_same_domain(UnifyOptions::default(), &[]).unwrap();
    assert_eq!(count(&unified.shape, ShapeType::Face), 6);
    assert!(close(unified.shape.volume(), 2000.0, 1e-6));
    let half: Shape = fused.faces().farthest(Direction::PosZ).into();
    let merged = unified.history.modified(&half).unwrap();
    assert_eq!(merged.len(), 1);
    assert!(close(merged[0].surface_area(), 200.0, 1e-6));

    // Faces meeting at 179.5 degrees stay apart by default and merge at a 1 degree tolerance.
    let rise = 10.0 * 0.5f64.to_radians().tan();
    let bent = opencascade::primitives::Wire::from_ordered_points([
        dvec3(0.0, 0.0, 0.0),
        dvec3(10.0, 0.0, 0.0),
        dvec3(20.0, rise, 0.0),
        dvec3(20.0, 10.0, 0.0),
        dvec3(0.0, 10.0, 0.0),
    ])
    .unwrap()
    .to_face()
    .extrude(dvec3(0.0, 0.0, 5.0));
    let bent: Shape = bent.into();
    let faces = count(&bent, ShapeType::Face);
    assert_eq!(faces, 7);
    let strict = bent.unify_same_domain(UnifyOptions::default(), &[]).unwrap();
    assert_eq!(count(&strict.shape, ShapeType::Face), 7);
    let loose = UnifyOptions { angular_tolerance: 1f64.to_radians(), linear_tolerance: 0.1, ..Default::default() };
    let merged = bent.unify_same_domain(loose, &[]).unwrap();
    assert_eq!(count(&merged.shape, ShapeType::Face), 6);
}

#[test]
fn sewing_rebuilds_a_shell_from_loose_faces_and_reshape_edits_one() {
    let block = Shape::box_with_dimensions(10.0, 10.0, 10.0);
    let loose: Vec<Shape> = block.subshapes(ShapeType::Face).iter().map(|f| f.deep_copy(true, false).unwrap()).collect();
    assert!(loose.iter().all(|f| block.shape_map(ShapeType::Face).index_of(f) == 0), "copies share nothing");
    let pile = Shape::from(opencascade::primitives::Compound::from_shapes(&loose));
    assert_eq!(count(&pile, ShapeType::Edge), 24);

    let sewing = Sewing::run(&loose, SewingOptions::default(), &ProgressRange::detached()).unwrap();
    let sewn = sewing.shape();
    assert_eq!(sewn.shape_type(), ShapeType::Shell);
    assert_eq!(count(&sewn, ShapeType::Edge), 12);
    assert_eq!(sewing.counts(), SewingCounts { free_edges: 0, multiple_edges: 0, degenerated_shapes: 0, deleted_faces: 0 });
    assert!(close(sewn.fix_solid(0.0, 0.0).unwrap().volume(), 1000.0, 1e-6));
    let first = sewing.modified(&loose[0]).unwrap();
    assert!(sewn.shape_map(ShapeType::Face).index_of(&first) > 0);

    let open = Sewing::run(&loose[1..], SewingOptions::default(), &ProgressRange::detached()).unwrap();
    assert_eq!(open.counts().free_edges, 4);
    let rim: f64 = open.free_edges().iter().map(|e| e.as_edge().unwrap().length()).sum();
    assert!(close(rim, 40.0, 1e-9));

    let mut reshape = ReShape::new();
    let top: Shape = block.faces().farthest(Direction::PosZ).into();
    reshape.remove(&top).unwrap();
    assert!(reshape.is_recorded(&top));
    let lidless = reshape.apply(&block).unwrap();
    assert_eq!(count(&lidless, ShapeType::Face), 5);
    assert!(close(lidless.surface_area(), 500.0, 1e-6));

    let mut swap = ReShape::new();
    let bottom: Shape = block.faces().farthest(Direction::NegZ).into();
    let replacement = bottom.deep_copy(true, false).unwrap();
    swap.replace(&bottom, &replacement).unwrap();
    assert!(swap.value(&bottom).is_same(&replacement));
    let swapped = swap.apply(&block).unwrap();
    assert!(swapped.shape_map(ShapeType::Face).index_of(&replacement) > 0);
    assert_eq!(swapped.shape_map(ShapeType::Face).index_of(&bottom), 0);
}

#[test]
fn brep_bytes_and_text_round_trip_in_memory() {
    let block = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let pin = Shape::cylinder(dvec3(10.0, 10.0, -1.0), 3.0, DVec3::Z, 12.0);
    let drilled: Shape = block.subtract(&pin).into();
    let detached = ProgressRange::detached();

    let bytes = drilled.to_brep_bytes(BrepWriteOptions::default(), &detached).unwrap();
    assert!(bytes.len() > 100);
    let back = Shape::from_brep_bytes(&bytes, &detached).unwrap();
    assert!(close(back.volume(), drilled.volume(), 1e-9));
    assert_eq!(count(&back, ShapeType::Face), 7);
    assert!(back.is_valid().unwrap());
    let v3 = drilled.to_brep_bytes(BrepWriteOptions { version: 3, ..Default::default() }, &detached).unwrap();
    assert!(close(Shape::from_brep_bytes(&v3, &detached).unwrap().volume(), drilled.volume(), 1e-9));
    assert!(drilled.to_brep_bytes(BrepWriteOptions { version: 9, ..Default::default() }, &detached).is_err());
    assert!(Shape::from_brep_bytes(b"not a brep", &detached).is_err());

    let text = drilled.to_brep_text(BrepWriteOptions::default(), &detached).unwrap();
    assert!(text.trim_start().starts_with("CASCADE Topology V3"), "{}", &text[..40]);
    let back = Shape::from_brep_text(&text, &detached).unwrap();
    assert!(close(back.volume(), drilled.volume(), 1e-9));
    assert_eq!(count(&back, ShapeType::Edge), count(&drilled, ShapeType::Edge));

    let copy = drilled.deep_copy(true, false).unwrap();
    assert!(close(copy.volume(), drilled.volume(), 1e-9));
    let top: Shape = drilled.faces().farthest(Direction::PosZ).into();
    assert_eq!(copy.shape_map(ShapeType::Face).index_of(&top), 0, "a deep copy shares no topology");
}
