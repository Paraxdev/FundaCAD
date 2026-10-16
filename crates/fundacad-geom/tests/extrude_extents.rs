//! Extrude start and end options, and press/pull up to a face, plane or point,
//! each following the target when an edit upstream moves it.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn build(params: Value, features: Vec<Value>) -> Rebuild {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let doc = json!({ "parameters": params, "features": features });
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled")
}

fn errors(r: &Rebuild) -> Vec<String> {
    r.errors.iter().map(|e| e.message.clone()).collect()
}

fn ok(r: &Rebuild) {
    assert!(r.errors.is_empty(), "errors: {:?}", errors(r));
}

fn err_with(r: &Rebuild, part: &str) {
    assert!(
        errors(r).iter().any(|e| e.contains(part)),
        "wanted an error with {part:?}, got {:?}",
        errors(r)
    );
}

fn bbox(r: &Rebuild, i: usize) -> [f64; 6] {
    kernel::bbox(&r.bodies[i].shape).expect("body has a box")
}

fn vol(r: &Rebuild, i: usize) -> f64 {
    kernel::volume(&r.bodies[i].shape)
}

fn near(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() < 1e-3, "{what}: {a} != {b}");
}

/// A 40x20xh block with its top at z = 5 whatever h is.
fn block() -> Vec<Value> {
    vec![
        json!({"id": "bx", "type": "box", "length": 40, "width": 20, "height": "h"}),
        json!({"id": "mv", "type": "move", "dx": 0, "dy": 0, "dz": "dz", "rx": 0, "ry": 0, "rz": 0, "bodies": ["body1"]}),
    ]
}

fn sketch_at(z: f64) -> Value {
    json!({"id": "sk", "type": "sketch",
           "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
           "entities": [{"type": "rectangle", "id": "r", "width": 4, "height": 30, "x": 0, "y": 0}]})
}

fn small_sketch_at(z: f64) -> Value {
    json!({"id": "sk", "type": "sketch",
           "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
           "entities": [{"type": "rectangle", "id": "r", "width": 4, "height": 6, "x": 0, "y": 0}]})
}

fn extrude(extra: Value) -> Value {
    let mut e = json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": 2, "operation": "new"});
    for (k, v) in extra.as_object().unwrap() {
        e[k] = v.clone();
    }
    e
}

fn bottom_face(z: f64) -> Value {
    json!({"kind": "face", "by": "tracked", "point": [0, 0, z], "normal": [0, 0, -1], "body": "body1"})
}

fn groove(h: f64) -> Rebuild {
    let mut f = block();
    f.push(sketch_at(5.0));
    f.push(extrude(json!({"distance": -3, "operation": "cut", "targets": ["body1"],
        "endType": "upToFace", "upToFace": bottom_face(-5.0), "endOffset": -2})));
    build(json!({"h": h, "dz": 5.0 - h / 2.0}), f)
}

#[test]
fn an_up_to_face_cut_stops_at_the_offset() {
    let r = groove(10.0);
    ok(&r);
    near(vol(&r, 0), 40.0 * 20.0 * 10.0 - 4.0 * 20.0 * 8.0, "volume");
    near(bbox(&r, 0)[2], -5.0, "bottom");
}

#[test]
fn an_up_to_face_follows_an_upstream_edit() {
    for h in [10.0, 30.0] {
        let r = groove(h);
        ok(&r);
        near(vol(&r, 0), 40.0 * 20.0 * h - 4.0 * 20.0 * (h - 2.0), &format!("volume at h {h}"));
        near(bbox(&r, 0)[2], 5.0 - h, &format!("bottom at h {h}"));
    }
}

#[test]
fn a_start_offset_moves_the_prism() {
    let r = build(json!({}), vec![small_sketch_at(0.0), extrude(json!({"startType": "offset", "startOffset": 5}))]);
    ok(&r);
    let b = bbox(&r, 0);
    near(b[2], 5.0, "start");
    near(b[5], 7.0, "end");
}

#[test]
fn a_start_face_follows_the_face() {
    for h in [10.0, 16.0] {
        let mut f = vec![json!({"id": "bx", "type": "box", "length": 40, "width": 20, "height": "h"})];
        f.push(small_sketch_at(0.0));
        let top = json!({"kind": "face", "by": "tracked", "point": [0, 0, 5], "normal": [0, 0, 1], "body": "body1"});
        f.push(extrude(json!({"startType": "face", "startFace": top})));
        let r = build(json!({"h": h}), f);
        ok(&r);
        let b = bbox(&r, 1);
        near(b[2], h / 2.0, "start");
        near(b[5], h / 2.0 + 2.0, "end");
    }
}

