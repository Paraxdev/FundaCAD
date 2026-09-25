//! A hole on a `by:"tracked"` face follows that face when a parameter moves
//! it, and keeps its place on it.

use fundacad_core::schema::Selector;
use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use fundacad_geom::select::entity::faces_of;
use opencascade::select_access::SurfaceType;
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

fn block() -> Value {
    json!({"id": "bx", "type": "box", "length": 40, "width": 20, "height": "h"})
}

fn slide() -> Value {
    json!({"id": "mv", "type": "move", "dx": "dx", "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body1"]})
}

fn hole(face: Value, at: [f64; 3]) -> Value {
    json!({"id": "ho", "type": "hole", "face": face, "points": [at],
           "diameter": 4, "extent": "blind", "depth": 3})
}

fn top(center: Option<[f64; 3]>) -> Value {
    let mut sel = json!({"kind": "face", "by": "tracked", "point": [3, 2, 5], "normal": [0, 0, 1], "body": "body1"});
    if let Some(c) = center {
        sel["center"] = json!(c);
    }
    sel
}

/// The middle of each drilled bore, rounded to microns.
fn bores(r: &Rebuild) -> Vec<[f64; 3]> {
    faces_of(&r.bodies[0].shape)
        .unwrap()
        .iter()
        .filter(|f| f.surface == SurfaceType::Cylinder)
        .map(|f| {
            let b = kernel::bbox(&f.shape).unwrap();
            [0, 1, 2].map(|i| ((b[i] + b[i + 3]) / 2.0 * 1000.0).round() / 1000.0)
        })
        .collect()
}

#[test]
fn a_tracked_hole_follows_its_face_when_the_body_grows() {
    for h in [10.0, 30.0, 200.0, 4.0] {
        let r = build(json!({"h": h}), vec![block(), hole(top(Some([0.0, 0.0, 5.0])), [3.0, 2.0, 5.0])]);
        assert!(errors(&r).is_empty(), "h={h}: {:?}", errors(&r));
        assert_eq!(bores(&r), vec![[3.0, 2.0, h / 2.0 - 1.5]], "h={h}");
        assert_eq!(r.face_centers["ho"], json!([0.0, 0.0, h / 2.0]), "h={h}");
    }
}

#[test]
fn a_tracked_hole_keeps_its_place_on_a_face_that_slides_sideways() {
    for (dx, h) in [(0.0, 10.0), (25.0, 10.0), (-60.0, 30.0)] {
        let r = build(
            json!({"h": h, "dx": dx}),
            vec![block(), slide(), hole(top(Some([0.0, 0.0, 5.0])), [3.0, 2.0, 5.0])],
        );
        assert!(errors(&r).is_empty(), "dx={dx}: {:?}", errors(&r));
        assert_eq!(bores(&r), vec![[3.0 + dx, 2.0, h / 2.0 - 1.5]], "dx={dx} h={h}");
    }
}

#[test]
fn without_a_center_a_tracked_hole_follows_its_face_along_the_normal_only() {
    let r = build(json!({"h": 30}), vec![block(), hole(top(None), [3.0, 2.0, 5.0])]);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(bores(&r), vec![[3.0, 2.0, 13.5]]);
    assert_eq!(r.face_centers["ho"], json!([0.0, 0.0, 15.0]), "the centre to write back");
    let r = build(json!({"h": 10, "dx": 5}), vec![block(), slide(), hole(top(None), [3.0, 2.0, 5.0])]);
    assert_eq!(bores(&r), vec![[3.0, 2.0, 3.5]], "world positions without a centre");
}

#[test]
fn a_hole_on_a_side_face_follows_it_out() {
    let side = json!({"kind": "face", "by": "tracked", "point": [5, 10, 1], "normal": [0, 1, 0],
                      "center": [0, 10, 0], "body": "body1"});
    let feats = |w: f64| {
        vec![
            json!({"id": "bx", "type": "box", "length": 40, "width": w, "height": 10}),
            hole(side.clone(), [5.0, 10.0, 1.0]),
        ]
    };
    for w in [20.0, 50.0] {
        let r = build(json!({}), feats(w));
        assert!(errors(&r).is_empty(), "w={w}: {:?}", errors(&r));
        assert_eq!(bores(&r), vec![[5.0, w / 2.0 - 1.5, 1.0]], "w={w}");
    }
}

#[test]
fn a_step_that_grows_keeps_the_hole_on_its_own_top() {
    // An L: a low block with a tall one fused on its right end. The hole is on
    // the low top, and the tall top is the other face facing up.
    let feats = vec![
        json!({"id": "lo", "type": "box", "length": 40, "width": 20, "height": "h"}),
        json!({"id": "hi", "type": "box", "length": 10, "width": 20, "height": 60}),
        json!({"id": "mv", "type": "move", "dx": 25, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}),
        json!({"id": "un", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]}),
        hole(
            json!({"kind": "face", "by": "tracked", "point": [10, 0, 5], "normal": [0, 0, 1],
                   "center": [0, 0, 5], "body": "body1"}),
            [10.0, 0.0, 5.0],
        ),
    ];
    for h in [10.0, 40.0] {
        let r = build(json!({"h": h}), feats.clone());
        assert!(errors(&r).is_empty(), "h={h}: {:?}", errors(&r));
        assert_eq!(bores(&r), vec![[10.0, 0.0, h / 2.0 - 1.5]], "h={h}");
    }
}

#[test]
fn a_face_that_no_longer_faces_that_way_is_named_for_a_repick() {
    let tilted = json!({"kind": "face", "by": "tracked", "point": [3, 2, 5], "normal": [0.6, 0, 0.8], "body": "body1"});
    let r = build(json!({"h": 10}), vec![block(), hole(tilted, [3.0, 2.0, 5.0])]);
    assert_eq!(r.errors.len(), 1, "{:?}", errors(&r));
    assert!(errors(&r)[0].contains("no longer in the model"), "{:?}", errors(&r));
    let d = r.diagnostics.iter().find(|d| d["feature_id"] == "ho").expect("a diagnostic");
    assert_eq!(d["code"], "referenceNotFound");
    assert_eq!(d["at"], json!([3.0, 2.0, 5.0]));
}

#[test]
fn a_point_only_hole_builds_where_it_always_did() {
    let near = json!({"kind": "face", "by": "nearest", "point": [3, 2, 5], "body": "body1"});
    let r = build(json!({"h": 10}), vec![block(), hole(near, [3.0, 2.0, 5.0])]);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(bores(&r), vec![[3.0, 2.0, 3.5]]);
    assert!(r.face_centers.is_empty());
}

#[test]
fn the_tracked_form_parses_typed_and_round_trips() {
    for v in [top(None), top(Some([0.0, 0.0, 5.0]))] {
        let s: Selector = serde_json::from_value(v.clone()).unwrap();
        assert!(matches!(s, Selector::Known(_)), "{v} did not parse: {s:?}");
        assert_eq!(s.by(), Some("tracked"));
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }
    let s: Selector = serde_json::from_value(json!({"kind": "face", "by": "tracked", "point": [0, 0, 0]})).unwrap();
    assert!(matches!(s, Selector::Invalid(_)), "a tracked face needs its normal: {s:?}");
}
