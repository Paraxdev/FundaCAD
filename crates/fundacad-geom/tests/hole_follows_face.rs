//! A hole on a `by:"tracked"` face follows that face when a parameter moves
//! it, and keeps its place on it.

use fundacad_core::schema::Selector;
use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use fundacad_geom::select::entity::faces_of;
use fundacad_geom::select::tracked;
use glam::DVec3;
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
        assert_eq!(r.tracked_faces["ho"]["extent"], json!([-20.0, 20.0, -10.0, 10.0]), "h={h}");
        assert_eq!(r.tracked_faces["ho"]["points"], json!([[3.0, 2.0, h / 2.0]]), "h={h}");
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
    assert_eq!(r.tracked_faces["ho"]["extent"], json!([-20.0, 20.0, -10.0, 10.0]), "the extent to write back");
    assert_eq!(r.tracked_faces["ho"]["point"], json!([3.0, 2.0, 15.0]));
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
    assert!(r.tracked_faces.is_empty());
}

#[test]
fn the_tracked_form_parses_typed_and_round_trips() {
    let mut extent = top(None);
    extent["extent"] = json!([-20.0, 20.0, -10.0, 10.0]);
    for v in [top(None), top(Some([0.0, 0.0, 5.0])), extent] {
        let s: Selector = serde_json::from_value(v.clone()).unwrap();
        assert!(matches!(s, Selector::Known(_)), "{v} did not parse: {s:?}");
        assert_eq!(s.by(), Some("tracked"));
        assert_eq!(serde_json::to_value(&s).unwrap(), v);
    }
    let s: Selector = serde_json::from_value(json!({"kind": "face", "by": "tracked", "point": [0, 0, 0]})).unwrap();
    assert!(matches!(s, Selector::Invalid(_)), "a tracked face needs its normal: {s:?}");
}

fn tracked(point: [f64; 3], normal: [f64; 3], extent: Option<[f64; 4]>) -> Value {
    let mut sel = json!({"kind": "face", "by": "tracked", "point": point, "normal": normal, "body": "body1"});
    if let Some(e) = extent {
        sel["extent"] = json!(e);
    }
    sel
}

fn holes(face: Value, at: &[[f64; 3]]) -> Value {
    json!({"id": "ho", "type": "hole", "face": face, "points": at,
           "diameter": 4, "extent": "blind", "depth": 3})
}

fn sorted(mut b: Vec<[f64; 3]>) -> Vec<[f64; 3]> {
    b.sort_by(|a, c| a.partial_cmp(c).unwrap());
    b
}

fn diag(r: &Rebuild) -> &Value {
    r.diagnostics
        .iter()
        .find(|d| d["feature_id"] == "ho")
        .unwrap_or_else(|| panic!("a diagnostic for the hole: {:?}", r.diagnostics))
}

/// A 60 long top split by a 20 wide cut from x -5 to 15.
fn split_top(face: Value) -> Vec<Value> {
    vec![
        json!({"id": "bx", "type": "box", "length": 60, "width": 20, "height": 10}),
        json!({"id": "sl", "type": "box", "length": 20, "width": 30, "height": 20}),
        json!({"id": "mv", "type": "move", "dx": 5, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}),
        json!({"id": "cu", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}),
        holes(face, &[[20.0, 2.0, 5.0]]),
    ]
}

#[test]
fn a_centre_carried_off_both_halves_of_a_split_face_is_refused_for_a_repick() {
    let mut face = tracked([20.0, 2.0, 5.0], [0.0, 0.0, 1.0], None);
    face["center"] = json!([0, 0, 5]);
    let r = build(json!({}), split_top(face));
    assert_eq!(r.errors.len(), 1, "{:?}", errors(&r));
    assert!(errors(&r)[0].contains("re-pick the face"), "{:?}", errors(&r));
    let d = diag(&r);
    assert_eq!(d["code"], "referenceNotFound");
    assert_eq!(d["at"], json!([20.0, 2.0, 5.0]));
    assert!(bores(&r).is_empty());
}

#[test]
fn an_extent_keeps_a_hole_on_the_half_of_a_split_face_it_was_picked_on() {
    let r = build(json!({}), split_top(tracked([20.0, 2.0, 5.0], [0.0, 0.0, 1.0], Some([-30.0, 30.0, -10.0, 10.0]))));
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(bores(&r), vec![[20.0, 2.0, 3.5]]);
    assert_eq!(r.tracked_faces["ho"]["extent"], json!([15.0, 30.0, -10.0, 10.0]));
}

