use glam::{DQuat, DVec3, EulerRot, Vec2, Vec3};
use serde_json::{json, Value};

use super::*;

/// Where the kernel puts `p` for a move's values: turned about the origin (Rx Ry Rz), then translated.
fn placed(f: &Value, p: DVec3) -> DVec3 {
    let n = |k: &str| f.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let rot = DQuat::from_rotation_x(n("rx").to_radians())
        * DQuat::from_rotation_y(n("ry").to_radians())
        * DQuat::from_rotation_z(n("rz").to_radians());
    rot * p + DVec3::new(n("dx"), n("dy"), n("dz"))
}

fn near(a: DVec3, b: DVec3) {
    assert!(a.abs_diff_eq(b, 1e-3), "{a} != {b}");
}

#[test]
fn glam_xyz_is_the_kernels_intrinsic_order() {
    let (a, b, c) = (0.3, -0.7, 1.1);
    let q = DQuat::from_euler(EulerRot::XYZ, a, b, c);
    let k = DQuat::from_rotation_x(a) * DQuat::from_rotation_y(b) * DQuat::from_rotation_z(c);
    near(q * DVec3::new(1.0, 2.0, 3.0), k * DVec3::new(1.0, 2.0, 3.0));
}

#[test]
fn kinds_and_their_handles() {
    assert_eq!(kind(&json!({"type": "fillet"})), None);
    assert_eq!(kind(&json!({})), None);
    assert_eq!(kind(&json!({"type": "duplicate"})), Some(Kind::Move));
    assert_eq!(kind(&json!({"type": "patternCircular"})), Some(Kind::Circular));
    use Handle::*;
    assert_eq!(handles(Kind::Rect), vec![Arrow(0), Arrow(1)]);
    assert_eq!(handles(Kind::Linear), vec![Arrow(0), Arrow(1), Arrow(2)]);
    assert_eq!(handles(Kind::Move), vec![Arrow(0), Arrow(1), Arrow(2), Ring(0), Ring(1), Ring(2)]);
}

#[test]
fn compose_turns_about_the_pivot() {
    let pivot = DVec3::new(12.0, -4.0, 7.5);
    let mut f = json!({"id": "f3", "type": "move", "bodies": ["f1"]});
    let rot = DQuat::from_euler(EulerRot::XYZ, 0.2, -0.4, 0.9);
    compose(&mut f, pivot, rot, DVec3::new(3.0, 0.0, -2.0));
    near(placed(&f, pivot), pivot + DVec3::new(3.0, 0.0, -2.0));
    let (back, travel) = decompose(&f, pivot);
    near(travel, DVec3::new(3.0, 0.0, -2.0));
    near(back * DVec3::X, rot * DVec3::X);
    assert_eq!(f["bodies"], json!(["f1"]));
    let (still, none) = decompose(&json!({}), pivot);
    assert!(still.abs_diff_eq(DQuat::IDENTITY, 1e-12));
    near(none, DVec3::ZERO);
}

#[test]
fn pivot_of_undoes_the_move_and_leaves_patterns() {
    let f = json!({"type": "move", "dx": 5, "dy": -2, "rz": 90});
    let pivot = Vec3::new(10.0, 3.0, 1.0);
    let centre = placed(&f, pivot.as_dvec3()).as_vec3();
    near(pivot_of(Kind::Move, &f, centre).as_dvec3(), pivot.as_dvec3());
    near(anchor(Kind::Move, &f, pivot).as_dvec3(), centre.as_dvec3());
    assert_eq!(pivot_of(Kind::Linear, &f, centre), centre);
    assert_eq!(anchor(Kind::Rect, &f, pivot), pivot);
}

#[test]
fn a_move_arrow_slides_in_steps() {
    let start = json!({"id": "f3", "type": "move", "dx": 1.5, "bodies": ["f1"]});
    let pivot = Vec3::new(20.0, 5.0, -3.0);
    let f = dragged(Kind::Move, &start, pivot, Handle::Arrow(1), 13.7, 5.0, false);
    assert_eq!(
        f,
        json!({"id": "f3", "type": "move", "bodies": ["f1"], "dx": 1.5, "dy": 15.0, "dz": 0.0, "rx": 0.0, "ry": 0.0, "rz": 0.0})
    );
    let none = dragged(Kind::Move, &start, pivot, Handle::Arrow(0), 2.4, 5.0, false);
    assert_eq!(none["dx"], json!(1.5));
}