#[test]
fn a_start_plane_and_a_start_point() {
    let dp = json!({"id": "dp", "type": "datumPlane", "plane": "XY", "offset": "po"});
    let r = build(json!({"po": 6}), vec![dp, small_sketch_at(0.0), extrude(json!({"startType": "plane", "startPlane": "dp"}))]);
    ok(&r);
    near(bbox(&r, 0)[2], 6.0, "plane start");
    let pt = json!({"id": "pt", "type": "datumPoint", "point": [3, 1, 8]});
    let r = build(json!({}), vec![pt, small_sketch_at(0.0), extrude(json!({"startType": "point", "startPoint": "pt", "startOffset": 1}))]);
    ok(&r);
    near(bbox(&r, 0)[2], 9.0, "point start");
    near(bbox(&r, 0)[5], 11.0, "point end");
}

#[test]
fn up_to_a_datum_plane_with_an_offset_follows_the_plane() {
    for po in [10.0, 14.0] {
        let dp = json!({"id": "dp", "type": "datumPlane", "plane": "XY", "offset": "po"});
        let r = build(
            json!({"po": po}),
            vec![dp, small_sketch_at(0.0), extrude(json!({"endType": "upToPlane", "upToPlane": "dp", "endOffset": 1}))],
        );
        ok(&r);
        near(bbox(&r, 0)[5], po + 1.0, "end");
        near(vol(&r, 0), 24.0 * (po + 1.0), "volume");
    }
    let r = build(json!({}), vec![small_sketch_at(-5.0), extrude(json!({"endType": "upToPlane", "upToPlane": "XY"}))]);
    ok(&r);
    near(bbox(&r, 0)[5], 0.0, "up to XY");
}

#[test]
fn up_to_a_datum_point_or_a_vertex() {
    let pt = json!({"id": "pt", "type": "datumPoint", "point": [9, 9, 7]});
    let r = build(json!({}), vec![pt, small_sketch_at(0.0), extrude(json!({"endType": "upToPoint", "upToPoint": "pt"}))]);
    ok(&r);
    near(bbox(&r, 0)[5], 7.0, "datum point end");
    let bx = json!({"id": "bx", "type": "box", "length": 40, "width": 20, "height": 10});
    let vx = json!({"point": [19.9, 9.9, 4.9], "body": "body1"});
    let r = build(json!({}), vec![bx, small_sketch_at(-20.0), extrude(json!({"endType": "upToPoint", "upToPoint": vx}))]);
    ok(&r);
    let b = bbox(&r, 1);
    near(b[2], -20.0, "vertex start");
    near(b[5], 5.0, "vertex end");
}

#[test]
fn through_all_opens_both_faces() {
    let bx = json!({"id": "bx", "type": "box", "length": 40, "width": 20, "height": 30});
    let r = build(
        json!({}),
        vec![bx, sketch_at(20.0), extrude(json!({"distance": -1, "operation": "cut", "targets": ["body1"], "endType": "throughAll"}))],
    );
    ok(&r);
    near(vol(&r, 0), 40.0 * 20.0 * 30.0 - 4.0 * 20.0 * 30.0, "volume");
    let pieces = kernel::subshapes(&r.bodies[0].shape, kernel::Kind::Solid).len();
    assert_eq!(pieces, 2, "the slot splits the block in two");
}

#[test]
fn two_sided_takes_each_side_on_its_own() {
    let r = build(json!({}), vec![small_sketch_at(0.0), extrude(json!({"distance": 3, "twoSided": true, "distance2": 5}))]);
    ok(&r);
    let b = bbox(&r, 0);
    near(b[2], -5.0, "side two");
    near(b[5], 3.0, "side one");
    near(vol(&r, 0), 24.0 * 8.0, "volume");
    let r = build(
        json!({}),
        vec![small_sketch_at(0.0), extrude(json!({"distance": 3, "twoSided": true, "distance2": 5, "taper2": 10}))],
    );
    ok(&r);
    let tapered = vol(&r, 0);
    assert!(tapered < 24.0 * 8.0 - 1.0, "side two tapers in: {tapered}");
    near(bbox(&r, 0)[2], -5.0, "tapered side two");
}

#[test]
fn symmetric_still_doubles_the_distance() {
    let r = build(json!({}), vec![small_sketch_at(0.0), extrude(json!({"symmetric": true}))]);
    ok(&r);
    let b = bbox(&r, 0);
    near(b[2], -2.0, "below");
    near(b[5], 2.0, "above");
}

