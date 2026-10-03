//! Press/pull and offset face on the round end of a slot: the end keeps its
//! axis and changes radius, the slot's walls are trimmed or extended to meet
//! it, and nothing is left behind as a step, a sliver or a stray face. The
//! document is the c1 report: three pushes on the +Y end of the upper slot,
//! which runs along Y at z = 20 with r 2 ends, cut through a box whose top
//! edge at x = -25 is rounded with a conic profile.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, Kind};
use glam::{dvec3, DVec3};
use opencascade::primitives::{Shape, ShapeType};
use opencascade_sys::face_query as fq;
use opencascade_sys::plugin_ops::po_classify;
use serde_json::{json, Value};

const C1: &str = include_str!("press_pull/c1_slot_end.json");

/// The end's axis runs along X through (y, z).
const AXIS: (f64, f64) = (7.125, 20.0);

fn c1() -> Value {
    serde_json::from_str(C1).expect("the c1 document")
}

/// c1 with every feature after `last` dropped.
fn through(last: &str) -> Value {
    let mut raw = c1();
    let features = raw["features"].as_array_mut().unwrap();
    let at = features.iter().position(|f| f["id"] == last).expect("the feature");
    features.truncate(at + 1);
    raw
}

fn feature<'a>(raw: &'a mut Value, id: &str) -> &'a mut Value {
    raw["features"].as_array_mut().unwrap().iter_mut().find(|f| f["id"] == id).expect("the feature")
}

fn add(mut raw: Value, f: Value) -> Value {
    raw["features"].as_array_mut().unwrap().push(f);
    raw
}

fn rebuild(raw: &Value) -> Rebuild {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    builder::rebuild(&doc, raw, &NoWatch).expect("not cancelled")
}

fn body(raw: &Value) -> Shape {
    let r = rebuild(raw);
    let errors: Vec<_> = r.errors.iter().map(|e| (&e.feature_id, &e.message)).collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(r.bodies.len(), 1);
    let shape = r.bodies[0].shape.clone();
    assert!(shape.is_valid().unwrap_or(false), "a valid body");
    assert_eq!(kernel::count(&shape, Kind::Solid), 1);
    shape
}

fn faces(body: &Shape) -> Vec<Shape> {
    body.shape_map(ShapeType::Face).iter().collect()
}

/// (kind, direction, location, radius) as the kernel reports the surface.
fn surface(face: &Shape) -> (i32, DVec3, DVec3, f64) {
    let mut o = [0.0; 13];
    let k = fq::FQ_surface(face.raw(), &mut o).unwrap_or(-1);
    (k, dvec3(o[1], o[2], o[3]), dvec3(o[4], o[5], o[6]), o[7])
}

/// The radius of every cylinder face on the slot end's axis, to 1e-9.
fn end_radii(body: &Shape) -> Vec<f64> {
    faces(body)
        .iter()
        .map(surface)
        .filter(|(k, d, l, _)| *k == 1 && d.cross(DVec3::X).length() < 1e-9 && (l.y - AXIS.0).hypot(l.z - AXIS.1) < 1e-6)
        .map(|(_, _, _, r)| (r * 1e9).round() / 1e9)
        .collect()
}

/// A flat face square to the slot through the end's axis: the radial wall a
/// step leaves where an old and a new radius meet.
fn radial_walls(body: &Shape) -> usize {
    faces(body)
        .iter()
        .filter(|f| {
            let (k, n, l, _) = surface(f);
            let b = kernel::bbox(f).unwrap();
            k == 0 && n.cross(DVec3::Y).length() < 1e-9 && (l.y - AXIS.0).abs() < 1e-6 && b[5] > 17.0 && b[2] < 23.0
        })
        .count()
}