#[test]
fn a_move_ring_turns_in_fifteens_about_the_pivot_shift_in_ones() {
    let start = json!({"id": "f3", "type": "move", "dx": 4, "bodies": ["f1"]});
    let pivot = Vec3::new(20.0, 5.0, -3.0);
    let f = dragged(Kind::Move, &start, pivot, Handle::Ring(2), 37.0, 1.0, false);
    assert_eq!(f["rz"], json!(30.0));
    assert_eq!((f["rx"].clone(), f["ry"].clone()), (json!(0.0), json!(0.0)));
    near(placed(&f, pivot.as_dvec3()), placed(&start, pivot.as_dvec3()));
    let fine = dragged(Kind::Move, &start, pivot, Handle::Ring(0), 37.4, 1.0, true);
    assert_eq!(fine["rx"], json!(37.0));
    near(placed(&fine, pivot.as_dvec3()), DVec3::new(24.0, 5.0, -3.0));
}

#[test]
fn pattern_arrows_set_spacing_axis_and_angle() {
    let lin = json!({"id": "f4", "type": "patternLinear", "count": 4, "spacing": 64, "axis": "X"});
    assert_eq!(
        dragged(Kind::Linear, &lin, Vec3::ZERO, Handle::Arrow(2), -21.3, 2.0, false),
        json!({"id": "f4", "type": "patternLinear", "count": 4, "spacing": 42.0, "axis": "Z"})
    );
    let rect = json!({"type": "patternRect", "spacingX": 20, "spacingY": 30});
    let r = dragged(Kind::Rect, &rect, Vec3::ZERO, Handle::Arrow(1), 7.0, 5.0, false);
    assert_eq!(r, json!({"type": "patternRect", "spacingX": 20, "spacingY": 35.0}));
    let circ = json!({"type": "patternCircular", "angle": 360, "axis": "Z"});
    assert_eq!(dragged(Kind::Circular, &circ, Vec3::ZERO, Handle::Arrow(2), -97.0, 1.0, false)["angle"], json!(270.0));
    assert_eq!(dragged(Kind::Circular, &circ, Vec3::ZERO, Handle::Arrow(2), 40.0, 1.0, false)["angle"], json!(360.0));
    assert_eq!(dragged(Kind::Circular, &circ, Vec3::ZERO, Handle::Arrow(2), -3.4, 1.0, true)["angle"], json!(357.0));
}

#[test]
fn a_circular_arrow_switches_the_axis_through_the_same_point() {
    let named = json!({"type": "patternCircular", "axis": "Z"});
    assert_eq!(grabbed_axis(&named, 2), named);
    assert_eq!(grabbed_axis(&named, 0), json!({"type": "patternCircular", "axis": "X"}));
    let mid = json!({"type": "patternCircular", "axis": {"origin": [10.0, 4.5, 2.0], "dir": [0, 0, 1]}});
    assert_eq!(grabbed_axis(&mid, 2), mid);
    assert_eq!(grabbed_axis(&mid, 1)["axis"], json!({"origin": [10.0, 4.5, 2.0], "dir": [0.0, 1.0, 0.0]}));
    let edge = json!({"type": "patternCircular", "axis": {"origin": [1, 2, 3], "dir": [0, 0, 1]}, "axisRef": {"kind": "edge"}});
    assert_eq!(grabbed_axis(&edge, 2), json!({"type": "patternCircular", "axis": "Z"}));
}

#[test]
fn the_turn_line_and_where_a_circular_gizmo_sits() {
    assert_eq!(turn_line(&json!({"axis": "Y"})), Some((Vec3::ZERO, Vec3::Y)));
    assert_eq!(
        turn_line(&json!({"axis": {"origin": [1, 2, 3], "dir": [0, 0, 2]}})),
        Some((Vec3::new(1.0, 2.0, 3.0), Vec3::Z))
    );
    assert_eq!(turn_line(&json!({"axis": "Z", "axisRef": {}})), None);
    assert_eq!(turn_line(&json!({"axis": {"origin": [1, 2], "dir": [0, 0, 1]}})), None);
    let f = json!({"axis": {"origin": [10, 4, 0], "dir": [0, 0, 1]}});
    assert_eq!(anchor(Kind::Circular, &f, Vec3::new(30.0, -6.0, 5.0)), Vec3::new(10.0, 4.0, 5.0));
    assert_eq!(anchor(Kind::Circular, &json!({"axisRef": {}}), Vec3::new(3.0, 1.0, 2.0)), Vec3::new(3.0, 1.0, 2.0));
}

#[test]
fn steps_are_round_and_shift_is_finer() {
    assert_eq!(step(0.1, false), 1.0);
    assert_eq!(step(0.13, false), 2.0);
    assert_eq!(step(0.31, false), 5.0);
    assert_eq!(step(0.6, false), 10.0);
    assert_eq!(step(0.6, true), 1.0);
    assert!((step(0.0042, false) - 0.05).abs() < 1e-12);
}