#[test]
fn unreachable_targets_are_errors_never_empty_bodies() {
    let side = build(json!({}), vec![small_sketch_at(0.0), extrude(json!({"endType": "upToPlane", "upToPlane": "XZ"}))]);
    err_with(&side, "never reached");
    let on = build(json!({}), vec![small_sketch_at(0.0), extrude(json!({"endType": "upToPlane", "upToPlane": "XY"}))]);
    err_with(&on, "lies on the start");
    let mut f = block();
    f.push(sketch_at(5.0));
    let gone = json!({"kind": "face", "by": "tracked", "point": [0, 0, -5], "normal": [0, 0, -1], "body": "body9"});
    f.push(extrude(json!({"operation": "cut", "endType": "upToFace", "upToFace": gone})));
    err_with(&build(json!({"h": 10, "dz": 0}), f), "no longer exists");
    let both = build(json!({}), vec![small_sketch_at(0.0), extrude(json!({"symmetric": true, "twoSided": true, "distance2": 1}))]);
    err_with(&both, "cannot both");
    let back = build(
        json!({}),
        vec![small_sketch_at(0.0), extrude(json!({"endType": "upToPlane", "upToPlane": "dp", "endOffset": -12})),],
    );
    assert!(!back.errors.is_empty(), "a missing datum plane is an error");
}

/// A 10 mm cube body1 and a 10x10x2 slab body2 lifted to `z2`.
fn two_blocks(up_to: Value) -> Vec<Value> {
    let mut pp = json!({"id": "pp", "type": "press-pull", "distance": 1, "body": "body1",
        "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1], "body": "body1"}});
    for (k, v) in up_to.as_object().unwrap() {
        pp[k] = v.clone();
    }
    vec![
        json!({"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10}),
        json!({"id": "b2", "type": "box", "length": 10, "width": 10, "height": 2}),
        json!({"id": "m2", "type": "move", "dx": 0, "dy": 0, "dz": "z2", "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}),
        pp,
    ]
}

#[test]
fn a_press_pull_up_to_a_face_on_another_body_follows_it() {
    for z2 in [20.0, 40.0] {
        let sel = json!({"kind": "face", "by": "tracked", "point": [0, 0, 19], "normal": [0, 0, -1], "body": "body2"});
        let r = build(json!({"z2": z2}), two_blocks(json!({"upTo": sel})));
        ok(&r);
        near(bbox(&r, 0)[5], z2 - 1.0, "top");
        near(vol(&r, 0), 100.0 * (z2 - 1.0 + 5.0), "volume");
    }
}

#[test]
fn a_press_pull_up_to_a_plane_or_a_point_with_an_offset() {
    let mut f = two_blocks(json!({"upToPlane": "dp", "upToOffset": -1}));
    f.insert(3, json!({"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 12}));
    let r = build(json!({"z2": 20}), f);
    ok(&r);
    near(bbox(&r, 0)[5], 11.0, "plane top");
    let mut f = two_blocks(json!({"upToPoint": "pt"}));
    f.insert(3, json!({"id": "pt", "type": "datumPoint", "point": [30, 30, 9]}));
    let r = build(json!({"z2": 20}), f);
    ok(&r);
    near(bbox(&r, 0)[5], 9.0, "point top");
}

#[test]
fn a_press_pull_up_to_a_stale_nearest_point_is_not_a_silent_no_op() {
    let sel = json!({"kind": "face", "by": "nearest", "point": [0, 0, 19]});
    let r = build(json!({"z2": 20}), two_blocks(json!({"upTo": sel.clone()})));
    ok(&r);
    near(bbox(&r, 0)[5], 19.0, "near target");
    let r = build(json!({"z2": 40}), two_blocks(json!({"upTo": sel})));
    let followed = r.errors.is_empty() && (bbox(&r, 0)[5] - 39.0).abs() < 1e-3;
    assert!(followed || !r.errors.is_empty(), "moved nothing and said nothing");
}

#[test]
fn a_press_pull_that_empties_its_body_errors() {
    let own_bottom = json!({"kind": "face", "by": "tracked", "point": [0, 0, -5], "normal": [0, 0, -1], "body": "body1"});
    let r = build(json!({"z2": 20}), two_blocks(json!({"upTo": own_bottom})));
    assert!(!r.errors.is_empty(), "an emptied body must be an error");
}
