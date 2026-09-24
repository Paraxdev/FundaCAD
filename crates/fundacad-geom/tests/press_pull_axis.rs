//! Press/pull with `direction: "axis"` moves a hole's end along the hole, so
//! the wall lengthens and the end keeps its shape.
//!
//! The spike is press_pull_split.rs's: a thin revolved spike with a 2 mm pin
//! channel up its axis, capped by a 45 degree cone whose apex is at z 22.5.

use std::f64::consts::PI;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::features::axis_push::{face_axis_result, hole_axis};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use fundacad_geom::select::Resolver;
use fundacad_protocol::JobResult;
use opencascade::primitives::Shape;
use serde_json::{json, Value};

const CEILING: [f64; 3] = [0.3536, 0.3536, 22.0];

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

fn polygon(pts: &[[f64; 2]]) -> Vec<Value> {
    (0..pts.len())
        .map(|i| line(&format!("l{i}"), pts[i], pts[(i + 1) % pts.len()]))
        .collect()
}

/// A profile on XZ spun about Z, then `cut` spun and cut from it.
fn turned(outer: &[[f64; 2]], cut: &[[f64; 2]], push: Option<Value>) -> Value {
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XZ", "entities": polygon(outer)}),
        json!({"id": "part", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"}),
    ];
    if !cut.is_empty() {
        features.push(json!({"id": "hole_sk", "type": "sketch", "plane": "XZ", "entities": polygon(cut)}));
        features.push(json!({"id": "hole", "type": "revolve", "sketch": "hole_sk", "axis": "Z", "angle": 360,
                             "operation": "cut", "targets": ["body1"]}));
    }
    features.extend(push);
    json!({"parameters": {"deeper": -5.85}, "features": features})
}

fn spike(push: Option<Value>) -> Value {
    let flank = [
        [18.0, 2.0], [15.6, 5.2], [12.3, 7.5], [9.2, 10.5], [6.8, 14.0], [5.0, 17.6],
        [3.7, 21.2], [2.7, 24.8], [1.95, 27.9], [1.4038, 30.5],
    ];
    let entities = vec![
        line("floor", [0.0, 0.0], [60.0, 0.0]),
        line("rim", [60.0, 0.0], [60.0, 2.0]),
        line("foot", [60.0, 2.0], [18.0, 2.0]),
        json!({"type": "spline", "id": "flank",
               "points": flank.iter().map(|p| json!({"x": p[0], "y": p[1]})).collect::<Vec<_>>()}),
        line("cone", [1.4038, 30.5], [0.4688, 34.25]),
        line("tip", [0.4688, 34.25], [0.0, 34.25]),
        line("axis", [0.0, 34.25], [0.0, 0.0]),
    ];
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XZ", "entities": entities}),
        json!({"id": "spike", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"}),
        json!({"id": "pin_sk", "type": "sketch", "plane": "XZ",
               "entities": polygon(&[[0.0, 0.0], [1.0, 0.0], [1.0, 21.5], [0.0, 22.5]])}),
        json!({"id": "pin", "type": "revolve", "sketch": "pin_sk", "axis": "Z", "angle": 360,
               "operation": "cut", "targets": ["body1"]}),
    ];
    features.extend(push);
    json!({"parameters": {"deeper": -5.85}, "features": features})
}

fn push(point: [f64; 3], distance: Value, direction: Option<&str>) -> Option<Value> {
    let mut f = json!({"id": "push", "type": "press-pull",
        "face": {"kind": "face", "by": "nearest", "point": point, "body": "body1"},
        "distance": distance, "operation": "cut", "body": "body1"});
    if let Some(d) = direction {
        f["direction"] = json!(d);
    }
    Some(f)
}

fn build(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn built(raw: &Value) -> Shape {
    let r = build(raw);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.bodies.len(), 1);
    r.bodies[0].shape.clone()
}

fn reasons(r: &Rebuild, feature: &str) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d["feature_id"] == feature)
        .filter_map(|d| d["reason"].as_str().map(str::to_owned))
        .collect()
}

