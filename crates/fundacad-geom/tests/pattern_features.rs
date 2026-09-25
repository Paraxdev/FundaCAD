//! A pattern with `features` repeats the cut or join those features made
//! instead of copying a whole body.

use std::f64::consts::PI;
use std::time::Duration;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoTap, NoWatch, Rebuild, Snapshot, State, Tap};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

const BOX: f64 = 80.0 * 80.0 * 10.0;

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn errors(r: &Rebuild) -> Vec<String> {
    r.errors.iter().map(|e| e.message.clone()).collect()
}

fn only_body(r: &Rebuild) -> &builder::BuiltBody {
    assert!(r.errors.is_empty(), "errors: {:?}", errors(r));
    assert_eq!(r.bodies.len(), 1, "one body");
    &r.bodies[0]
}

fn volume_of(raw: &Value) -> f64 {
    let r = build(raw);
    kernel::volume(&only_body(&r).shape)
}

fn close(got: f64, want: f64) {
    assert!((got - want).abs() < 1e-6 * want, "volume {got}, want {want}");
}

/// An 80 x 80 x 10 box (z -5..5) with one 6 mm through hole at `at` on top.
fn holed(at: [f64; 2], pattern: Option<Value>) -> Value {
    let mut features = vec![
        json!({"id": "b", "type": "box", "length": 80, "width": 80, "height": 10}),
        json!({"id": "h", "type": "hole", "diameter": 6, "extent": "through",
               "face": {"kind": "face", "by": "nearest", "point": [at[0], at[1], 5], "body": "body1"},
               "points": [[at[0], at[1], 5]]}),
    ];
    features.extend(pattern);
    json!({"parameters": {"n": 6}, "features": features})
}

fn hole_vol() -> f64 {
    PI * 9.0 * 10.0
}

