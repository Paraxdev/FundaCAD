use crate::builder::{self, NoWatch};
use serde_json::{json, Value};

fn build(doc: Value) -> builder::Rebuild {
    let typed = serde_json::from_value(doc.clone()).expect("the document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r
}

fn near(a: [f64; 3], b: [f64; 3]) -> bool {
    (0..3).all(|i| (a[i] - b[i]).abs() < 1e-6)
}

fn mark(r: &builder::Rebuild, id: &str, key: &str) -> [f64; 3] {
    let v = &r.datum_marks[id][key];
    [0, 1, 2].map(|i| v[i].as_f64().unwrap_or(f64::NAN))
}

/// A 20 x 20 box of length `l` along X, centred, then the datums: its +X
/// face sits at x = l/2, so every reference made at l = 40 moves with l.
fn doc(l: f64, datums: Value) -> Value {
    let mut features = vec![json!({"id": "b", "type": "box", "length": "len", "width": 20, "height": 20})];
    features.extend(datums.as_array().cloned().unwrap_or_default());
    json!({"parameters": {"len": l}, "features": features})
}

fn plus_x_face() -> Value {
    json!({"kind": "face", "by": "tracked", "point": [20, 0, 0], "normal": [1, 0, 0], "body": "body1"})
}

fn top_face() -> Value {
    json!({"kind": "face", "by": "tracked", "point": [0, 0, 10], "normal": [0, 0, 1], "body": "body1"})
}

/// An edge of the box as it was at l = 40, by fingerprint.
fn edge(mid: [f64; 3], dir: [f64; 3], length: f64) -> Value {
    json!({"kind": "edge", "by": "match", "fp": {"mid": mid, "dir": dir, "length": length, "curve": "line"}, "body": "body1"})
}

fn vertical_edge(y: f64) -> Value {
    edge([20.0, y, 0.0], [0.0, 0.0, 1.0], 20.0)
}

fn top_edge_of_plus_x() -> Value {
    edge([20.0, 0.0, 10.0], [0.0, 1.0, 0.0], 20.0)
}

fn plane(id: &str, through: Value, extra: Value) -> Value {
    let mut f = json!({"id": id, "type": "datumPlane",
        "plane": {"origin": [0, 0, 0], "normal": [1, 0, 0], "xdir": [0, 1, 0]}, "through": through});
    if let (Some(o), Some(e)) = (f.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    f
}

fn origin_x(r: &builder::Rebuild, id: &str) -> f64 {
    r.datum_planes[id].origin[0]
}

#[test]
fn a_midplane_of_a_face_and_a_world_plane_follows_the_face() {
    let d = |l| {
        doc(
            l,
            json!([plane("m", json!({"kind": "mid", "a": {"face": plus_x_face()}, "b": {"plane": "YZ"}}), json!({}))]),
        )
    };
    assert!((origin_x(&build(d(40.0)), "m") - 10.0).abs() < 1e-6);
    let r = build(d(80.0));
    assert!((origin_x(&r, "m") - 20.0).abs() < 1e-6, "{:?}", r.datum_planes["m"]);
    assert!(near(r.datum_planes["m"].normal, [1.0, 0.0, 0.0]));
}

#[test]
fn a_midplane_of_two_datum_planes_follows_a_parent_edit() {
    let d = |off: f64| {
        json!({"parameters": {"off": off}, "features": [
            {"id": "p", "type": "datumPlane", "plane": "YZ", "offset": "off"},
            plane("m", json!({"kind": "mid", "a": {"plane": "p"}, "b": {"plane": "YZ"}}), json!({})),
        ]})
    };
    assert!((origin_x(&build(d(10.0)), "m") - 5.0).abs() < 1e-6);
    assert!((origin_x(&build(d(30.0)), "m") - 15.0).abs() < 1e-6);
}

#[test]
fn a_plane_through_three_points_follows_the_face_they_sit_on() {
    let d = |l| {
        doc(
            l,
            json!([plane(
                "p3",
                json!({"kind": "points", "points": [
                    {"face": plus_x_face()},
                    {"edge": vertical_edge(10.0), "end": "mid"},
                    {"edge": top_edge_of_plus_x(), "t": 0.25},
                ]}),
                json!({})
            )]),
        )
    };
    assert!((origin_x(&build(d(40.0)), "p3") - 20.0).abs() < 1e-6);
    let r = build(d(80.0));
    assert!((origin_x(&r, "p3") - 40.0).abs() < 1e-6, "{:?}", r.datum_planes["p3"]);
    assert!(near(r.datum_planes["p3"].normal, [1.0, 0.0, 0.0]), "faces the cached side");
}

#[test]
fn a_datum_point_on_an_edge_end_follows_it() {
    let d = |l| {
        doc(
            l,
            json!([
                {"id": "pt", "type": "datumPoint", "point": [20, 10, 10],
                 "at": {"edge": vertical_edge(10.0), "end": "end", "point": [20, 10, 10]}},
            ]),
        )
    };
    assert!(near(mark(&build(d(40.0)), "pt", "position"), [20.0, 10.0, 10.0]));
    let r = build(d(80.0));
    assert!(near(mark(&r, "pt", "position"), [40.0, 10.0, 10.0]), "{}", r.datum_marks["pt"]);
}

#[test]
fn a_datum_point_at_a_face_centre_follows_the_face() {
    let d = |l| doc(l, json!([{"id": "pt", "type": "datumPoint", "point": [20, 0, 0], "at": {"face": plus_x_face()}}]));
    assert!(near(mark(&build(d(80.0)), "pt", "position"), [40.0, 0.0, 0.0]));
}

#[test]
fn a_two_point_axis_follows_both_points() {
    let d = |l| {
        doc(
            l,
            json!([
                {"id": "ax", "type": "datumAxis", "origin": [20, 0, 0], "dir": [0, 0, 1], "through": {"kind": "points",
                 "a": {"face": plus_x_face()}, "b": {"edge": top_edge_of_plus_x(), "end": "mid"}}},
            ]),
        )
    };
    let r = build(d(80.0));
    assert!(
        near(mark(&r, "ax", "origin"), [40.0, 0.0, 0.0]) && near(mark(&r, "ax", "dir"), [0.0, 0.0, 1.0]),
        "{}",
        r.datum_marks["ax"]
    );
}

#[test]
fn an_axis_from_a_cylinder_follows_a_move_and_ignores_the_radius() {
    let d = |r: f64, dx: f64| {
        json!({"parameters": {"r": r, "dx": dx}, "features": [
            {"id": "c", "type": "cylinder", "radius": "r", "height": 30},
            {"id": "mv", "type": "move", "dx": "dx"},
            {"id": "ax", "type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1], "through": {"kind": "cylinder",
             "face": {"kind": "face", "by": "nearest", "point": [5, 0, 0], "body": "body1"}}},
        ]})
    };
    let r = build(d(5.0, 0.0));
    assert!(
        mark(&r, "ax", "origin")[0].abs() < 1e-6 && near(mark(&r, "ax", "dir"), [0.0, 0.0, 1.0]),
        "{}",
        r.datum_marks["ax"]
    );
    let r = build(d(6.0, 4.0));
    assert!((mark(&r, "ax", "origin")[0] - 4.0).abs() < 1e-6, "{}", r.datum_marks["ax"]);
}

#[test]
fn an_axis_where_two_planes_meet_follows_the_face() {
    let d = |l| {
        doc(
            l,
            json!([
                {"id": "ax", "type": "datumAxis", "origin": [20, 0, 0], "dir": [0, 1, 0], "through": {"kind": "planes",
                 "a": {"face": plus_x_face()}, "b": {"plane": "XY"}}},
            ]),
        )
    };
    let r = build(d(80.0));
    let (o, dir) = (mark(&r, "ax", "origin"), mark(&r, "ax", "dir"));
    assert!((o[0] - 40.0).abs() < 1e-6 && o[2].abs() < 1e-6 && near(dir, [0.0, 1.0, 0.0]), "{}", r.datum_marks["ax"]);
}

#[test]
fn a_plane_normal_to_an_edge_sits_at_its_fraction_and_follows_a_length_change() {
    let top = edge([0.0, 10.0, 10.0], [1.0, 0.0, 0.0], 40.0);
    let d = |l| doc(l, json!([plane("n", json!({"kind": "normalToEdge", "edge": top}), json!({"t": 0.25}))]));
    let r = build(d(40.0));
    assert!(near(r.datum_planes["n"].origin, [-10.0, 10.0, 10.0]), "{:?}", r.datum_planes["n"]);
    assert!(near(r.datum_planes["n"].normal, [1.0, 0.0, 0.0]));
    assert!(near(build(d(80.0)).datum_planes["n"].origin, [-20.0, 10.0, 10.0]));
}

#[test]
fn a_plane_normal_to_an_edge_at_a_vertex_follows_the_vertex() {
    let top = edge([0.0, 10.0, 10.0], [1.0, 0.0, 0.0], 40.0);
    let d = |l| {
        doc(
            l,
            json!([plane(
                "n",
                json!({"kind": "normalToEdge", "edge": top,
        "vertex": {"edge": vertical_edge(10.0), "end": "end", "point": [20, 10, 10]}}),
                json!({})
            )]),
        )
    };
    let r = build(d(80.0));
    assert!(near(r.datum_planes["n"].origin, [40.0, 10.0, 10.0]), "{:?}", r.datum_planes["n"]);
}

#[test]
fn a_plane_through_two_parallel_or_crossing_edges_follows_them() {
    let d = |l, b: Value| {
        doc(l, json!([plane("e2", json!({"kind": "twoEdges", "a": vertical_edge(10.0), "b": b}), json!({}))]))
    };
    for b in [vertical_edge(-10.0), top_edge_of_plus_x()] {
        assert!((origin_x(&build(d(40.0, b.clone())), "e2") - 20.0).abs() < 1e-6);
        let r = build(d(80.0, b));
        assert!(
            (origin_x(&r, "e2") - 40.0).abs() < 1e-6 && near(r.datum_planes["e2"].normal, [1.0, 0.0, 0.0]),
            "{:?}",
            r.datum_planes["e2"]
        );
    }
}

#[test]
fn skew_edges_keep_the_cached_plane_and_say_so() {
    let r = build(doc(
        40.0,
        json!([plane(
            "e2",
            json!({"kind": "twoEdges",
        "a": vertical_edge(10.0), "b": edge([0.0, -10.0, 10.0], [1.0, 0.0, 0.0], 40.0)}),
            json!({})
        )]),
    ));
    assert!(near(r.datum_planes["e2"].origin, [0.0, 0.0, 0.0]));
    assert!(r.diagnostics.iter().any(|d| d["feature_id"] == "e2"), "{:?}", r.diagnostics);
}

#[test]
fn a_plane_at_an_angle_about_an_edge_turns_from_its_face_and_follows_it() {
    let d = |l: f64, a: f64| {
        json!({"parameters": {"len": l, "a": a}, "features": [
            {"id": "b", "type": "box", "length": "len", "width": 20, "height": 20},
            {"id": "an", "type": "datumPlane", "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
             "angle": "a", "through": {"kind": "angle", "edge": top_edge_of_plus_x(), "from": {"face": top_face()}}},
        ]})
    };
    let flat = build(d(40.0, 0.0)).datum_planes["an"];
    assert!(near(flat.normal, [0.0, 0.0, 1.0]) && (flat.origin[2] - 10.0).abs() < 1e-6, "{flat:?}");
    let (s, c) = (30f64.to_radians().sin(), 30f64.to_radians().cos());
    let r = build(d(80.0, 30.0)).datum_planes["an"];
    let n = r.normal;
    assert!((n[0].abs() - s).abs() < 1e-6 && (n[2] - c).abs() < 1e-6 && n[1].abs() < 1e-6, "{r:?}");
    assert!(near(r.origin, [40.0, 0.0, 10.0]), "on the moved edge: {r:?}");
}

#[test]
fn a_lost_reference_keeps_the_cache_with_a_diagnostic_and_no_error() {
    let gone = json!({"kind": "face", "by": "tracked", "point": [20, 0, 0], "normal": [1, 0, 0], "body": "body9"});
    let r = build(doc(
        40.0,
        json!([
            plane("m", json!({"kind": "mid", "a": {"face": gone}, "b": {"plane": "YZ"}}), json!({})),
            {"id": "pt", "type": "datumPoint", "point": [1, 2, 3], "at": {"face": gone}},
        ]),
    ));
    assert!(near(r.datum_planes["m"].origin, [0.0, 0.0, 0.0]));
    assert!(!r.datum_marks.contains_key("pt"));
    for id in ["m", "pt"] {
        assert!(r.diagnostics.iter().any(|d| d["feature_id"] == id), "{id}: {:?}", r.diagnostics);
    }
}

#[test]
fn a_datum_without_references_serialises_back_unchanged() {
    for f in [
        json!({"id": "p", "type": "datumPlane", "plane": {"origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "offset": 2}),
        json!({"id": "pt", "type": "datumPoint", "point": [1, 2, 3]}),
        json!({"id": "ax", "type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1]}),
    ] {
        let typed: fundacad_core::schema::Feature = serde_json::from_value(f.clone()).expect("parses");
        assert_eq!(serde_json::to_value(&typed).expect("serialises"), f);
    }
}

#[test]
fn an_extrude_up_to_a_followed_datum_point_reaches_where_it_is_now() {
    let d = |l| {
        doc(
            l,
            json!([
                {"id": "pt", "type": "datumPoint", "point": [20, 0, 0], "at": {"face": plus_x_face()}},
                {"id": "dp", "type": "datumPlane", "plane": "YZ", "offset": 100},
                {"id": "sk", "type": "sketch", "plane": "YZ", "planeId": "dp",
                 "entities": [{"type": "rectangle", "x": 30, "y": 0, "width": 5, "height": 5}]},
                {"id": "e", "type": "extrude", "sketch": "sk", "distance": 1, "endType": "upToPoint", "upToPoint": "pt"},
            ]),
        )
    };
    let r = build(d(80.0));
    let boxes: Vec<[f64; 6]> = r.bodies.iter().filter_map(|b| crate::kernel::bbox(&b.shape)).collect();
    let near_end = boxes.iter().filter(|b| b[1] > 25.0).map(|b| b[0]).fold(f64::MAX, f64::min);
    assert!((near_end - 40.0).abs() < 1e-6, "the extrude ends at the moved point: {boxes:?}");
}

#[test]
fn a_reference_to_a_datum_further_down_is_refused_and_says_so() {
    let d = json!({"parameters": {}, "features": [
        plane("m", json!({"kind": "mid", "a": {"plane": "p"}, "b": {"plane": "YZ"}}), json!({})),
        {"id": "ax", "type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1], "through": {"kind": "points",
         "a": {"datum": "pt"}, "b": {"datum": "pt2"}}},
        {"id": "p", "type": "datumPlane", "plane": "YZ", "offset": 10},
        {"id": "pt", "type": "datumPoint", "point": [0, 0, 0]},
        {"id": "pt2", "type": "datumPoint", "point": [0, 0, 5]},
    ]});
    let typed = serde_json::from_value(d.clone()).expect("the document parses");
    let r = builder::rebuild(&typed, &d, &NoWatch).expect("not cancelled");
    for (id, later) in [("m", "p"), ("ax", "pt")] {
        let e = r.errors.iter().find(|e| e.feature_id.as_deref() == Some(id));
        let msg = e.map(|e| e.message.as_str()).unwrap_or("");
        assert!(msg.contains("comes after") && msg.contains(later), "{id}: {:?}", r.errors);
    }
}

#[test]
fn a_lost_reference_names_the_selector_so_it_can_be_picked_again() {
    let mut gone = vertical_edge(10.0);
    gone["body"] = json!("body9");
    let mut gone_face = plus_x_face();
    gone_face["body"] = json!("body9");
    let r = build(doc(
        40.0,
        json!([
            plane("n", json!({"kind": "normalToEdge", "edge": gone}), json!({})),
            {"id": "pt", "type": "datumPoint", "point": [1, 2, 3], "at": {"face": gone_face}},
        ]),
    ));
    let repick = |id: &str| {
        r.diagnostics
            .iter()
            .find(|d| d["feature_id"] == id && d["code"] == "referenceNotFound")
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(repick("n")["kind"], "edge", "{:?}", r.diagnostics);
    assert_eq!(repick("n")["at"], json!([20.0, 10.0, 0.0]));
    assert_eq!(repick("pt")["kind"], "face", "{:?}", r.diagnostics);
    assert_eq!(repick("pt")["at"], json!([20.0, 0.0, 0.0]));
}

#[test]
fn a_datum_point_on_an_edge_end_keeps_that_end_when_the_edge_moves_past_half_its_length() {
    let d = |dz: f64| {
        json!({"parameters": {"dz": dz}, "features": [
            {"id": "b", "type": "box", "length": 40, "width": 20, "height": 20},
            {"id": "mv", "type": "move", "dz": "dz"},
            {"id": "pt", "type": "datumPoint", "point": [20, 10, 10],
             "at": {"edge": vertical_edge(10.0), "end": "end", "point": [20, 10, 10]}},
        ]})
    };
    for dz in [5.0, 15.0, 30.0] {
        let r = build(d(dz));
        assert!(near(mark(&r, "pt", "position"), [20.0, 10.0, 10.0 + dz]), "dz {dz}: {}", r.datum_marks["pt"]);
    }
}

/// The plane as the app makes it, at the middle of a cylinder's top circle
/// with the path's tangent there as its cached normal, then its `t` edited.
/// The circle runs clockwise seen from above; a cached normal against that
/// means the path was drawn the other way, so `t` counts from the other end.
#[test]
fn a_plane_normal_to_a_circle_sits_at_an_edited_fraction() {
    let circle = json!({"kind": "edge", "by": "match", "body": "body1",
        "fp": {"mid": [-10, 0, 15], "dir": [0, 1, 0], "length": 20.0 * std::f64::consts::PI}});
    let d = |t: f64, along: f64| {
        json!({"parameters": {}, "features": [
            {"id": "c", "type": "cylinder", "radius": 10, "height": 30},
            {"id": "n", "type": "datumPlane", "plane": {"origin": [-10, 0, 15], "normal": [0, along, 0], "xdir": [1, 0, 0]},
             "t": t, "through": {"kind": "normalToEdge", "edge": circle}},
        ]})
    };
    for along in [1.0, -1.0] {
        for t in [0.1, 0.3, 0.5, 0.7] {
            let a = if along > 0.0 { t } else { 1.0 - t } * std::f64::consts::TAU;
            let want = [10.0 * a.cos(), -10.0 * a.sin(), 15.0];
            let r = build(d(t, along));
            assert!(
                near(r.datum_planes["n"].origin, want),
                "t {t} along {along}: {:?} want {want:?}",
                r.datum_planes["n"]
            );
        }
    }
}

/// The edge's fingerprint runs +Y, so a positive angle turns the top face's
/// normal toward +X, and on past 90 degrees without flipping back.
#[test]
fn a_plane_at_an_angle_turns_one_way_about_its_edge_and_keeps_turning_past_90() {
    let d = |a: f64| {
        json!({"parameters": {"a": a}, "features": [
            {"id": "b", "type": "box", "length": 40, "width": 20, "height": 20},
            {"id": "an", "type": "datumPlane", "plane": {"origin": [20, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
             "angle": "a", "through": {"kind": "angle", "edge": top_edge_of_plus_x(), "from": {"face": top_face()}}},
        ]})
    };
    for a in [30.0, -30.0, 150.0] {
        let r = build(d(a)).datum_planes["an"];
        let want = [f64::sin(f64::to_radians(a)), 0.0, f64::cos(f64::to_radians(a))];
        assert!(near(r.normal, want), "angle {a}: {r:?} want {want:?}");
    }
}

/// At radius 25 the point picked on the side at radius 5 sits nearer a cap.
#[test]
fn an_axis_from_a_cylinder_keeps_the_round_face_when_the_radius_grows_past_the_pick() {
    let d = |r: f64| {
        json!({"parameters": {"r": r}, "features": [
            {"id": "c", "type": "cylinder", "radius": "r", "height": 30},
            {"id": "mv", "type": "move", "dx": 4},
            {"id": "ax", "type": "datumAxis", "origin": [4, 0, 0], "dir": [0, 0, 1], "through": {"kind": "cylinder",
             "face": {"kind": "face", "by": "nearest", "point": [9, 0, 0], "body": "body1"}}},
        ]})
    };
    let r = build(d(25.0));
    let o = mark(&r, "ax", "origin");
    assert!(
        (o[0] - 4.0).abs() < 1e-6 && o[1].abs() < 1e-6 && mark(&r, "ax", "dir")[2].abs() > 1.0 - 1e-6,
        "{}",
        r.datum_marks["ax"]
    );
    assert!(
        !r.diagnostics.iter().any(|d| d["feature_id"] == "ax" && d["code"] == "referenceNotFound"),
        "{:?}",
        r.diagnostics
    );
}
