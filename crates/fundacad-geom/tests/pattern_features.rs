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