#[test]
fn a_centred_hole_on_a_face_split_down_its_middle_is_ambiguous() {
    let feats = vec![
        json!({"id": "bx", "type": "box", "length": 60, "width": 20, "height": 10}),
        json!({"id": "sl", "type": "box", "length": 10, "width": 30, "height": 20}),
        json!({"id": "cu", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}),
        holes(tracked([0.0, 2.0, 5.0], [0.0, 0.0, 1.0], Some([-30.0, 30.0, -10.0, 10.0])), &[[0.0, 2.0, 5.0]]),
    ];
    let r = build(json!({}), feats);
    assert_eq!(r.errors.len(), 1, "{:?}", errors(&r));
    assert!(errors(&r)[0].contains("ambiguous"), "{:?}", errors(&r));
    assert!(errors(&r)[0].contains("re-pick the face"), "{:?}", errors(&r));
    assert_eq!(diag(&r)["at"], json!([0.0, 2.0, 5.0]));
    assert!(bores(&r).is_empty());
}

/// A plate from the origin to (L, 40, 6), the way a sketch drawn from a corner
/// builds it. The app evaluates expressions, so `half` is passed in as L / 2.
fn plate() -> Vec<Value> {
    vec![
        json!({"id": "bx", "type": "box", "length": "L", "width": 40, "height": 6}),
        json!({"id": "mv", "type": "move", "dx": "half", "dy": 20, "dz": 3, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body1"]}),
    ]
}

const CORNERS: [[f64; 3]; 4] = [[5.0, 5.0, 6.0], [55.0, 5.0, 6.0], [5.0, 35.0, 6.0], [55.0, 35.0, 6.0]];

fn corners_at(l: f64) -> Vec<[f64; 3]> {
    sorted(vec![[5.0, 5.0, 4.5], [l - 5.0, 5.0, 4.5], [5.0, 35.0, 4.5], [l - 5.0, 35.0, 4.5]])
}

#[test]
fn corner_holes_stay_by_their_corners_as_the_plate_grows_and_shrinks() {
    let face = tracked([5.0, 5.0, 6.0], [0.0, 0.0, 1.0], Some([0.0, 60.0, 0.0, 40.0]));
    for l in [60.0, 120.0, 33.0] {
        let mut feats = plate();
        feats.push(holes(face.clone(), &CORNERS));
        let r = build(json!({"L": l, "half": l / 2.0}), feats);
        assert!(errors(&r).is_empty(), "L={l}: {:?}", errors(&r));
        assert_eq!(sorted(bores(&r)), corners_at(l), "L={l}");
        assert_eq!(r.tracked_faces["ho"]["extent"], json!([0.0, l, 0.0, 40.0]), "L={l}");
        assert_eq!(r.tracked_faces["ho"]["point"], json!([5.0, 5.0, 6.0]), "L={l}");
    }
}

#[test]
fn a_centred_hole_stays_centred_as_the_plate_grows_and_shrinks() {
    let face = tracked([30.0, 20.0, 6.0], [0.0, 0.0, 1.0], Some([0.0, 60.0, 0.0, 40.0]));
    for l in [60.0, 120.0, 33.0] {
        let mut feats = plate();
        feats.push(holes(face.clone(), &[[30.0, 20.0, 6.0]]));
        let r = build(json!({"L": l, "half": l / 2.0}), feats);
        assert!(errors(&r).is_empty(), "L={l}: {:?}", errors(&r));
        assert_eq!(bores(&r), vec![[l / 2.0, 20.0, 4.5]], "L={l}");
    }
}

#[test]
fn corner_holes_stay_on_the_plate_beside_a_boss_whose_top_would_take_them() {
    let face = tracked([5.0, 5.0, 6.0], [0.0, 0.0, 1.0], Some([0.0, 60.0, 0.0, 40.0]));
    for l in [60.0, 120.0, 33.0] {
        let mut feats = plate();
        feats.extend([
            json!({"id": "bo", "type": "cylinder", "radius": 10, "height": 10}),
            json!({"id": "mb", "type": "move", "dx": "half", "dy": 20, "dz": 11, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}),
            json!({"id": "un", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]}),
            holes(face.clone(), &CORNERS),
        ]);
        let r = build(json!({"L": l, "half": l / 2.0}), feats);
        assert!(errors(&r).is_empty(), "L={l}: {:?}", errors(&r));
        assert_eq!(
            sorted(bores(&r).into_iter().filter(|b| b[2] < 6.0).collect()),
            corners_at(l),
            "L={l}"
        );
    }
}

#[test]
fn a_notch_in_one_corner_leaves_a_hole_by_the_other_where_it_was() {
    let feats = vec![
        json!({"id": "bx", "type": "box", "length": 40, "width": 20, "height": 10}),
        json!({"id": "nt", "type": "box", "length": 10, "width": 10, "height": 6}),
        json!({"id": "mv", "type": "move", "dx": 15, "dy": 5, "dz": 4, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}),
        json!({"id": "cu", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}),
        holes(tracked([-15.0, -5.0, 5.0], [0.0, 0.0, 1.0], Some([-20.0, 20.0, -10.0, 10.0])), &[[-15.0, -5.0, 5.0]]),
    ];
    let r = build(json!({}), feats);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(bores(&r), vec![[-15.0, -5.0, 3.5]]);
}

/// A 40 x 20 x 10 block with a 6 x 6 opening cut right through it at (3, 2).
fn pierced(at: [f64; 3]) -> Vec<Value> {
    vec![
        block(),
        json!({"id": "op", "type": "box", "length": 6, "width": 6, "height": 30}),
        json!({"id": "mv", "type": "move", "dx": 3, "dy": 2, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]}),
        json!({"id": "cu", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}),
        holes(tracked([3.0, 2.0, 5.0], [0.0, 0.0, 1.0], Some([-20.0, 20.0, -10.0, 10.0])), &[at]),
    ]
}