#[test]
fn wrap_takes_the_short_way() {
    assert_eq!(wrap(0.0), 0.0);
    assert_eq!(wrap(350.0), -10.0);
    assert_eq!(wrap(-350.0), 10.0);
    assert_eq!(wrap(170.0), 170.0);
}

#[test]
fn hit_picks_the_nearest_handle_within_reach() {
    let shapes = vec![
        (Handle::Arrow(0), vec![Vec2::new(100.0, 100.0), Vec2::new(168.0, 100.0)]),
        (Handle::Ring(2), vec![Vec2::new(130.0, 60.0), Vec2::new(130.0, 140.0)]),
    ];
    assert_eq!(hit(&[], Vec2::new(100.0, 100.0)), None);
    assert_eq!(hit(&shapes, Vec2::new(150.0, 104.0)), Some(Handle::Arrow(0)));
    assert_eq!(hit(&shapes, Vec2::new(133.0, 70.0)), Some(Handle::Ring(2)));
    assert_eq!(hit(&shapes, Vec2::new(131.0, 101.0)), Some(Handle::Arrow(0)));
    assert_eq!(hit(&shapes, Vec2::new(150.0, 109.0)), None);
    assert_eq!(hit(&shapes, Vec2::new(178.0, 100.0)), None);
}

#[test]
fn outline_sizes_handles_in_pixels() {
    let at = Vec3::new(5.0, -2.0, 1.0);
    let lines = outline(Kind::Move, at, 0.5);
    assert_eq!(lines.len(), 6);
    assert_eq!(lines[1], (Handle::Arrow(1), vec![at, at + Vec3::Y * 34.0]));
    let (h, ring) = &lines[5];
    assert_eq!(*h, Handle::Ring(2));
    assert_eq!(ring.len(), RING_STEPS + 1);
    assert!(ring.iter().all(|p| (p.distance(at) - 23.0).abs() < 1e-3 && (p.z - at.z).abs() < 1e-5));
    assert!(outline(Kind::Rect, at, 1.0).iter().all(|(h, l)| matches!(h, Handle::Arrow(0 | 1)) && l.len() == 2));
}

#[test]
fn a_value_bound_to_a_parameter_leaves_the_handles_off() {
    assert_eq!(kind(&json!({"type": "move", "dx": 4, "rz": 15})), Some(Kind::Move));
    assert_eq!(kind(&json!({"type": "move", "dx": "gap"})), None);
    assert_eq!(kind(&json!({"type": "duplicate", "ry": "tilt"})), None);
    assert_eq!(kind(&json!({"type": "patternLinear", "spacing": "pitch"})), None);
    assert_eq!(kind(&json!({"type": "patternLinear", "spacing": 12, "count": "n"})), Some(Kind::Linear));
    assert_eq!(kind(&json!({"type": "patternRect", "spacingX": 3, "spacingY": "row"})), None);
    assert_eq!(kind(&json!({"type": "patternCircular", "angle": "sweep"})), None);
    assert_eq!(kind(&json!({"type": "patternCircular", "angle": null})), Some(Kind::Circular));
    assert_eq!(kind(&json!({"type": "draft", "angle": "lean"})), None);
    assert_eq!(kind(&json!({"type": "fillet"})), None);
}

#[test]
fn a_linear_arrow_for_another_axis_spaces_the_copies_one_body_length_along_it() {
    let f = json!({"type": "patternLinear", "count": 4, "spacing": 30, "axis": "X"});
    let extent = Some(([5.0, -3.0, 2.0], [35.0, 9.5, 9.0]));
    assert_eq!(linear_axis(&f, 0, extent), f);
    assert_eq!(linear_axis(&f, 1, extent), json!({"type": "patternLinear", "count": 4, "spacing": 12.5, "axis": "Y"}));
    assert_eq!(linear_axis(&f, 2, extent), json!({"type": "patternLinear", "count": 4, "spacing": 7.0, "axis": "Z"}));
    assert_eq!(linear_axis(&f, 2, None), json!({"type": "patternLinear", "count": 4, "spacing": 20.0, "axis": "Z"}));
    let flat = Some(([0.0, 1.0, 4.0], [10.0, 1.0, 6.0]));
    assert_eq!(linear_axis(&f, 1, flat)["spacing"], json!(20.0));
}

#[test]
fn split_draft_and_face_offset_get_one_normal_arrow_unless_bound() {
    assert_eq!(kind(&json!({"type": "split", "plane": "XY"})), Some(Kind::Split));
    assert_eq!(kind(&json!({"type": "split", "planeId": "dp", "offset": 2})), None);
    assert_eq!(kind(&json!({"type": "draft", "angle": 3})), Some(Kind::Draft));
    assert_eq!(kind(&json!({"type": "offsetFace", "distance": "t"})), None);
    assert!(Kind::OffsetFace.along_normal() && !Kind::Move.along_normal());
    let arrow = outline_along(Vec3::ZERO, Vec3::NEG_Y, 0.5);
    assert_eq!(arrow, vec![(Handle::Arrow(1), vec![Vec3::ZERO, Vec3::new(0.0, -34.0, 0.0)])]);
}