fn top_sketch(id: &str, entity: Value) -> Value {
    json!({"id": id, "type": "sketch",
           "plane": {"origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
           "entities": [entity]})
}

#[test]
fn a_hole_repeats_six_times_around_z() {
    let pc = json!({"id": "pc", "type": "patternCircular", "count": "n", "angle": 360,
                    "axis": "Z", "features": ["h"]});
    let r = build(&holed([25.0, 0.0], Some(pc)));
    let b = only_body(&r);
    assert_eq!(kernel::count(&b.shape, Kind::Solid), 1);
    close(kernel::volume(&b.shape), BOX - 6.0 * hole_vol());
    let round = kernel::subshapes(&b.shape, Kind::Face)
        .iter()
        .filter(|f| !kernel::face_is_planar(f))
        .count();
    assert!(round >= 6, "six hole walls, got {round}");
}

#[test]
fn the_count_follows_its_parameter() {
    let pc = json!({"id": "pc", "type": "patternCircular", "count": "n", "angle": 360,
                    "axis": "Z", "features": ["h"]});
    let mut doc = holed([25.0, 0.0], Some(pc));
    doc["parameters"]["n"] = json!(4);
    close(volume_of(&doc), BOX - 4.0 * hole_vol());
}

#[test]
fn an_extrude_cut_repeats_along_x() {
    let doc = json!({"features": [
        {"id": "b", "type": "box", "length": 80, "width": 80, "height": 10},
        top_sketch("s", json!({"type": "rectangle", "width": 4, "height": 4, "x": -30, "y": 0, "angle": 0})),
        {"id": "pocket", "type": "extrude", "sketch": "s", "distance": -3, "operation": "cut"},
        {"id": "pl", "type": "patternLinear", "count": 4, "spacing": 20, "axis": "X", "features": ["pocket"]},
    ]});
    close(volume_of(&doc), BOX - 4.0 * 48.0);
}

#[test]
fn a_join_repeats_as_bosses() {
    let doc = json!({"features": [
        {"id": "b", "type": "box", "length": 80, "width": 80, "height": 10},
        top_sketch("s", json!({"type": "circle", "radius": 3, "x": 25, "y": 0})),
        {"id": "boss", "type": "extrude", "sketch": "s", "distance": 5, "operation": "join"},
        {"id": "pc", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z", "features": ["boss"]},
    ]});
    let r = build(&doc);
    let b = only_body(&r);
    assert_eq!(kernel::count(&b.shape, Kind::Solid), 1);
    let boss = PI * 9.0 * 5.0;
    let v = kernel::volume(&b.shape);
    assert!((v - (BOX + 4.0 * boss)).abs() < 1e-3 * boss, "volume {v}");
}

#[test]
fn a_fillet_is_refused_by_name() {
    let doc = json!({"features": [
        {"id": "b", "type": "box", "length": 80, "width": 80, "height": 10},
        {"id": "f", "type": "fillet", "name": "Round1", "radius": 1,
         "edges": [{"kind": "edge", "by": "nearest", "point": [40, 40, 0], "body": "body1"}]},
        {"id": "pc", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z", "features": ["f"]},
    ]});
    let r = build(&doc);
    let e = errors(&r);
    assert_eq!(e.len(), 1, "{e:?}");
    assert!(e[0].contains("Round1") && e[0].contains("cannot be patterned"), "{}", e[0]);
    assert!(e[0].contains("a hole"), "says what can be: {}", e[0]);
    assert_eq!(r.errors[0].feature_id.as_deref(), Some("pc"));
}

#[test]
fn a_feature_below_the_pattern_is_refused() {
    let pc = json!({"id": "pc", "type": "patternCircular", "count": 3, "angle": 360,
                    "axis": "Z", "features": ["h"]});
    let mut doc = holed([25.0, 0.0], None);
    doc["features"].as_array_mut().unwrap().insert(1, pc);
    let e = errors(&build(&doc));
    assert!(e.iter().any(|m| m.contains("comes after this pattern")), "{e:?}");
}

#[test]
fn copies_off_the_body_are_skipped() {
    let pl = json!({"id": "pl", "type": "patternLinear", "count": 5, "spacing": 25,
                    "axis": "X", "features": ["h"]});
    let r = build(&holed([-30.0, 0.0], Some(pl)));
    close(kernel::volume(&only_body(&r).shape), BOX - 3.0 * hole_vol());
}

#[test]
fn bodies_and_features_together_are_refused() {
    let pc = json!({"id": "pc", "type": "patternCircular", "count": 3, "angle": 360,
                    "axis": "Z", "features": ["h"], "bodies": ["body1"]});
    let e = errors(&build(&holed([25.0, 0.0], Some(pc))));
    assert!(e.iter().any(|m| m.contains("not both")), "{e:?}");
}

#[test]
fn a_pattern_of_a_pattern_repeats_its_copies() {
    let doc = json!({"features": [
        {"id": "b", "type": "box", "length": 80, "width": 80, "height": 10},
        {"id": "h", "type": "hole", "diameter": 4, "extent": "through",
         "face": {"kind": "face", "by": "nearest", "point": [-30, -30, 5], "body": "body1"},
         "points": [[-30, -30, 5]]},
        {"id": "row", "type": "patternLinear", "count": 3, "spacing": 10, "axis": "X", "features": ["h"]},
        {"id": "grid", "type": "patternLinear", "count": 2, "spacing": 10, "axis": "Y", "features": ["h", "row"]},
    ]});
    let one = PI * 4.0 * 10.0;
    close(volume_of(&doc), BOX - 6.0 * one);
}

struct Keep(usize, Option<Snapshot>);
impl Tap for Keep {
    fn after_feature(&mut self, index: usize, state: &State<'_>, _: Duration) {
        if index == self.0 {
            self.1 = Some(state.snapshot());
        }
    }
}

/// A checkpoint read from disk holds no tools, so resuming past the hole
/// replays from the start rather than losing what the pattern repeats.
#[test]
fn a_resume_without_the_tools_replays() {
    let pc = json!({"id": "pc", "type": "patternCircular", "count": 6, "angle": 360,
                    "axis": "Z", "features": ["h"]});
    let raw = holed([25.0, 0.0], Some(pc));
    let doc: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let mut keep = Keep(1, None);
    builder::rebuild_from(&doc, &raw, &NoWatch, None, &mut keep).unwrap();
    let mut snap = keep.1.expect("a snapshot after the hole");
    assert!(snap.tools.contains_key("h"));
    let kept = builder::rebuild_from(&doc, &raw, &NoWatch, Some((2, snap.clone())), &mut NoTap).unwrap();
    close(kernel::volume(&only_body(&kept).shape), BOX - 6.0 * hole_vol());
    snap.tools.clear();
    let replayed = builder::rebuild_from(&doc, &raw, &NoWatch, Some((2, snap)), &mut NoTap).unwrap();
    close(kernel::volume(&only_body(&replayed).shape), BOX - 6.0 * hole_vol());
}

/// On an L the copy over the missing corner floats free of the body, inside
/// its box, and is left out instead of joining as a separate lump.
#[test]
fn a_join_copy_that_floats_is_left_out() {
    let doc = json!({"features": [
        {"id": "b", "type": "box", "length": 80, "width": 80, "height": 10},
        top_sketch("corner", json!({"type": "rectangle", "width": 40, "height": 40, "x": 20, "y": 20, "angle": 0})),
        {"id": "notch", "type": "extrude", "sketch": "corner", "distance": -10, "operation": "cut"},
        top_sketch("s", json!({"type": "circle", "radius": 3, "x": -25, "y": -25})),
        {"id": "boss", "type": "extrude", "sketch": "s", "distance": 5, "operation": "join"},
        {"id": "pc", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z", "features": ["boss"]},
    ]});
    let r = build(&doc);
    let b = only_body(&r);
    assert_eq!(kernel::count(&b.shape, Kind::Solid), 1);
    let boss = PI * 9.0 * 5.0;
    let v = kernel::volume(&b.shape);
    let want = BOX * 0.75 + 3.0 * boss;
    assert!((v - want).abs() < 1e-3 * boss, "volume {v}, want {want}");
}

/// A 60 x 60 x 10 box drawn from the origin corner (x, y 0..60, z 0..10) with
/// a 10 mm hole through its middle and a 4 mm hole `h` at (45, 30).
fn corner_box(pattern: Value) -> Value {
    json!({"features": [
        {"id": "sk", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 60, "height": 60, "x": 30, "y": 30, "angle": 0}]},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"},
        {"id": "mid", "type": "hole", "diameter": 10, "extent": "through",
         "face": {"kind": "face", "by": "nearest", "point": [30, 30, 10], "body": "body1"},
         "points": [[30, 30, 10]]},
        {"id": "ax", "type": "datumAxis", "origin": [30, 30, 0], "dir": [0, 0, 1]},
        {"id": "h", "type": "hole", "diameter": 4, "extent": "through",
         "face": {"kind": "face", "by": "nearest", "point": [45, 30, 10], "body": "body1"},
         "points": [[45, 30, 10]]},
        pattern,
    ]})
}

const CORNER_BOX: f64 = 60.0 * 60.0 * 10.0;

fn corner_holes(small: f64) -> f64 {
    CORNER_BOX - PI * 25.0 * 10.0 - small * PI * 4.0 * 10.0
}

fn around(axis: Value, axis_ref: Option<Value>) -> Value {
    let mut pc = json!({"id": "pc", "type": "patternCircular", "count": 6, "angle": 360,
                        "axis": axis, "features": ["h"]});
    if let Some(r) = axis_ref {
        pc["axisRef"] = r;
    }
    corner_box(pc)
}

fn notes(r: &Rebuild) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d["feature_id"] == "pc")
        .filter_map(|d| d["reason"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn around_world_z_most_copies_of_an_off_origin_hole_miss_and_say_so() {
    let r = build(&around(json!("Z"), None));
    close(kernel::volume(&only_body(&r).shape), corner_holes(1.0));
    let n = notes(&r);
    assert!(n.iter().any(|m| m.contains("5 of 6 copies miss body1")), "{n:?}");
    assert!(n.iter().any(|m| m.contains("world Z axis")), "{n:?}");
}

#[test]
fn a_hole_turns_about_a_line_through_a_point() {
    let r = build(&around(json!({"origin": [30, 30, 0], "dir": [0, 0, 1]}), None));
    close(kernel::volume(&only_body(&r).shape), corner_holes(6.0));
    assert!(notes(&r).is_empty(), "{:?}", notes(&r));
}

#[test]
fn a_hole_turns_about_a_datum_axis_by_id() {
    let r = build(&around(json!("ax"), None));
    close(kernel::volume(&only_body(&r).shape), corner_holes(6.0));
}

#[test]
fn a_hole_turns_about_a_picked_cylindrical_face() {
    let wall = json!({"kind": "face", "by": "nearest", "point": [35, 30, 5], "body": "body1"});
    let r = build(&around(json!("Z"), Some(wall)));
    close(kernel::volume(&only_body(&r).shape), corner_holes(6.0));
    assert!(notes(&r).is_empty(), "{:?}", notes(&r));
}

#[test]
fn a_hole_turns_about_a_picked_round_edge() {
    let rim = json!({"kind": "edge", "by": "nearest", "point": [35, 30, 10], "body": "body1"});
    close(volume_of(&around(json!("Z"), Some(rim))), corner_holes(6.0));
}

#[test]
fn a_hole_turns_about_the_middle_of_a_picked_flat_face() {
    let top = json!({"kind": "face", "by": "nearest", "point": [10, 10, 10], "body": "body1"});
    close(volume_of(&around(json!("Z"), Some(top))), corner_holes(6.0));
}

/// The corner edge of the pin at (1, 1) is the axis: the six copies land on
/// the plate around it and none on the pin.
#[test]
fn a_hole_turns_about_a_picked_straight_edge_of_another_body() {
    let doc = json!({"features": [
        {"id": "b", "type": "box", "length": 80, "width": 80, "height": 10},
        {"id": "pin", "type": "box", "length": 2, "width": 2, "height": 40},
        {"id": "h", "type": "hole", "diameter": 6, "extent": "through",
         "face": {"kind": "face", "by": "nearest", "point": [26, 1, 5], "body": "body1"},
         "points": [[26, 1, 5]]},
        {"id": "pc", "type": "patternCircular", "count": 6, "angle": 360, "axis": "Z",
         "axisRef": {"kind": "edge", "by": "nearest", "point": [1, 1, 0], "body": "body2"},
         "features": ["h"]},
    ]});
    let r = build(&doc);
    assert!(r.errors.is_empty(), "{:?}", errors(&r));
    let plate = r.bodies.iter().find(|b| b.id == "body1").expect("the plate");
    close(kernel::volume(&plate.shape), BOX - 6.0 * hole_vol());
    let pin = r.bodies.iter().find(|b| b.id == "body2").expect("the pin");
    close(kernel::volume(&pin.shape), 2.0 * 2.0 * 40.0);
}

#[test]
fn an_axis_reference_that_stops_resolving_keeps_the_cached_line_and_says_so() {
    let gone = json!({"kind": "face", "by": "normal", "dir": [0.6, 0.0, 0.8], "body": "body1"});
    let r = build(&around(json!({"origin": [30, 30, 0], "dir": [0, 0, 1]}), Some(gone)));
    close(kernel::volume(&only_body(&r).shape), corner_holes(6.0));
    let n = notes(&r);
    assert!(n.iter().any(|m| m.contains("no longer resolves")), "{n:?}");
}

#[test]
fn an_unknown_axis_name_or_a_datum_below_is_refused() {
    let e = errors(&build(&around(json!("nope"), None)));
    assert!(e.iter().any(|m| m.contains("not X, Y, Z")), "{e:?}");

    let mut doc = around(json!("late"), None);
    doc["features"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "late", "type": "datumAxis", "origin": [30, 30, 0], "dir": [0, 0, 1]}));
    let e = errors(&build(&doc));
    assert!(e.iter().any(|m| m.contains("late") && m.contains("comes after this pattern")), "{e:?}");
}

/// A checkpoint keeps a feature's error while features below it change, so a
/// reference to one added later still reads as out of order.
#[test]
fn a_resumed_rebuild_names_a_later_feature_as_out_of_order() {
    let pl = json!({"id": "pl", "type": "patternLinear", "count": 3, "spacing": 5, "axis": "Y",
                    "features": ["later"]});
    let mut raw = holed([25.0, 0.0], Some(pl));
    let doc: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let mut keep = Keep(2, None);
    let first = builder::rebuild_from(&doc, &raw, &NoWatch, None, &mut keep).unwrap();
    assert!(errors(&first).iter().any(|m| m.contains("no feature called later")), "{:?}", errors(&first));
    let snap = keep.1.expect("a snapshot after the pattern");
    raw["features"].as_array_mut().unwrap().push(json!({"id": "later", "type": "hole", "diameter": 4,
        "extent": "through", "face": {"kind": "face", "by": "nearest", "point": [-20, -20, 5], "body": "body1"},
        "points": [[-20, -20, 5]]}));
    let doc: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let resumed = builder::rebuild_from(&doc, &raw, &NoWatch, Some((3, snap)), &mut NoTap).unwrap();
    let e = errors(&resumed);
    assert!(e.iter().any(|m| m.contains("later") && m.contains("comes after this pattern")), "{e:?}");
}

#[test]
fn an_extrude_naming_a_later_sketch_says_it_is_out_of_order() {
    let doc = json!({"features": [
        {"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": 5, "operation": "new"},
        {"id": "sk1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": 0, "y": 0}]},
    ]});
    let e = errors(&build(&doc));
    assert!(e.iter().any(|m| m.contains("sk1") && m.contains("comes after this extrude")), "{e:?}");
    let gone = json!({"features": [
        {"id": "ex1", "type": "extrude", "sketch": "sk9", "distance": 5, "operation": "new"},
    ]});
    let e = errors(&build(&gone));
    assert_eq!(e, vec!["the sketch this extrude depends on (sk9) did not build, fix that sketch first".to_owned()]);
}