#[test]
fn an_opening_cut_under_the_pick_point_is_still_the_face() {
    let r = build(json!({"h": 10}), pierced([-10.0, 2.0, 5.0]));
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(bores(&r), vec![[-10.0, 2.0, 3.5]]);
}

#[test]
fn every_hole_missing_on_a_tracked_face_is_an_error_named_for_a_repick() {
    let r = build(json!({"h": 10}), pierced([3.0, 2.0, 5.0]));
    assert_eq!(r.errors.len(), 1, "{:?}", errors(&r));
    assert!(errors(&r)[0].contains("re-pick the face"), "{:?}", errors(&r));
    let d = diag(&r);
    assert_eq!(d["code"], "referenceNotFound");
    assert_eq!(d["at"], json!([3.0, 2.0, 5.0]));
}

#[test]
fn a_cylinder_top_extent_is_its_circle_exactly() {
    let feats = vec![
        json!({"id": "cy", "type": "cylinder", "radius": 7, "height": 10}),
        holes(tracked([0.0, 0.0, 5.0], [0.0, 0.0, 1.0], None), &[[0.0, 0.0, 5.0]]),
    ];
    let r = build(json!({}), feats);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(r.tracked_faces["ho"]["extent"], json!([-7.0, 7.0, -7.0, 7.0]));
}

#[test]
fn a_hole_on_a_side_face_keeps_its_offsets_from_that_face_edges() {
    // The +Y face's frame is (Z, X), so its extent is [zmin, zmax, xmin, xmax].
    let face = tracked([15.0, 10.0, 7.0], [0.0, 1.0, 0.0], Some([-10.0, 10.0, -20.0, 20.0]));
    for (l, h, want) in [(40.0, 20.0, [15.0, 8.5, 7.0]), (80.0, 40.0, [35.0, 8.5, 17.0])] {
        let feats = vec![
            json!({"id": "bx", "type": "box", "length": "L", "width": 20, "height": "H"}),
            holes(face.clone(), &[[15.0, 10.0, 7.0]]),
        ];
        let r = build(json!({"L": l, "H": h}), feats);
        assert!(errors(&r).is_empty(), "L={l} H={h}: {:?}", errors(&r));
        assert_eq!(bores(&r), vec![want], "L={l} H={h}");
        assert_eq!(r.tracked_faces["ho"]["extent"], json!([-h / 2.0, h / 2.0, -l / 2.0, l / 2.0]), "L={l} H={h}");
    }
}

#[test]
fn a_face_already_drawn_measures_the_same_extent_as_one_built_fresh() {
    let r = build(json!({"h": 10}), vec![block()]);
    let shape = &r.bodies[0].shape;
    let top = || {
        faces_of(shape)
            .unwrap()
            .into_iter()
            .find(|f| f.surface == SurfaceType::Plane && f.normal().z > 0.9)
            .unwrap()
    };
    assert_eq!(tracked::outline_extent(&top().shape, DVec3::Z), Some([-20.0, 20.0, -10.0, 10.0]));
    assert!(opencascade::mesh_access::mesh(shape, 0.5, false, 0.5, true));
    assert_eq!(tracked::outline_extent(&top().shape, DVec3::Z), Some([-20.0, 20.0, -10.0, 10.0]));
}