#[test]
fn a_split_plane_is_the_frame_the_builder_names() {
    assert_eq!(split_plane(&json!({"plane": "XZ"})), Some((Vec3::ZERO, Vec3::NEG_Y)));
    assert_eq!(split_plane(&json!({})), None);
    let face = json!({"plane": {"origin": [1, 2, 3], "normal": [0, 0, 2], "xdir": [1, 0, 0]}});
    assert_eq!(split_plane(&face), Some((Vec3::new(1.0, 2.0, 3.0), Vec3::Z)));
}

#[test]
fn dragging_a_split_or_a_face_offset_adds_the_snapped_travel() {
    let f = json!({"type": "split", "plane": "XY", "offset": 2});
    assert_eq!(pushed(Kind::Split, &f, 0.0, 3.4, 1.0, false)["offset"], json!(5.0));
    assert_eq!(pushed(Kind::Split, &f, 0.0, -2.2, 1.0, false).get("offset"), None);
    let o = json!({"type": "offsetFace", "distance": 1});
    assert_eq!(pushed(Kind::OffsetFace, &o, 0.0, -0.26, 0.1, true)["distance"], json!(0.7));
    assert_eq!(along(Kind::OffsetFace, &o, 0.0), 1.0);
}

#[test]
fn a_draft_drag_reads_as_the_angle_about_its_neutral_line() {
    assert_eq!(draft_lever(Vec3::new(5.0, 0.0, 12.0), Vec3::new(0.0, 0.0, 2.0), "Z"), 10.0);
    assert_eq!(draft_lever(Vec3::new(5.0, 0.0, 12.0), Vec3::ZERO, "X"), 5.0);
    let f = json!({"type": "draft", "angle": 0});
    assert_eq!(pushed(Kind::Draft, &f, 10.0, 10.0, 1.0, false)["angle"], json!(45.0));
    assert_eq!(pushed(Kind::Draft, &f, 10.0, 1000.0, 1.0, false)["angle"], json!(60.0));
    assert_eq!(pushed(Kind::Draft, &f, 10.0, 0.5, 1.0, true)["angle"], json!(2.9));
    assert_eq!(pushed(Kind::Draft, &f, 0.0, 5.0, 1.0, false), f);
    let d = draft_delta(30.0, 10.0);
    assert!((draft_angle(d, 10.0) - 30.0).abs() < 1e-9);
    assert!((along(Kind::Draft, &json!({"angle": 45}), 4.0) - 4.0).abs() < 1e-6);
}

#[test]
fn a_face_arrow_is_framed_by_the_first_face_alone() {
    let face = |x: f64| json!({"kind": "face", "point": [x, 0, 0], "body": "b"});
    let f = json!({"type": "offsetFace", "faces": [face(1.0), face(2.0)], "distance": 1});
    let mut g = f.clone();
    g["distance"] = json!(5);
    g["axis"] = json!("X");
    g["faces"][1] = face(3.0);
    assert_eq!(frame_key(Kind::OffsetFace, &f), frame_key(Kind::OffsetFace, &g));
    g["faces"][0] = face(4.0);
    assert_ne!(frame_key(Kind::OffsetFace, &f), frame_key(Kind::OffsetFace, &g));
    assert_eq!(frame_key(Kind::Draft, &json!({"faces": face(1.0)})), face(1.0).to_string());
}

#[test]
fn a_draft_on_its_neutral_plane_has_no_arrow() {
    let f = json!({"type": "draft", "angle": 45});
    assert_eq!(arrow_at(Kind::Draft, &f, Vec3::ZERO, Vec3::X, 0.0), None);
    assert_eq!(arrow_at(Kind::Draft, &f, Vec3::ZERO, Vec3::X, 2.0).map(|v| (v.x * 1e4).round()), Some(2e4));
    assert_eq!(arrow_at(Kind::OffsetFace, &json!({"distance": 3}), Vec3::Z, Vec3::X, 0.0), Some(Vec3::new(3.0, 0.0, 1.0)));
}

#[test]
fn a_split_arrow_sits_on_the_bodies_the_engine_cuts() {
    assert_eq!(split_sources(&json!({"bodies": ["a"], "body": "b"})), json!({"bodies": ["a"]}));
    assert_eq!(split_sources(&json!({"bodies": [], "body": "b"})), json!({"bodies": ["b"]}));
    assert_eq!(split_sources(&json!({"body": ""})), json!({}));
}
