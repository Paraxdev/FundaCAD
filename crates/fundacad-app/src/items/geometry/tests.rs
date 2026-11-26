use glam::Vec3;
use serde_json::json;

use super::*;
use crate::viewport::scene::tests::block;

#[test]
fn a_box_lists_six_flat_faces_one_per_side() {
    let body = block(Vec3::ZERO, Vec3::new(10., 20., 30.), "ex1");
    let rows = face_rows(&body, |id| (id == "ex1").then(|| "Extrude1".to_string()));
    assert_eq!(rows.len(), 6);
    assert!(rows.iter().all(|r| r.row_type == Some(RowType::Flat)));
    let facing: Vec<_> = rows.iter().map(|r| r.facing.unwrap()).collect();
    assert_eq!(facing, [Facing::Left, Facing::Right, Facing::Front, Facing::Back, Facing::Down, Facing::Up]);
    assert_eq!(rows[5].label, "Flat face 6");
    assert_eq!(rows[5].hint, "200 mm², facing up, Extrude1");
    assert_eq!(rows[0].key, "f:body1:0");
}

#[test]
fn facing_ties_go_z_then_y_and_a_tilt_is_in_degrees() {
    assert_eq!(facing_of(Vec3::new(1., 1., 1.)).map(|f| f.0), Some(Facing::Up));
    assert_eq!(facing_of(Vec3::new(1., -1., 0.)).map(|f| f.0), Some(Facing::Front));
    assert_eq!(facing_of(Vec3::new(0., 0., -1.)), Some((Facing::Down, 0)));
    assert_eq!(facing_of(Vec3::new(1., 0., 1.)), Some((Facing::Up, 45)));
    assert_eq!(facing_of(Vec3::ZERO), None);
}

fn ring(r: f32, n: usize, closed: bool) -> Vec<Vec3> {
    let steps = if closed { n } else { n / 2 };
    (0..=steps).map(|i| {
        let a = i as f32 / n as f32 * std::f32::consts::TAU;
        Vec3::new(r * a.cos(), r * a.sin(), 0.)
    })
    .collect()
}

#[test]
fn edges_are_straight_round_or_curved() {
    assert_eq!(edge_curve(&[Vec3::ZERO, Vec3::new(5., 0., 0.), Vec3::new(10., 0., 0.)]), Curve::Line);
    let Curve::Circle(r) = edge_curve(&ring(5., 32, true)) else { panic!("a circle") };
    assert!((r - 5.).abs() < 0.05);
    let Curve::Arc(r) = edge_curve(&ring(3., 32, false)) else { panic!("an arc") };
    assert!((r - 3.).abs() < 1e-3);
    let wave: Vec<Vec3> = (0..20).map(|i| Vec3::new(i as f32, (i as f32 * 0.7).sin() * (i as f32), 0.)).collect();
    assert_eq!(edge_curve(&wave), Curve::Other);
}

#[test]
fn a_cylinder_face_is_told_from_a_dome() {
    let around: Vec<Vec3> = (0..12).map(|i| Vec3::new((i as f32).cos(), (i as f32).sin(), 0.)).collect();
    assert_eq!(face_type(&around), RowType::Cylinder);
    let dome = [Vec3::Z, Vec3::new(0.5, 0., 0.86), Vec3::new(0., 0.5, 0.86), Vec3::X];
    assert_eq!(face_type(&dome), RowType::Curved);
}

#[test]
fn edge_rows_read_the_wire_polylines() {
    let mut body = block(Vec3::ZERO, Vec3::ONE, "ex1");
    body.edges.points = [0., 0., 0., 4., 0., 0.].into_iter().chain(ring(2., 16, true).iter().flat_map(|p| p.to_array())).collect();
    body.edges.counts = vec![2, 17];
    let rows = edge_rows(&body);
    assert_eq!(rows.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(), ["Straight edge 1", "Round edge 2"]);
    assert_eq!(rows[0].hint, "4 mm");
    assert!(rows[1].hint.contains("⌀4 mm"), "{}", rows[1].hint);
}

#[test]
fn planes_are_the_origin_then_unsuppressed_datums() {
    let doc = json!({"features": [{"id": "a", "type": "datumPlane"}, {"id": "b", "type": "datumPlane", "name": "Mid"}],
        "suppressed": ["a"]});
    let rows = plane_rows(doc.as_object().unwrap());
    let labels: Vec<_> = rows.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(labels, ["XY plane", "XZ plane", "YZ plane", "Mid"]);
    assert_eq!(rows[1].facing, Some(Facing::Front));
    assert_eq!(rows[0].hint, "origin, facing up");
}

#[test]
fn filters_paging_and_counts() {
    let body = block(Vec3::ZERO, Vec3::ONE, "ex1");
    let rows = face_rows(&body, |_| None);
    let up = filter_rows(&rows, &Filters { row_type: None, facing: Some(Facing::Up) });
    assert_eq!(up.len(), 1);
    assert!(filter_rows(&rows, &Filters { row_type: Some(RowType::Cylinder), facing: None }).is_empty());
    assert_eq!(range_text(0, 340), "1 to 100 of 340");
    assert_eq!(range_text(3, 340), "301 to 340 of 340");
    assert_eq!(page_count(0), 1);
    assert_eq!(page_count(201), 3);
    assert_eq!(GeomKind::Faces.count(1), "1 face");
    assert_eq!(GeomKind::Edges.count(0), "No edges");
    assert_eq!(fmt_mm(2.50), "2.5 mm");
}