/// What is in `a` and not in `b`: its volume and box, a void box all zeros.
fn difference(a: &Shape, b: &Shape) -> (f64, [f64; 6]) {
    let gone = kernel::boolean_op(a, &[b], BoolKind::Cut).expect("cut");
    (kernel::volume(&gone), kernel::bbox(&gone).unwrap_or([0.0; 6]))
}

fn close(got: [f64; 6], want: [f64; 6]) -> bool {
    got.iter().zip(want).all(|(g, w)| (g - w).abs() < 1e-3)
}

fn face_at(shape: &Shape, point: [f64; 3]) -> Shape {
    Resolver::new(None, None)
        .faces(shape, &json!({"kind": "face", "by": "nearest", "point": point}))
        .expect("resolves")
        .remove(0)
}

#[test]
fn an_axis_push_deepens_the_channel_and_keeps_its_ceiling() {
    let before = built(&spike(None));
    let r = build(&spike(push(CEILING, json!("deeper"), Some("axis"))));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let after = &r.bodies[0].shape;
    assert_eq!(kernel::count(after, Kind::Solid), 1);
    assert!(reasons(&r, "push").is_empty(), "{:?}", reasons(&r, "push"));

    let (removed, bbox) = difference(&before, after);
    let want = PI * 5.85;
    assert!((removed - want).abs() < 1e-4 * want, "removed {removed}, a 2 mm channel 5.85 longer is {want}");
    // The channel's radius is unchanged and the apex rises by exactly 5.85.
    assert!(close(bbox, [-1.0, -1.0, 21.5, 1.0, 1.0, 28.35]), "{bbox:?}");
    let (added, _) = difference(after, &before);
    assert!(added < 1e-6, "{added}");
    // The wall grew rather than gaining a second face above the old one.
    assert_eq!(kernel::count(after, Kind::Face), kernel::count(&before, Kind::Face));
}

#[test]
fn an_axis_pull_makes_the_channel_shallower() {
    let before = built(&spike(None));
    let after = built(&spike(push(CEILING, json!(10), Some("axis"))));
    let (added, bbox) = difference(&after, &before);
    let want = PI * 10.0;
    assert!((added - want).abs() < 1e-4 * want, "added {added}, want {want}");
    assert!(close(bbox, [-1.0, -1.0, 11.5, 1.0, 1.0, 22.5]), "{bbox:?}");
    assert!(difference(&before, &after).0 < 1e-6);
    assert_eq!(kernel::count(&after, Kind::Face), kernel::count(&before, Kind::Face));
}

#[test]
fn an_axis_push_past_the_tip_says_it_broke_through() {
    let r = build(&spike(push(CEILING, json!(-12), Some("axis"))));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let said = reasons(&r, "push");
    assert!(
        said.iter().any(|m| m == "the offset broke through the outside of Body1"),
        "{said:?}"
    );
}

#[test]
fn the_ceiling_is_the_end_of_a_hole() {
    let shape = built(&spike(None));
    let axis = hole_axis(&shape, &face_at(&shape, CEILING)).expect("an axis");
    assert!(axis.hole);
    assert!((axis.dir.z + 1.0).abs() < 1e-9, "{:?}", axis.dir);
    assert!(axis.origin.x.abs() < 1e-9 && axis.origin.y.abs() < 1e-9, "{:?}", axis.origin);
}

#[test]
fn a_flat_bottomed_hole_deepens_along_its_wall() {
    let block = [[0.0, 0.0], [10.0, 0.0], [10.0, 12.0], [0.0, 12.0]];
    let bore = [[0.0, 4.0], [3.0, 4.0], [3.0, 13.0], [0.0, 13.0]];
    let floor = [1.0, 1.0, 4.0];
    let before = built(&turned(&block, &bore, None));
    let axis = hole_axis(&before, &face_at(&before, floor)).expect("an axis");
    assert!(!axis.hole, "a flat end moves the same either way");
    assert!((axis.dir.z - 1.0).abs() < 1e-9, "{:?}", axis.dir);

    let after = built(&turned(&block, &bore, push(floor, json!(-3), Some("axis"))));
    let (removed, bbox) = difference(&before, &after);
    assert!((removed - PI * 27.0).abs() < 1e-3, "{removed}");
    assert!(close(bbox, [-3.0, -3.0, 1.0, 3.0, 3.0, 4.0]), "{bbox:?}");
    assert_eq!(kernel::count(&after, Kind::Face), kernel::count(&before, Kind::Face));
    let normal = built(&turned(&block, &bore, push(floor, json!(-3), None)));
    assert!((kernel::volume(&normal) - kernel::volume(&after)).abs() < 1e-6);
}