#[test]
fn a_rect_pattern_repeats_only_the_bodies_it_names() {
    let doc = json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b", "type": "box", "length": 4, "width": 4, "height": 4},
        {"id": "m", "type": "move", "bodies": ["body2"], "dx": 50, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0},
        {"id": "pr", "type": "patternRect", "countX": 2, "countY": 1, "spacingX": 20, "spacingY": 0,
         "bodies": ["body1"]},
    ]});
    let r = build(&doc);
    assert!(r.errors.is_empty(), "{:?}", errors(&r));
    let vol = |id: &str| kernel::volume(&r.bodies.iter().find(|b| b.id == id).expect(id).shape);
    close(vol("body1"), 2000.0);
    close(vol("body2"), 64.0);
}

/// Whole copies of a rounded box turned about the origin overlap into a star
/// or a pinwheel; either way the fused body is one valid solid.
#[test]
fn a_body_pattern_of_overlapping_copies_is_one_valid_solid() {
    for at in [[0.0, 0.0], [20.0, 15.0]] {
        let doc = json!({"features": [
            {"id": "sk", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": 40, "height": 30, "x": at[0], "y": at[1], "angle": 0}]},
            {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"},
            {"id": "f", "type": "fillet", "radius": 4,
             "edges": [{"kind": "edge", "by": "axis", "axis": "Z", "body": "body1"}]},
            {"id": "pc", "type": "patternCircular", "count": 6, "angle": 360, "axis": "Z"},
        ]});
        let r = build(&doc);
        let b = only_body(&r);
        assert!(b.shape.is_valid().unwrap(), "valid at {at:?}");
        assert_eq!(kernel::count(&b.shape, Kind::Solid), 1, "one solid at {at:?}");
    }
}

/// The `patternAxis` op answers the pattern tool's preview with the same line
/// the rebuild turns about.
#[test]
fn the_pattern_axis_op_finds_a_cylinder_axis() {
    use fundacad_geom::features::pattern::pattern_axis_result;
    use fundacad_protocol::JobResult;
    let doc = around(json!("Z"), None);
    let req = json!({"document": doc,
                     "ref": {"kind": "face", "by": "nearest", "point": [35, 30, 5], "body": "body1"}});
    let JobResult::Json(got) = pattern_axis_result(req.as_object().unwrap(), &NoWatch) else {
        panic!("a json reply")
    };
    let o = &got["axis"]["origin"];
    let d = &got["axis"]["dir"];
    assert!((o[0].as_f64().unwrap() - 30.0).abs() < 1e-6 && (o[1].as_f64().unwrap() - 30.0).abs() < 1e-6, "{got:?}");
    assert!((d[2].as_f64().unwrap() - 1.0).abs() < 1e-9, "points up: {got:?}");
    let req = json!({"document": around(json!("Z"), None),
                     "ref": {"kind": "face", "by": "normal", "dir": [0.6, 0.0, 0.8], "body": "body1"}});
    let JobResult::Json(got) = pattern_axis_result(req.as_object().unwrap(), &NoWatch) else {
        panic!("a json reply")
    };
    assert!(got.contains_key("reason"), "{got:?}");
}
