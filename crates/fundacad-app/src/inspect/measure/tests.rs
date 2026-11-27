use std::sync::Arc;

use super::*;
use crate::inspect::tests::solid as block2;

fn row(k: &str, v: &str) -> Row {
    (k.to_string(), v.to_string())
}

fn body() -> SceneBody {
    SceneBody::new(Arc::new(block2(Vec3::new(3.0, -2.0, 5.0), Vec3::new(7.0, 5.0, 7.0))))
}

#[test]
fn nothing_picked_asks_for_a_pick() {
    assert_eq!(rows(None, None), vec![row("", "Click a face or edge")]);
}

#[test]
fn one_face_gives_its_area_and_middle() {
    let b = body();
    let top = face_probe(face_triangles(&b, 5)).unwrap();
    let Probe::Face { point, dir, area, tris } = &top else { panic!("a face") };
    assert!(point.distance(Vec3::new(5.0, 1.5, 7.0)) < 1e-5);
    assert_eq!((*dir, *area, tris.len()), (Vec3::Z, 28.0, 2));
    assert_eq!(rows(Some(&top), None), vec![row("Area", "28 mm²"), row("At", "5, 1.5, 7")]);
}

#[test]
fn an_empty_face_is_no_probe() {
    assert_eq!(face_probe(Vec::new()), None);
    assert_eq!(face_probe(face_triangles(&body(), 9)), None);
}

#[test]
fn one_edge_gives_its_length_and_halfway() {
    let e = edge_probe(vec![Vec3::new(1.0, 2.0, 3.0), Vec3::new(4.0, 2.0, 3.0), Vec3::new(4.0, 6.0, 3.0)]).unwrap();
    assert_eq!(e.point(), Vec3::new(4.0, 2.5, 3.0));
    assert_eq!(e.dir(), Vec3::new(0.6, 0.8, 0.0));
    assert_eq!(rows(Some(&e), None), vec![row("Length", "7 mm"), row("At", "4, 2.5, 3")]);
    assert_eq!(edge_probe(vec![Vec3::ONE]), None);
}

#[test]
fn two_opposite_faces() {
    let b = body();
    let low = face_probe(face_triangles(&b, 4)).unwrap();
    let high = face_probe(face_triangles(&b, 5)).unwrap();
    let near = closest(&low, &high);
    assert!((near.d - 2.0).abs() < 1e-5);
    assert_eq!(near.pb - near.pa, Vec3::new(0.0, 0.0, 2.0));
    assert_eq!(
        rows(Some(&low), Some(&high)),
        vec![row("Distance", "2 mm"), row("ΔX ΔY ΔZ", "0, 0, 2"), row("Centers", "2 mm"), row("Angle", "180°")]
    );
}

#[test]
fn a_face_and_a_skew_edge() {
    let b = body();
    let side = face_probe(face_triangles(&b, 1)).unwrap();
    let e = edge_probe(vec![Vec3::new(10.0, 0.0, 6.0), Vec3::new(10.0, 3.0, 6.0)]).unwrap();
    let near = closest(&side, &e);
    assert!((near.d - 3.0).abs() < 1e-5);
    assert_eq!(near.pa.x, 7.0);
    assert_eq!(near.pb.x, 10.0);
    let r = rows(Some(&side), Some(&e));
    assert_eq!(r[0], row("Distance", "3 mm"));
    assert_eq!(r[1], row("ΔX ΔY ΔZ", "3, 0, 0"));
    assert_eq!(r[3], row("Angle", "90°"));
}

#[test]
fn crossing_edges_and_a_closed_loop_without_angle() {
    let a = edge_probe(vec![Vec3::new(-1.0, 0.0, 4.0), Vec3::new(3.0, 0.0, 4.0)]).unwrap();
    let b = edge_probe(vec![Vec3::new(1.0, -2.0, 9.0), Vec3::new(1.0, 2.0, 9.0)]).unwrap();
    let near = closest(&a, &b);
    assert_eq!((near.d, near.pa, near.pb), (5.0, Vec3::new(1.0, 0.0, 4.0), Vec3::new(1.0, 0.0, 9.0)));
    let ring = edge_probe(vec![Vec3::ZERO, Vec3::X, Vec3::Y, Vec3::ZERO]).unwrap();
    assert_eq!(ring.dir(), Vec3::ZERO);
    let r = rows(Some(&a), Some(&ring));
    assert_eq!(r.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["Distance", "ΔX ΔY ΔZ", "Centers"]);
}

#[test]
fn parallel_segments_and_points() {
    let (x, y) = on_segments(Vec3::ZERO, Vec3::X * 4.0, Vec3::new(1.0, 2.0, 0.0), Vec3::new(3.0, 2.0, 0.0));
    assert_eq!(x.distance(y), 2.0);
    assert_eq!(on_segments(Vec3::ONE, Vec3::ONE, Vec3::ZERO, Vec3::ZERO), (Vec3::ONE, Vec3::ZERO));
    let t = [Vec3::ZERO, Vec3::X, Vec3::Y];
    assert!(on_triangle(Vec3::new(0.2, 0.2, 5.0), &t).distance(Vec3::new(0.2, 0.2, 0.0)) < 1e-6);
    assert_eq!(on_triangle(Vec3::new(-1.0, -1.0, 0.0), &t), Vec3::ZERO);
    assert_eq!(on_triangle(Vec3::new(2.0, 0.0, 1.0), &t), Vec3::X);
}