#[test]
fn a_drilled_hole_deepens_and_shortens_with_one_wall() {
    let block = [[0.0, 0.0], [10.0, 0.0], [10.0, 12.0], [0.0, 12.0]];
    let drill = [[0.0, -1.0], [2.0, -1.0], [2.0, 6.0], [0.0, 8.0]];
    let tip = [0.7, 0.7, 7.0];
    let before = built(&turned(&block, &drill, None));
    for (d, lo, hi) in [(-2.0, 6.0, 10.0), (2.0, 4.0, 8.0)] {
        let after = built(&turned(&block, &drill, push(tip, json!(d), Some("axis"))));
        let (a, b) = if d < 0.0 { (&before, &after) } else { (&after, &before) };
        let (moved, bbox) = difference(a, b);
        assert!((moved - PI * 4.0 * 2.0).abs() < 1e-3, "{d}: {moved}");
        assert!(close(bbox, [-2.0, -2.0, lo, 2.0, 2.0, hi]), "{d}: {bbox:?}");
        assert_eq!(kernel::count(&after, Kind::Face), kernel::count(&before, Kind::Face), "{d}");
    }
}

#[test]
fn a_domed_hole_end_deepens_along_its_wall() {
    let block = [[0.0, 0.0], [10.0, 0.0], [10.0, 12.0], [0.0, 12.0]];
    let before = {
        let raw = json!({"parameters": {}, "features": [
            {"id": "sk", "type": "sketch", "plane": "XZ", "entities": polygon(&block)},
            {"id": "part", "type": "revolve", "sketch": "sk", "axis": "Z", "angle": 360, "operation": "new"},
            {"id": "dome_sk", "type": "sketch", "plane": "XZ", "entities": [
                line("a", [0.0, 2.0], [0.0, 13.0]), line("b", [0.0, 13.0], [2.0, 13.0]),
                line("c", [2.0, 13.0], [2.0, 4.0]),
                {"type": "arc", "id": "d", "x1": 2.0, "y1": 4.0, "x2": 0.0, "y2": 2.0,
                 "mx": 2f64.sqrt(), "my": 4.0 - 2f64.sqrt()}]},
            {"id": "hole", "type": "revolve", "sketch": "dome_sk", "axis": "Z", "angle": 360,
             "operation": "cut", "targets": ["body1"]},
        ]});
        raw
    };
    let shape = built(&before);
    let cap = [0.5, 0.5, 4.0 - (4.0f64 - 0.5).sqrt()];
    let axis = hole_axis(&shape, &face_at(&shape, cap)).expect("an axis");
    assert!(axis.hole);
    let mut deeper = before.clone();
    deeper["features"].as_array_mut().unwrap().extend(push(cap, json!(-1.5), Some("axis")));
    let after = built(&deeper);
    let (removed, bbox) = difference(&shape, &after);
    assert!((removed - PI * 4.0 * 1.5).abs() < 1e-3, "{removed}");
    assert!(close(bbox, [-2.0, -2.0, 0.5, 2.0, 2.0, 4.0]), "{bbox:?}");
    assert_eq!(kernel::count(&after, Kind::Face), kernel::count(&shape, Kind::Face));
}

#[test]
fn a_chamfer_has_no_axis_to_move_along() {
    let boss = [[0.0, 0.0], [5.0, 0.0], [5.0, 9.0], [4.0, 10.0], [0.0, 10.0]];
    let chamfer = [3.182, 3.182, 9.5];
    let shape = built(&turned(&boss, &[], None));
    assert!(hole_axis(&shape, &face_at(&shape, chamfer)).is_err());
    let r = build(&turned(&boss, &[], push(chamfer, json!(-0.5), Some("axis"))));
    assert_eq!(
        r.errors.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
        ["Press/Pull along the axis: the walls around the face do not all run along one axis"]
    );
}