/// A cylinder of radius `r` standing 10 high, its top at z 5, bored through by
/// `inner` when there is one.
fn disc(inner: Option<f64>) -> Vec<Value> {
    let mut feats = vec![json!({"id": "cy", "type": "cylinder", "radius": "r", "height": 10})];
    if let Some(ri) = inner {
        feats.extend([
            json!({"id": "bo", "type": "cylinder", "radius": ri, "height": 30}),
            json!({"id": "cu", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}),
        ]);
    }
    feats
}

fn small_hole(face: Value, at: [f64; 3]) -> Value {
    json!({"id": "ho", "type": "hole", "face": face, "points": [at],
           "diameter": 1, "extent": "blind", "depth": 3})
}

fn near(a: &Value, b: [f64; 3]) -> bool {
    (0..3).all(|i| (a[i].as_f64().unwrap() - b[i]).abs() < 1e-4)
}

/// The radius walk the app makes: each build's record rebased into the next.
fn walk_the_radius(inner: Option<f64>, at: [f64; 3], want: impl Fn(f64) -> [f64; 3]) {
    let mut face = tracked(at, [0.0, 0.0, 1.0], Some([-7.0, 7.0, -7.0, 7.0]));
    let mut point = at;
    for r in [7.0, 15.0, 4.0] {
        let mut feats = disc(inner);
        feats.push(small_hole(face.clone(), point));
        let b = build(json!({"r": r}), feats);
        assert!(errors(&b).is_empty(), "r={r}: {:?}", errors(&b));
        let rec = &b.tracked_faces["ho"];
        assert_eq!(rec["extent"], json!([-r, r, -r, r]), "r={r}");
        assert!(near(&rec["points"][0], want(r)), "r={r}: {} not {:?}", rec["points"][0], want(r));
        assert!(near(&rec["point"], want(r)), "r={r}: {} not {:?}", rec["point"], want(r));
        face["point"] = rec["point"].clone();
        face["extent"] = rec["extent"].clone();
        point = [0, 1, 2].map(|i| rec["points"][0][i].as_f64().unwrap());
    }
    // The first placement carried straight to each radius lands the same way.
    for r in [15.0, 4.0] {
        let mut feats = disc(inner);
        feats.push(small_hole(tracked(at, [0.0, 0.0, 1.0], Some([-7.0, 7.0, -7.0, 7.0])), at));
        let b = build(json!({"r": r}), feats);
        assert!(errors(&b).is_empty(), "r={r}: {:?}", errors(&b));
        assert!(near(&b.tracked_faces["ho"]["points"][0], want(r)), "r={r}");
    }
}

// 6 out at (0.6, 0.8), 1 in from the r 7 rim. Anchored per axis both
// coordinates took their max edge and carried it off an r 15 top.
#[test]
fn a_hole_by_the_rim_of_a_round_top_stays_by_the_rim_as_the_radius_changes() {
    walk_the_radius(None, [3.6, 4.8, 5.0], |r| [0.6 * (r - 1.0), 0.8 * (r - 1.0), 5.0]);
}

#[test]
fn a_hole_near_the_centre_of_a_round_top_keeps_its_offset_from_the_centre() {
    walk_the_radius(None, [1.2, 1.6, 5.0], |_| [1.2, 1.6, 5.0]);
}

#[test]
fn a_hole_by_the_rim_of_a_tube_end_stays_by_its_outer_rim() {
    walk_the_radius(Some(2.0), [3.6, 4.8, 5.0], |r| [0.6 * (r - 1.0), 0.8 * (r - 1.0), 5.0]);
}

#[test]
fn a_rectangular_top_with_a_square_extent_still_anchors_per_axis() {
    let face = tracked([5.0, 5.0, 6.0], [0.0, 0.0, 1.0], Some([0.0, 40.0, 0.0, 40.0]));
    let mut feats = plate();
    feats.push(holes(face, &[[5.0, 5.0, 6.0], [35.0, 35.0, 6.0]]));
    let r = build(json!({"L": 80.0, "half": 40.0}), feats);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(sorted(bores(&r)), vec![[5.0, 5.0, 4.5], [75.0, 35.0, 4.5]]);
}