fn inside(body: &Shape, p: DVec3) -> bool {
    po_classify(body.raw(), p.x, p.y, p.z, 1e-7) == 0
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

fn code_of(raw: &Value, id: &str) -> (Option<String>, String) {
    let r = rebuild(raw);
    let e = r.errors.iter().find(|e| e.feature_id.as_deref() == Some(id)).expect("the feature failed");
    (e.code.clone(), e.message.clone())
}

#[test]
fn growing_the_slot_end_leaves_one_round_face_and_no_step() {
    let b = body(&through("f6"));
    let v = kernel::volume(&b);
    assert!(close(v, 50937.978, 1e-2), "{v}");
    assert_eq!(faces(&b).len(), 21);
    assert_eq!(end_radii(&b), vec![2.65]);
    assert_eq!(radial_walls(&b), 0);
}

#[test]
fn growing_it_again_grows_the_same_round_face() {
    let b = body(&through("f7"));
    let v = kernel::volume(&b);
    assert!(close(v, 50433.97, 0.05), "{v}");
    assert_eq!(end_radii(&b), vec![3.35]);
    assert_eq!(radial_walls(&b), 0);
}

#[test]
fn shrinking_the_bulged_end_back_leaves_nothing_of_the_bigger_ones() {
    let b = body(&c1());
    let v = kernel::volume(&b);
    assert!(close(v, 50967.729, 1e-3), "{v}");
    assert_eq!(faces(&b).len(), 21);
    assert_eq!(end_radii(&b), vec![2.6]);
    assert_eq!(radial_walls(&b), 0);
    for x in [-24.0, 0.0] {
        for deg in [-60.0f64, -30.0, 0.0, 30.0, 60.0] {
            let along = dvec3(0.0, deg.to_radians().cos(), deg.to_radians().sin());
            let at = |r: f64| dvec3(x, AXIS.0, AXIS.1) + along * r;
            assert!(!inside(&b, at(2.55)), "material inside the end at x {x}, {deg} degrees");
            assert!(inside(&b, at(2.65)), "a void past the end at x {x}, {deg} degrees");
        }
    }
}

#[test]
fn three_pushes_equal_one_push_of_their_sum() {
    let three = body(&c1());
    let mut raw = through("f6");
    feature(&mut raw, "f6")["distance"] = json!(-0.6);
    let one = body(&raw);
    assert!(close(kernel::volume(&three), kernel::volume(&one), 1e-3), "{} against {}", kernel::volume(&three), kernel::volume(&one));
    assert_eq!(faces(&three).len(), faces(&one).len());
}

/// c1 up to the cut, its upper slot drawn `w` wide.
fn slot_drawn(w: f64) -> Shape {
    let mut raw = through("f5");
    let sketch = feature(&mut raw, "f4");
    let slot = sketch["entities"].as_array_mut().unwrap().iter_mut().find(|e| e["id"] == "e4").unwrap();
    slot["width"] = json!(w);
    body(&raw)
}

#[test]
fn shrinking_the_slot_end_narrows_the_whole_slot() {
    let mut raw = through("f6");
    feature(&mut raw, "f6")["distance"] = json!(0.5);
    let b = body(&raw);
    let want = slot_drawn(3.0);
    let (v, w) = (kernel::volume_precise(&b), kernel::volume_precise(&want));
    assert!(close(v, w, 1e-3), "{v} against {w}");
    assert_eq!(faces(&b).len(), faces(&want).len());
    assert_eq!(end_radii(&b), vec![1.5]);
    assert_eq!(radial_walls(&b), 0);
}

#[test]
fn shrinking_the_slot_end_with_tangent_faces_kept_is_refused() {
    let mut raw = through("f6");
    let f6 = feature(&mut raw, "f6");
    f6["distance"] = json!(0.5);
    f6["followTangent"] = json!(false);
    let (code, message) = code_of(&raw, "f6");
    assert_eq!(code.as_deref(), Some("tangentLost"), "{message}");
    assert!(message.contains("2 flat faces") && message.contains("Tangent faces follow"), "{message}");
}

#[test]
fn a_slot_end_grown_past_the_whole_body_says_so_under_both_features() {
    let mut pushed = through("f6");
    feature(&mut pushed, "f6")["distance"] = json!(-100);
    let f6 = c1()["features"][5].clone();
    let offset = add(
        through("f5"),
        json!({"id": "f6", "type": "offsetFace", "faces": f6["face"], "distance": -100, "body": "body1"}),
    );
    for raw in [&pushed, &offset] {
        let (code, message) = code_of(raw, "f6");
        assert_eq!(code.as_deref(), Some("pastBody"), "{message}");
        assert!(message.contains("runs past the whole body") && message.contains("smaller radius"), "{message}");
    }
}

const SLOT_FACES: [[f64; 3]; 4] = [[0.0, 9.125, 20.0], [0.0, -16.875, 20.0], [0.0, 0.0, 18.0], [0.0, 0.0, 22.0]];

#[test]
fn every_face_of_the_slot_selected_widens_it_once() {
    let picks: Vec<Value> = SLOT_FACES.iter().map(|p| json!({"kind": "face", "by": "nearest", "point": p})).collect();
    let raw = add(
        through("f5"),
        json!({"id": "all", "type": "press-pull", "face": picks, "distance": -0.5, "body": "body1"}),
    );
    let b = body(&raw);
    let want = slot_drawn(5.0);
    assert!(close(kernel::volume(&b), kernel::volume(&want), 1e-3), "{} against {}", kernel::volume(&b), kernel::volume(&want));
    assert_eq!(faces(&b).len(), faces(&want).len());
    assert_eq!(end_radii(&b), vec![2.5]);
}

#[test]
fn offset_face_on_the_slot_end_equals_the_press_pull() {
    let pushed = body(&through("f6"));
    let f6 = c1()["features"][5].clone();
    let raw = add(
        through("f5"),
        json!({"id": "off", "type": "offsetFace", "faces": f6["face"], "distance": -0.65, "body": "body1"}),
    );
    let b = body(&raw);
    assert!(close(kernel::volume(&b), kernel::volume(&pushed), 1e-3), "{} against {}", kernel::volume(&b), kernel::volume(&pushed));
    assert!(close(kernel::volume(&b), 50937.978, 1e-2), "{}", kernel::volume(&b));
    assert_eq!(faces(&b).len(), faces(&pushed).len());
    assert_eq!(end_radii(&b), vec![2.65]);
    assert_eq!(radial_walls(&b), 0);
}

#[test]
fn offset_face_with_tangent_faces_kept_is_refused_too() {
    let f6 = c1()["features"][5].clone();
    let raw = add(
        through("f5"),
        json!({"id": "off", "type": "offsetFace", "faces": f6["face"], "distance": 0.5, "body": "body1", "followTangent": false}),
    );
    let (code, message) = code_of(&raw, "off");
    assert_eq!(code.as_deref(), Some("tangentLost"), "{message}");
}

#[test]
fn follow_tangent_is_a_field_the_build_reads() {
    let mut raw = through("f6");
    feature(&mut raw, "f6")["followTangent"] = json!(true);
    let r = rebuild(&raw);
    assert!(r.errors.is_empty());
    assert!(!r.diagnostics.iter().any(|d| d["kind"] == "unreadFields"), "{:?}", r.diagnostics);
}

#[test]
fn a_slot_grown_out_through_the_top_says_so_under_both_features() {
    let picks: Vec<Value> = SLOT_FACES.iter().map(|p| json!({"kind": "face", "by": "nearest", "point": p})).collect();
    let pushed = add(
        through("f5"),
        json!({"id": "grow", "type": "press-pull", "face": picks, "distance": -3, "body": "body1"}),
    );
    let offset = add(
        through("f5"),
        json!({"id": "grow", "type": "offsetFace", "faces": picks, "distance": -3, "body": "body1"}),
    );
    for raw in [&pushed, &offset] {
        let r = rebuild(raw);
        assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
        let said: Vec<_> = r.diagnostics.iter().filter(|d| d["feature_id"] == "grow").map(|d| d["reason"].clone()).collect();
        assert!(said.iter().any(|m| m == "the offset broke through the outside of Body1"), "{said:?}");
    }
    assert!(close(kernel::volume(&body(&pushed)), kernel::volume(&body(&offset)), 1e-3));
}
