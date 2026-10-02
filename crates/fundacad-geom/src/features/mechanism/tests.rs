//! Linkages built from boxes and cylinders, posed by the mechanism and
//! checked against their closed form kinematics.

use glam::{DVec2, DVec3};
use serde_json::{json, Value};

use crate::builder::{self, NoWatch, Rebuild};
use crate::kernel;

fn build(features: Value) -> Rebuild {
    let doc = json!({ "features": features });
    let typed = serde_json::from_value(doc.clone()).expect("the document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn centre(r: &Rebuild, id: &str) -> DVec3 {
    let b = r.bodies.iter().find(|b| b.id == id).expect("the body is there");
    DVec3::from_array(kernel::center_of_mass(&b.shape).expect("a solid"))
}

fn assert_at(r: &Rebuild, id: &str, want: DVec3) {
    let got = centre(r, id);
    assert!((got - want).length() < 1e-4, "{id} is at {got}, wanted {want}");
}

fn ok(r: &Rebuild) {
    assert!(r.errors.is_empty(), "{:?}", r.errors);
}

fn advice(r: &Rebuild) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d["kind"] == "mechanism")
        .map(|d| d["reason"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// A box of `length` along x, lying from `from` to `to` in the XY plane.
fn link(id: &str, body: &str, length: f64, from: DVec2, to: DVec2) -> [Value; 2] {
    let d = to - from;
    let mid = (from + to) / 2.0;
    [
        json!({"id": id, "type": "box", "length": length, "width": 4, "height": 2}),
        json!({"id": format!("{id}m"), "type": "move", "bodies": [body],
               "rz": d.y.atan2(d.x).to_degrees(), "dx": mid.x, "dy": mid.y}),
    ]
}

fn pin(id: &str, a: &str, b: &str, at: DVec2) -> Value {
    json!({"id": id, "mode": "revolute",
           "a": {"body": a, "origin": [at.x, at.y, 0.0]},
           "b": {"body": b, "origin": [at.x, at.y, 0.0]}})
}

fn polar(r: f64, deg: f64) -> DVec2 {
    let t = deg.to_radians();
    DVec2::new(r * t.cos(), r * t.sin())
}

/// Where two circles meet, on the `up` side of the line from `p` to `q`.
fn meet(p: DVec2, rp: f64, q: DVec2, rq: f64, up: bool) -> DVec2 {
    let v = q - p;
    let d = v.length();
    let along = (rp * rp - rq * rq + d * d) / (2.0 * d);
    let h = (rp * rp - along * along).sqrt();
    let perp = DVec2::new(-v.y, v.x) / d;
    p + v / d * along + perp * if up { h } else { -h }
}

fn flat(p: DVec2) -> DVec3 {
    DVec3::new(p.x, p.y, 0.0)
}

// A crank-rocker: ground 40, crank 10, coupler 35, rocker 30 (Grashof, the
// crank turns all the way round).
const GROUND: f64 = 40.0;
const CRANK: f64 = 10.0;
const COUPLER: f64 = 35.0;
const ROCKER: f64 = 30.0;

fn four_bar(angle: f64, up: bool, extra: &[Value], extra_joints: &[Value]) -> Value {
    let o4 = DVec2::new(GROUND, 0.0);
    let a = DVec2::new(CRANK, 0.0);
    let b = meet(a, COUPLER, o4, ROCKER, up);
    let mut f = vec![json!({"id": "g", "type": "box", "length": 4, "width": 4, "height": 2})];
    f.extend(link("c", "body2", CRANK, DVec2::ZERO, a));
    f.extend(link("k", "body3", COUPLER, a, b));
    f.extend(link("r", "body4", ROCKER, o4, b));
    f.extend(extra.iter().cloned());
    let mut joints = vec![
        pin("crank", "body2", "body1", DVec2::ZERO),
        pin("p1", "body3", "body2", a),
        pin("p2", "body4", "body3", b),
        pin("p3", "body4", "body1", o4),
    ];
    joints.extend(extra_joints.iter().cloned());
    f.push(json!({"id": "m", "type": "mechanism", "ground": "body1",
                  "joints": joints, "drive": "crank", "angle": angle}));
    Value::Array(f)
}

fn four_bar_at(r: &Rebuild, angle: f64, up: bool) {
    let o4 = DVec2::new(GROUND, 0.0);
    let a = polar(CRANK, angle);
    let b = meet(a, COUPLER, o4, ROCKER, up);
    assert_at(r, "body2", flat(a / 2.0));
    assert_at(r, "body3", flat((a + b) / 2.0));
    assert_at(r, "body4", flat((o4 + b) / 2.0));
}

#[test]
fn a_four_bar_rocker_follows_its_crank() {
    for angle in [30.0, 135.0, 270.0] {
        let r = build(four_bar(angle, true, &[], &[]));
        ok(&r);
        four_bar_at(&r, angle, true);
        // Driven, nothing is left free.
        assert!(advice(&r).is_empty(), "{:?}", advice(&r));
        // The crank's pin is where the drive handle stands.
        assert_eq!(r.datum_marks["m"]["dir"], json!([0.0, 0.0, 1.0]));
    }
}

#[test]
fn a_linkage_stays_on_the_branch_it_was_modelled_on() {
    // Modelled elbow down, the rocker stays below the ground line all the way
    // round, though the elbow up pose meets every joint as well.
    for angle in [90.0, 180.0, 300.0, 360.0] {
        let r = build(four_bar(angle, false, &[], &[]));
        ok(&r);
        four_bar_at(&r, angle, false);
    }
}

// A slider-crank: crank 10, coupler 30, the slider on the x axis, modelled
// with the crank at 60 degrees.
const THROW: f64 = 10.0;
const ROD: f64 = 30.0;

fn slider_x(deg: f64) -> f64 {
    let t = deg.to_radians();
    THROW * t.cos() + (ROD * ROD - (THROW * t.sin()).powi(2)).sqrt()
}

fn slider_crank(drive: &str, field: &str, value: f64) -> Value {
    let a = polar(THROW, 60.0);
    let p = DVec2::new(slider_x(60.0), 0.0);
    let mut f = vec![json!({"id": "g", "type": "box", "length": 4, "width": 4, "height": 2})];
    f.extend(link("c", "body2", THROW, DVec2::ZERO, a));
    f.extend(link("k", "body3", ROD, a, p));
    f.push(json!({"id": "s", "type": "box", "length": 6, "width": 4, "height": 2}));
    f.push(json!({"id": "sm", "type": "move", "bodies": ["body4"], "dx": p.x}));
    let x60 = polar(1.0, 60.0);
    f.push(json!({"id": "m", "type": "mechanism", "ground": "body1", "drive": drive, (field): value,
        "joints": [
            {"id": "crank", "mode": "revolute",
             "a": {"body": "body2", "origin": [0, 0, 0], "zdir": [0, 0, 1], "xdir": [x60.x, x60.y, 0.0]},
             "b": {"body": "body1", "origin": [0, 0, 0], "zdir": [0, 0, 1]}},
            pin("c1", "body3", "body2", a),
            pin("c2", "body4", "body3", p),
            {"id": "slide", "mode": "slider",
             "a": {"body": "body4", "origin": [p.x, 0, 0], "zdir": [1, 0, 0]},
             "b": {"body": "body1", "origin": [0, 0, 0], "zdir": [1, 0, 0]}},
        ]}));
    Value::Array(f)
}

#[test]
fn a_slider_crank_slides_as_its_crank_turns() {
    // The crank's x is given along the crank, so the angle reads 60 as modelled.
    for angle in [60.0, 150.0, 300.0] {
        let r = build(slider_crank("crank", "angle", angle));
        ok(&r);
        assert_at(&r, "body4", DVec3::new(slider_x(angle), 0.0, 0.0));
        assert_at(&r, "body2", flat(polar(THROW, angle) / 2.0));
        assert!(advice(&r).is_empty(), "{:?}", advice(&r));
    }
}

#[test]
fn the_mark_says_where_an_undriven_value_sits() {
    // No value yet: the handle starts from the pose as modelled.
    for (drive, field, want) in [("crank", "angle", 60.0), ("slide", "offset", slider_x(60.0))] {
        let mut doc = slider_crank(drive, field, 0.0);
        doc.as_array_mut().unwrap().last_mut().unwrap().as_object_mut().unwrap().remove(field);
        let r = build(doc);
        ok(&r);
        let got = r.datum_marks["m"]["value"].as_f64().unwrap();
        assert!((got - want).abs() < 1e-6, "{drive}: {got} vs {want}");
    }
}

#[test]
fn a_slider_drives_the_crank_back() {
    let x = 25.0;
    let r = build(slider_crank("slide", "offset", x));
    ok(&r);
    // The crank stays above the slide line, on the side it was modelled.
    let cos = (x * x + THROW * THROW - ROD * ROD) / (2.0 * THROW * x);
    let a = polar(THROW, cos.acos().to_degrees());
    assert_at(&r, "body4", DVec3::new(x, 0.0, 0.0));
    assert_at(&r, "body3", flat((a + DVec2::new(x, 0.0)) / 2.0));
    assert_eq!(
        r.datum_marks["m"],
        json!({"kind": "axis", "origin": [0.0, 0.0, 0.0], "dir": [1.0, 0.0, 0.0], "value": 25.0})
    );
}

#[test]
fn a_drive_past_its_reach_names_the_joint_and_the_gap() {
    // Crank and rod reach 40 at most.
    let r = build(slider_crank("slide", "offset", 45.0));
    assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
    let msg = &r.errors[0].message;
    let head = "mechanism: the linkage cannot reach offset 45 mm on slide, it locks near ";
    assert!(msg.starts_with(head), "{msg}");
    let near: f64 = msg[head.len()..].split(' ').next().unwrap().parse().unwrap();
    assert!((near - 40.0).abs() < 0.2, "{msg}");
    assert!(msg.contains(" mm where ") && msg.ends_with(" mm apart"), "{msg}");
    // All or nothing: the slider is where it was modelled.
    assert_at(&r, "body4", DVec3::new(slider_x(60.0), 0.0, 0.0));
}

#[test]
fn joints_that_cannot_meet_are_refused() {
    // Two parallel pins 10 apart on the ground, 12 apart on the link.
    let r = build(json!([
        {"id": "g", "type": "box", "length": 4, "width": 4, "height": 2},
        {"id": "l", "type": "box", "length": 14, "width": 4, "height": 2},
        {"id": "m", "type": "mechanism", "ground": "body1", "joints": [
            pin("one", "body2", "body1", DVec2::ZERO),
            {"id": "two", "mode": "revolute",
             "a": {"body": "body2", "origin": [12, 0, 0]}, "b": {"body": "body1", "origin": [10, 0, 0]}},
        ]},
    ]));
    assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
    let msg = &r.errors[0].message;
    assert!(msg.starts_with("mechanism: the joints cannot all be met, "), "{msg}");
    assert!(msg.ends_with(" mm apart (body2 to body1)"), "{msg}");
}

#[test]
fn a_motion_left_free_is_reported() {
    // Undriven, one link on one pin.
    let r = build(json!([
        {"id": "g", "type": "box", "length": 4, "width": 4, "height": 2},
        {"id": "l", "type": "box", "length": 14, "width": 4, "height": 2},
        {"id": "m", "type": "mechanism", "ground": "body1",
         "joints": [pin("one", "body2", "body1", DVec2::ZERO)]},
    ]));
    ok(&r);
    assert_eq!(
        advice(&r),
        ["mechanism: no drive, the joints were closed as modelled and 1 motion is left free, body2 can still move"]
    );
    // Driven, a fifth link on its own pin still swings.
    let extra = link("x", "body5", 8.0, DVec2::new(0.0, -20.0), DVec2::new(8.0, -20.0));
    let r = build(four_bar(45.0, true, &extra, &[pin("p5", "body5", "body1", DVec2::new(0.0, -20.0))]));
    ok(&r);
    four_bar_at(&r, 45.0, true);
    assert_eq!(advice(&r), ["mechanism: 1 motion is left free besides the drive, body5 can still move"]);
}

#[test]
fn a_free_slide_names_every_part_it_moves() {
    // Undriven, the slide also turns the crank and swings the rod.
    let mut doc = slider_crank("crank", "angle", 60.0);
    let m = doc.as_array_mut().unwrap().last_mut().unwrap().as_object_mut().unwrap();
    m.remove("drive");
    m.remove("angle");
    let r = build(doc);
    ok(&r);
    assert_eq!(
        advice(&r),
        ["mechanism: no drive, the joints were closed as modelled and 1 motion is left free, body2, body3 and body4 can still move"]
    );
}

#[test]
fn a_ground_no_joint_holds_is_refused() {
    let mut doc = slider_crank("crank", "angle", 90.0);
    doc.as_array_mut().unwrap().insert(0, json!({"id": "x", "type": "box", "length": 2, "width": 2, "height": 2}));
    // The new box takes body1, so every body id shifts up by one.
    let text = doc.to_string().replace("body4", "body5").replace("body3", "body4").replace("body2", "body3").replace("body1", "body2");
    let mut doc: Value = serde_json::from_str(&text).unwrap();
    doc.as_array_mut().unwrap().last_mut().unwrap()["ground"] = json!("body1");
    let r = build(doc);
    assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
    assert!(
        r.errors[0].message.contains("no joint holds the ground body1"),
        "{}",
        r.errors[0].message
    );
}

#[test]
fn a_rigid_weld_carries_its_body_along() {
    let extra = link("w", "body5", 6.0, DVec2::new(2.0, 5.0), DVec2::new(8.0, 5.0));
    let weld = json!({"id": "weld", "mode": "rigid",
        "a": {"body": "body5", "origin": [5, 5, 0]}, "b": {"body": "body2", "origin": [5, 0, 0]}});
    let r = build(four_bar(90.0, true, &extra, &[weld]));
    ok(&r);
    four_bar_at(&r, 90.0, true);
    // (5, 5) turned a quarter about the crank's pin.
    assert_at(&r, "body5", DVec3::new(-5.0, 5.0, 0.0));
    assert!(advice(&r).is_empty(), "{:?}", advice(&r));
}

#[test]
fn a_pin_on_a_slanted_axis_turns_in_space() {
    // A third of a turn about (1, 1, 1) sends x to y.
    let r = build(json!([
        {"id": "g", "type": "box", "length": 4, "width": 4, "height": 4},
        {"id": "l", "type": "box", "length": 4, "width": 2, "height": 2},
        {"id": "lm", "type": "move", "bodies": ["body2"], "dx": 10},
        {"id": "m", "type": "mechanism", "ground": "body1", "drive": "pin", "angle": 120,
         "joints": [{"id": "pin", "mode": "revolute",
            "a": {"body": "body2", "origin": [0, 0, 0], "zdir": [1, 1, 1]},
            "b": {"body": "body1", "origin": [0, 0, 0], "zdir": [1, 1, 1]}}]},
    ]));
    ok(&r);
    assert_at(&r, "body2", DVec3::new(0.0, 10.0, 0.0));
}

#[test]
fn axis_connectors_find_a_pin_and_a_round_edge() {
    // The arm turns on the ground's round pin, picked by its cylindrical
    // face; a stud welded at its tip is picked by its top circle.
    let r = build(json!([
        {"id": "g", "type": "cylinder", "radius": 2, "height": 10},
        {"id": "a", "type": "box", "length": 30, "width": 4, "height": 4},
        {"id": "am", "type": "move", "bodies": ["body2"], "dx": 15},
        {"id": "s", "type": "cylinder", "radius": 1.5, "height": 4},
        {"id": "sm", "type": "move", "bodies": ["body3"], "dx": 30, "dz": 4},
        {"id": "m", "type": "mechanism", "ground": "body1", "drive": "pin", "angle": 90, "joints": [
            {"id": "pin", "mode": "revolute",
             "a": {"body": "body2", "origin": [0, 0, 0], "zdir": [0, 0, 1]},
             "b": {"axis": {"kind": "face", "by": "nearest", "point": [2, 0, 0], "body": "body1"}}},
            {"id": "stud", "mode": "rigid",
             "a": {"axis": {"kind": "edge", "by": "nearest", "point": [31.5, 0, 6], "body": "body3"}},
             "b": {"body": "body2", "origin": [30, 0, 2]}},
        ]},
    ]));
    ok(&r);
    // The pin's axis through the middle of its face, pointing up.
    let mark = &r.datum_marks["m"];
    let v = |k: &str| DVec3::from_array(serde_json::from_value::<[f64; 3]>(mark[k].clone()).unwrap());
    assert!(v("origin").length() < 1e-9 && (v("dir") - DVec3::Z).length() < 1e-9, "{mark}");
    assert_eq!(mark["value"], json!(90.0));
    assert_at(&r, "body2", DVec3::new(0.0, 15.0, 0.0));
    assert_at(&r, "body3", DVec3::new(0.0, 30.0, 4.0));
}

#[test]
fn moved_faces_keep_their_owners() {
    // At a general angle the moved centres land anywhere in their 0.1 mm
    // bins, so the remap must not round them twice.
    for angle in [77.0, 90.0, 211.0] {
        let r = build(four_bar(angle, true, &[], &[]));
        ok(&r);
        for (body, owner) in [("body2", "c"), ("body3", "k"), ("body4", "r")] {
            let b = r.bodies.iter().find(|b| b.id == body).unwrap();
            assert_eq!(b.owners.len(), 6);
            assert!(b.owners.values().all(|o| o == owner), "{angle} {body} {:?}", b.owners);
        }
    }
}

/// The crank-rocker driven at the rocker's ground pin instead, with `zero`
/// the angle the pin reads as modelled (both sides then carry an x), or no x
/// at all.
fn rocker_driven(angle: f64, zero: Option<f64>) -> Value {
    let mut f = four_bar(0.0, true, &[], &[]);
    let o4 = DVec2::new(GROUND, 0.0);
    let b = meet(DVec2::new(CRANK, 0.0), COUPLER, o4, ROCKER, true);
    let m = f.as_array_mut().unwrap().last_mut().unwrap();
    m["drive"] = json!("p3");
    m["angle"] = json!(angle);
    if let Some(zero) = zero {
        let phi = (b - o4).y.atan2((b - o4).x).to_degrees();
        let (xa, xb) = (polar(1.0, phi), polar(1.0, phi - zero));
        m["joints"][3]["a"]["xdir"] = json!([xa.x, xa.y, 0.0]);
        m["joints"][3]["b"]["xdir"] = json!([xb.x, xb.y, 0.0]);
    }
    f
}

/// Where the crank-rocker is with its rocker turned `turn` degrees from as
/// modelled, the crank on the side of the rocker's tip it was modelled on.
fn rocker_at(r: &Rebuild, turn: f64) {
    let o4 = DVec2::new(GROUND, 0.0);
    let a0 = DVec2::new(CRANK, 0.0);
    let b0 = meet(a0, COUPLER, o4, ROCKER, true);
    let phi = (b0 - o4).y.atan2((b0 - o4).x).to_degrees();
    let b = o4 + polar(ROCKER, phi + turn);
    let up = b0.perp_dot(a0) > 0.0;
    let a = meet(DVec2::ZERO, CRANK, b, COUPLER, up);
    assert_at(r, "body2", flat(a / 2.0));
    assert_at(r, "body3", flat((a + b) / 2.0));
    assert_at(r, "body4", flat((o4 + b) / 2.0));
}

#[test]
fn a_rocker_holds_its_modelled_angle_past_a_half_turn() {
    // The rocker swings about 40 degrees, so it cannot walk a whole turn to
    // reach the representative it reads as.
    let r = build(rocker_driven(200.0, Some(200.0)));
    ok(&r);
    rocker_at(&r, 0.0);
    let r = build(rocker_driven(195.0, Some(200.0)));
    ok(&r);
    rocker_at(&r, -5.0);
}

#[test]
fn a_rocker_angle_a_whole_turn_on_is_the_same_pose() {
    for angle in [-5.0, 355.0, -365.0] {
        let r = build(rocker_driven(angle, None));
        ok(&r);
        rocker_at(&r, -5.0);
    }
}

#[test]
fn a_rocker_driven_past_its_swing_locks() {
    let r = build(rocker_driven(120.0, None));
    assert_eq!(r.errors.len(), 1, "{:?}", r.errors);
    let msg = &r.errors[0].message;
    let head = "mechanism: the linkage cannot reach angle 120 deg on p3, it locks near ";
    assert!(msg.starts_with(head), "{msg}");
    let near: f64 = msg[head.len()..].split(' ').next().unwrap().parse().unwrap();
    assert!((near - 32.7).abs() < 0.2, "{msg}");
    // A gap is named only when it is more than noise, and never as 1e-07.
    if let Some((_, gap)) = msg.split_once(" stays ") {
        let gap = gap.trim_end_matches(" mm apart");
        assert!(gap.parse::<f64>().is_ok_and(|g| g >= 1e-3), "{msg}");
    }
    rocker_at(&r, 0.0);
}

#[test]
fn coaxial_pins_read_zero_whatever_the_noise_in_their_axes() {
    // Ground and arm are the same pin placed by turns that differ by a whole
    // turn, so their axes agree only to rounding; angle 0 must move nothing.
    let point = kernel::euler_point([90.0, 0.0, 45.0], [0.0; 3], [2.0, 0.0, 1.0]);
    let face = |body: &str| json!({"axis": {"kind": "face", "by": "nearest", "point": point, "body": body}});
    let r = build(json!([
        {"id": "g", "type": "cylinder", "radius": 2, "height": 10},
        {"id": "gm", "type": "move", "bodies": ["body1"], "rx": 90, "rz": 45},
        {"id": "a", "type": "cylinder", "radius": 2, "height": 10},
        {"id": "am", "type": "move", "bodies": ["body2"], "rx": 90, "rz": 405},
        {"id": "w", "type": "box", "length": 4, "width": 4, "height": 4},
        {"id": "wm", "type": "move", "bodies": ["body3"], "dz": 20},
        {"id": "m", "type": "mechanism", "ground": "body1", "drive": "pin", "angle": 0, "joints": [
            {"id": "pin", "mode": "revolute", "a": face("body2"), "b": face("body1")},
            {"id": "weld", "mode": "rigid",
             "a": {"body": "body3", "origin": [0, 0, 20]}, "b": {"body": "body2", "origin": [0, 0, 20]}},
        ]},
    ]));
    ok(&r);
    assert_at(&r, "body3", DVec3::new(0.0, 0.0, 20.0));
}

#[test]
fn a_rigid_move_keeps_the_geometry_and_places_it() {
    let s = kernel::make_box(4.0, 2.0, 2.0).unwrap();
    let s = kernel::translated(&s, [5.0, 0.0, 0.0]).unwrap();
    // A quarter turn about z, then up 3.
    let moved = kernel::rigid_moved(&s, [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 3.0]).unwrap();
    let c = kernel::center_of_mass(&moved).unwrap();
    assert!((DVec3::from_array(c) - DVec3::new(0.0, 5.0, 3.0)).length() < 1e-9, "{c:?}");
    assert!((kernel::volume(&moved) - 16.0).abs() < 1e-9);
}

#[test]
fn a_joint_without_a_body_is_named() {
    let r = build(json!([
        {"id": "g", "type": "box", "length": 4, "width": 4, "height": 2},
        {"id": "l", "type": "box", "length": 14, "width": 4, "height": 2},
        {"id": "m", "type": "mechanism", "ground": "body1", "joints": [
            {"id": "pin2", "mode": "revolute", "a": {"origin": [0, 0, 0]}, "b": {"body": "body1", "origin": [0, 0, 0]}},
        ]},
    ]));
    assert_eq!(r.errors.len(), 1);
    assert_eq!(r.errors[0].message, "mechanism: joints[pin2].a has no body");
    let r = build(json!([
        {"id": "g", "type": "box", "length": 4, "width": 4, "height": 2},
        {"id": "m", "type": "mechanism", "ground": "body1", "joints": [
            {"id": "pin2", "mode": "revolute", "a": {"body": "body9", "origin": [0, 0, 0]}, "b": {"body": "body1", "origin": [0, 0, 0]}},
        ]},
    ]));
    assert_eq!(r.errors[0].message, "mechanism: joints[pin2].a is on body9, which is missing or was consumed");
}