#[test]
fn a_pocket_with_drafted_walls_has_no_axis_to_move_along() {
    let raw = json!({"parameters": {}, "features": [
        {"id": "block", "type": "box", "length": 30, "width": 30, "height": 20},
        {"id": "sk", "type": "sketch", "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": 0, "y": 0}]},
        {"id": "pocket", "type": "extrude", "sketch": "sk", "distance": -6, "taper": 10,
         "operation": "cut", "targets": ["body1"]},
    ]});
    let shape = built(&raw);
    let floor = face_at(&shape, [0.0, 0.0, 4.0]);
    assert_eq!(
        hole_axis(&shape, &floor),
        Err("the walls around the face do not all run along one axis")
    );
    let straight = json!({"parameters": {}, "features": [
        raw["features"][0], raw["features"][1],
        {"id": "pocket", "type": "extrude", "sketch": "sk", "distance": -6, "operation": "cut", "targets": ["body1"]},
    ]});
    let shape = built(&straight);
    let axis = hole_axis(&shape, &face_at(&shape, [0.0, 0.0, 4.0])).expect("where the flat walls meet");
    assert!((axis.dir.z - 1.0).abs() < 1e-9, "{:?}", axis.dir);
}

#[test]
fn normal_is_what_no_direction_means() {
    let a = built(&spike(push(CEILING, json!(-1), None)));
    let b = built(&spike(push(CEILING, json!(-1), Some("normal"))));
    assert_eq!(kernel::volume(&a), kernel::volume(&b));
}

#[test]
fn an_explicit_cut_mode_sweeps_along_the_axis() {
    let before = built(&spike(None));
    let mut raw = spike(push(CEILING, json!(-2), Some("axis")));
    raw["features"][4]["mode"] = json!("cut");
    let after = built(&raw);
    let (removed, bbox) = difference(&before, &after);
    // Mode cut sweeps the face and cuts: the old cone's volume moves up too.
    assert!((removed - PI * 2.0).abs() < 1e-3, "{removed}");
    assert!(close(bbox, [-1.0, -1.0, 21.5, 1.0, 1.0, 24.5]), "{bbox:?}");
}

#[test]
fn the_face_axis_op_reports_the_hole() {
    let raw = spike(None);
    let req = json!({"document": raw, "body": "body1",
                     "face": {"kind": "face", "by": "nearest", "point": CEILING}});
    let JobResult::Json(got) = face_axis_result(req.as_object().unwrap(), &NoWatch) else {
        panic!("a json reply");
    };
    assert_eq!(got["hole"], json!(true), "{got:?}");
    assert_eq!(got["sameAsNormal"], json!(false), "{got:?}");
    assert_eq!(got["axis"]["dir"], json!([0.0, 0.0, -1.0]), "{got:?}");

    let block = [[0.0, 0.0], [10.0, 0.0], [10.0, 12.0], [0.0, 12.0]];
    let bore = [[0.0, 4.0], [3.0, 4.0], [3.0, 13.0], [0.0, 13.0]];
    let req = json!({"document": turned(&block, &bore, None),
                     "face": {"kind": "face", "by": "nearest", "point": [1.0, 1.0, 4.0]}});
    let JobResult::Json(got) = face_axis_result(req.as_object().unwrap(), &NoWatch) else {
        panic!("a json reply");
    };
    assert_eq!((&got["hole"], &got["sameAsNormal"]), (&json!(false), &json!(true)), "{got:?}");

    let req = json!({"document": raw, "body": "body1",
                     "face": {"kind": "face", "by": "nearest", "point": [30.0, 0.0, 2.0]}});
    let JobResult::Json(got) = face_axis_result(req.as_object().unwrap(), &NoWatch) else {
        panic!("a json reply");
    };
    assert!(got.get("reason").is_some(), "the flank has no axis: {got:?}");
}
