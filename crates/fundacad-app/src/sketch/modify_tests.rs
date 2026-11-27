use fundacad_sketch::Entity;
use glam::DVec2;
use serde_json::{json, Value};

use super::*;

fn p(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

fn line(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Entity {
    Entity::Line { id: id.into(), x1, y1, x2, y2 }
}

fn close(v: &Value, k: &str, want: f64) {
    let got = v[k].as_f64().unwrap();
    assert!((got - want).abs() < 1e-6, "{k}: {got} != {want} in {v}");
}

#[test]
fn trim_cuts_a_line_back_to_the_crossings_either_side_of_the_click() {
    let ents = [line("a", 0.0, 0.0, 30.0, 0.0), line("b", 10.0, -5.0, 10.0, 5.0), line("c", 20.0, -5.0, 20.0, 5.0)];
    let cut = cutters(&ents, &[], "a");
    let pieces = trim(&ents[0], &cut, p(15.0, 0.0));
    assert_eq!(pieces.len(), 2);
    close(&pieces[0], "x1", 0.0);
    close(&pieces[0], "x2", 10.0);
    close(&pieces[1], "x1", 20.0);
    close(&pieces[1], "x2", 30.0);
    let end = trim(&ents[0], &cut, p(25.0, 0.0));
    assert_eq!(end.len(), 1);
    close(&end[0], "x2", 20.0);
}

#[test]
fn trim_deletes_a_curve_with_no_crossing_and_cuts_a_circle_to_the_far_arc() {
    let lone = [line("a", 0.0, 0.0, 10.0, 0.0)];
    assert!(trim(&lone[0], &cutters(&lone, &[], "a"), p(5.0, 0.0)).is_empty());
    let ents = [Entity::Circle { id: "c".into(), x: 0.0, y: 0.0, radius: 10.0 }, line("l", 0.0, -20.0, 0.0, 20.0)];
    let arc = trim(&ents[0], &cutters(&ents, &[], "c"), p(10.0, 0.0));
    assert_eq!(arc.len(), 1);
    assert_eq!(arc[0]["type"], "arc");
    close(&arc[0], "mx", -10.0);
    close(&arc[0], "my", 0.0);
}

#[test]
fn trim_on_an_arc_keeps_the_outer_spans() {
    let a = Entity::Arc { id: "a".into(), x1: 10.0, y1: 0.0, x2: -10.0, y2: 0.0, mx: 0.0, my: 10.0 };
    let ents = [a.clone(), line("l", 0.0, 0.0, 0.0, 20.0)];
    let pieces = trim(&a, &cutters(&ents, &[], "a"), p(-7.0, 7.0));
    assert_eq!(pieces.len(), 1);
    close(&pieces[0], "x1", 10.0);
    close(&pieces[0], "x2", 0.0);
    close(&pieces[0], "y2", 10.0);
}

#[test]
fn extend_runs_the_nearer_end_on_to_the_next_crossing() {
    let ents = [line("a", 0.0, 0.0, 10.0, 0.0), line("b", 25.0, -5.0, 25.0, 5.0), line("c", -8.0, -5.0, -8.0, 5.0)];
    let cut = cutters(&ents, &[], "a");
    let e = extend(&ents[0], &cut, p(9.0, 0.0)).unwrap();
    close(&e, "x1", 0.0);
    close(&e, "x2", 25.0);
    let s = extend(&ents[0], &cut, p(1.0, 0.0)).unwrap();
    close(&s, "x1", -8.0);
    assert!(extend(&ents[1], &cutters(&ents, &[], "b"), p(25.0, 4.0)).is_none());
}

#[test]
fn extend_grows_an_arc_along_its_circle() {
    let a = Entity::Arc { id: "a".into(), x1: 10.0, y1: 0.0, x2: 0.0, y2: 10.0, mx: 7.0710678, my: 7.0710678 };
    let ents = [a.clone(), line("l", -20.0, 0.0, 0.0, 0.0)];
    let e = extend(&a, &cutters(&ents, &[], "a"), p(1.0, 9.9)).unwrap();
    close(&e, "x1", 10.0);
    close(&e, "x2", -10.0);
    close(&e, "y2", 0.0);
}

#[test]
fn a_fillet_cuts_both_lines_to_tangent_points_of_the_arc() {
    let f = fillet((p(0.0, 0.0), p(20.0, 0.0)), (p(20.0, 0.0), p(20.0, 20.0)), 5.0).unwrap();
    assert_eq!(f.a, (p(0.0, 0.0), p(15.0, 0.0)));
    assert!((f.b.0 - p(20.0, 5.0)).length() < 1e-9 && f.b.1 == p(20.0, 20.0));
    close(&f.arc, "x1", 15.0);
    close(&f.arc, "y2", 5.0);
    let m = p(f.arc["mx"].as_f64().unwrap(), f.arc["my"].as_f64().unwrap());
    assert!((m.distance(p(15.0, 5.0)) - 5.0).abs() < 1e-9);
    assert!(fillet((p(0.0, 0.0), p(20.0, 0.0)), (p(20.0, 0.0), p(20.0, 20.0)), 30.0).is_none(), "too big");
    assert!(fillet((p(0.0, 0.0), p(10.0, 0.0)), (p(0.0, 5.0), p(10.0, 5.0)), 1.0).is_none(), "parallel");
}

#[test]
fn offset_grows_closed_shapes_and_shifts_lines_to_their_left() {
    let (c, linked) = offset(&json!({"type": "circle", "x": 0, "y": 0, "radius": 5}), 2.0).unwrap();
    assert!(linked);
    close(&c, "radius", 7.0);
    let (l, _) = offset(&json!({"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0}), 3.0).unwrap();
    close(&l, "y1", 3.0);
    close(&l, "y2", 3.0);
    let (r, linked) = offset(&json!({"type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 4}), -1.0).unwrap();
    assert!(linked);
    close(&r, "width", 8.0);
    close(&r, "height", 2.0);
    assert!(offset(&json!({"type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 4}), -2.0).is_none());
    let (poly, linked) = offset(&json!({"type": "polygon", "x": 0, "y": 0, "radius": 10, "sides": 4, "angle": 0}), 1.0).unwrap();
    assert!(!linked);
    close(&poly, "radius", 10.0 + 1.0 / (std::f64::consts::PI / 4.0).cos());
    assert!(offset(&json!({"type": "point", "x": 0, "y": 0}), 1.0).is_none());
}

#[test]
fn the_signed_offset_puts_the_copy_under_the_cursor() {
    let l = json!({"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0});
    assert!((signed_offset_at(&l, p(5.0, -2.0)).unwrap() + 2.0).abs() < 1e-9);
    let c = json!({"type": "circle", "x": 0, "y": 0, "radius": 5});
    assert!((signed_offset_at(&c, p(3.0, 0.0)).unwrap() + 2.0).abs() < 1e-9);
    let r = json!({"type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 4});
    assert!((signed_offset_at(&r, p(0.0, 5.0)).unwrap() - 3.0).abs() < 1e-9);
}

#[test]
fn reflect_and_translate_move_every_point_and_turn_angles() {
    let a = json!({"type": "arc", "x1": 1, "y1": 1, "x2": 3, "y2": 1, "mx": 2, "my": 2});
    let m = reflect(&a, p(0.0, 0.0), p(1.0, 0.0));
    close(&m, "y1", -1.0);
    close(&m, "my", -2.0);
    let r = json!({"type": "rectangle", "x": 5, "y": 0, "width": 2, "height": 1, "angle": 30});
    let m = reflect(&r, p(0.0, 0.0), p(0.0, 1.0));
    close(&m, "x", -5.0);
    close(&m, "angle", 150.0);
    let s = translate(&json!({"type": "spline", "points": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]}), p(2.0, 3.0));
    assert_eq!(s["points"][1], json!({"x": 3.0, "y": 4.0}));
}

#[test]
fn extend_keeps_a_clockwise_stored_arc_s_end_order() {
    let h = 50f64.sqrt();
    let arc = Entity::Arc { id: "a".into(), x1: 0.0, y1: 10.0, x2: 10.0, y2: 0.0, mx: h, my: h };
    let ents = [arc, line("l", -5.0, 0.0, -5.0, 20.0)];
    let grown = extend(&ents[0], &cutters(&ents, &[], "a"), p(1.0, 10.0)).unwrap();
    close(&grown, "x1", -5.0);
    close(&grown, "y1", 75f64.sqrt());
    close(&grown, "x2", 10.0);
    close(&grown, "y2", 0.0);
}
