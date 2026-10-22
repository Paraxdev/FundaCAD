//! The `measure` op: exact distances, sizes, radii and angles on the B-rep,
//! between the entities `inspect` hands out selectors for.

use std::f64::consts::PI;

use fundacad_geom::builder::NoWatch;
use fundacad_geom::inspect::inspect_result;
use fundacad_geom::measure::measure_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Value};

fn json_of(r: JobResult) -> Value {
    match r {
        JobResult::Json(m) => Value::Object(m),
        _ => panic!("expected a JSON result"),
    }
}

fn doc(features: Value) -> Value {
    json!({"parameters": {}, "features": features})
}

fn inspected(doc: &Value) -> Value {
    let req = json!({"document": doc, "detail": true});
    json_of(inspect_result(req.as_object().unwrap(), &NoWatch))
}

fn measure(doc: &Value, a: Value, b: Option<Value>, want: Option<&str>) -> Value {
    let mut req = json!({"document": doc, "a": a});
    if let Some(b) = b {
        req["b"] = b;
    }
    if let Some(w) = want {
        req["want"] = json!(w);
    }
    json_of(measure_result(req.as_object().unwrap(), &NoWatch))
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6 * b.abs().max(1.0)
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn vec3(v: &Value) -> [f64; 3] {
    std::array::from_fn(|k| num(&v[k]))
}

fn near3(a: [f64; 3], b: [f64; 3]) -> bool {
    (0..3).all(|k| near(a[k], b[k]))
}

/// The face `inspect` lists in `body` with this outward normal, its selector.
fn face_by_normal(ins: &Value, body: usize, n: [f64; 3]) -> Value {
    ins["bodies"][body]["faces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| near3(vec3(&f["normal"]), n))
        .unwrap_or_else(|| panic!("no face with normal {n:?}"))["selector"]
        .clone()
}

fn face_by_surface(ins: &Value, body: usize, surface: &str, z: Option<f64>) -> Value {
    ins["bodies"][body]["faces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["surface"] == surface && z.map_or(true, |z| near(num(&f["centroid"][2]), z)))
        .unwrap_or_else(|| panic!("no {surface} face"))["selector"]
        .clone()
}

fn edge_where(ins: &Value, body: usize, ok: impl Fn(&Value) -> bool) -> Value {
    ins["bodies"][body]["edges"].as_array().unwrap().iter().find(|e| ok(e)).expect("no such edge")["selector"].clone()
}

fn box_doc() -> Value {
    doc(json!([{"id": "bx", "type": "box", "length": 30, "width": 20, "height": 10}]))
}

#[test]
fn a_box_measures_its_wall_its_edge_and_its_corner() {
    let d = box_doc();
    let ins = inspected(&d);
    let left = face_by_normal(&ins, 0, [-1.0, 0.0, 0.0]);
    let right = face_by_normal(&ins, 0, [1.0, 0.0, 0.0]);
    let front = face_by_normal(&ins, 0, [0.0, -1.0, 0.0]);

    let m = measure(&d, left.clone(), Some(right), None);
    assert!(m.get("error").is_none(), "{m}");
    let between = &m["between"];
    assert!(near(num(&between["distance"]["value"]), 30.0), "{m}");
    assert!(near(num(&between["distance"]["from"][0]), -15.0), "{m}");
    assert!(near(num(&between["distance"]["to"][0]), 15.0), "{m}");
    assert!(near3(vec3(&between["distance"]["delta"]), [30.0, 0.0, 0.0]), "{m}");
    assert_eq!(between["distance"]["ties"], json!(4), "{m}");
    assert!(near(num(&between["planeGap"]["value"]), 30.0), "{m}");
    assert!(near(num(&between["angle"]["value"]), 0.0), "{m}");
    assert!(near(num(&between["angle"]["normals"]), 180.0), "{m}");
    assert_eq!(m["a"]["surface"], "plane", "{m}");
    assert!(near(num(&m["a"]["area"]), 200.0), "{m}");
    assert!(near3(vec3(&m["a"]["normal"]), [-1.0, 0.0, 0.0]), "{m}");
    assert_eq!(m["a"]["body"], "body1", "{m}");

    let corner = measure(&d, left.clone(), Some(front), Some("angle"));
    assert!(near(num(&corner["between"]["angle"]["value"]), 90.0), "{corner}");
    assert!(near(num(&corner["between"]["angle"]["normals"]), 90.0), "{corner}");
    assert!(corner["between"].get("distance").is_none(), "want narrows: {corner}");

    let long = edge_where(&ins, 0, |e| e["curve"] == "line" && near(num(&e["length"]), 30.0));
    let e = measure(&d, long, None, None);
    assert_eq!(e["a"]["kind"], "edge", "{e}");
    assert!(near(num(&e["a"]["length"]), 30.0), "{e}");
    let dir = vec3(&e["a"]["dir"]);
    assert!(near(dir[0].abs(), 1.0), "{e}");

    let whole = measure(&d, json!("body1"), None, None);
    assert!(near(num(&whole["a"]["volume"]), 6000.0), "{whole}");
    assert!(near3(vec3(&whole["a"]["size"]), [30.0, 20.0, 10.0]), "{whole}");

    let by_index = measure(&d, json!({"body": "body1", "face": 0}), None, None);
    assert_eq!(by_index["a"]["kind"], "face", "{by_index}");
    assert_eq!(by_index["a"]["index"], json!(0), "{by_index}");
    let by_label = measure(&d, json!({"body": "body1", "face": "F0"}), None, None);
    assert_eq!(by_label["a"]["area"], by_index["a"]["area"], "{by_label}");
}

#[test]
fn a_cylinder_gives_its_radius_and_the_axis_through_its_middle() {
    let d = doc(json!([{"id": "cy", "type": "cylinder", "radius": 5, "height": 20}]));
    let ins = inspected(&d);
    let side = face_by_surface(&ins, 0, "cylinder", None);
    let top = face_by_surface(&ins, 0, "plane", Some(10.0));

    let m = measure(&d, side.clone(), None, None);
    assert!(near(num(&m["a"]["radius"]), 5.0), "{m}");
    assert!(near(num(&m["a"]["diameter"]), 10.0), "{m}");
    let dir = vec3(&m["a"]["axis"]["dir"]);
    assert!(near(dir[2].abs(), 1.0), "{m}");
    assert!(near3(vec3(&m["a"]["axis"]["origin"]), [0.0, 0.0, 0.0]), "{m}");

    let rim = edge_where(&ins, 0, |e| e["curve"] == "circle" && near(num(&e["mid"][2]), 10.0));
    let c = measure(&d, rim, None, None);
    assert!(near(num(&c["a"]["radius"]), 5.0), "{c}");
    assert!(near3(vec3(&c["a"]["centre"]), [0.0, 0.0, 10.0]), "{c}");
    assert!(near(num(&c["a"]["arc"]), 360.0), "{c}");

    let a = measure(&d, side, Some(top), Some("angle"));
    assert!(near(num(&a["between"]["angle"]["value"]), 90.0), "{a}");
}

#[test]
fn two_boxes_apart_give_the_gap_and_both_closest_points() {
    let d = doc(json!([
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "mv", "type": "move", "dx": 25, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0,
         "bodies": ["body2"]}
    ]));
    let m = measure(&d, json!("body1"), Some(json!({"body": "body2"})), None);
    assert!(m.get("error").is_none(), "{m}");
    let dist = &m["between"]["distance"];
    assert!(near(num(&dist["value"]), 15.0), "{m}");
    assert!(near(num(&dist["from"][0]), 5.0), "{m}");
    assert!(near(num(&dist["to"][0]), 20.0), "{m}");
    assert!(near3(vec3(&dist["delta"]), [15.0, 0.0, 0.0]), "{m}");
    assert_eq!(dist["inside"], json!(false), "{m}");

    let ins = inspected(&d);
    let facing_a = face_by_normal(&ins, 0, [1.0, 0.0, 0.0]);
    let facing_b = face_by_normal(&ins, 1, [-1.0, 0.0, 0.0]);
    let g = measure(&d, facing_a, Some(facing_b), None);
    assert!(near(num(&g["between"]["planeGap"]["value"]), 15.0), "{g}");

    let cyl = doc(json!([
        {"id": "c1", "type": "cylinder", "radius": 2, "height": 10},
        {"id": "c2", "type": "cylinder", "radius": 3, "height": 10},
        {"id": "mv", "type": "move", "dx": 12, "dy": 5, "dz": 0, "rx": 0, "ry": 0, "rz": 0,
         "bodies": ["body2"]}
    ]));
    let ins = inspected(&cyl);
    let s1 = face_by_surface(&ins, 0, "cylinder", None);
    let s2 = face_by_surface(&ins, 1, "cylinder", None);
    let p = measure(&cyl, s1, Some(s2), None);
    assert_eq!(p["between"]["centres"]["how"], "axis to axis", "{p}");
    assert!(near(num(&p["between"]["centres"]["value"]), 13.0), "{p}");
    assert!(near(num(&p["between"]["distance"]["value"]), 8.0), "{p}");
}

#[test]
fn a_sphere_gives_its_radius_centre_area_and_volume() {
    let d = doc(json!([{"id": "sp", "type": "sphere", "radius": 8}]));
    let ins = inspected(&d);
    let skin = face_by_surface(&ins, 0, "sphere", None);
    let m = measure(&d, skin.clone(), None, None);
    assert!(near(num(&m["a"]["radius"]), 8.0), "{m}");
    assert!(near3(vec3(&m["a"]["centre"]), [0.0, 0.0, 0.0]), "{m}");
    assert!(near(num(&m["a"]["area"]), 4.0 * PI * 64.0), "{m}");
    let whole = measure(&d, json!("body1"), None, None);
    assert!(near(num(&whole["a"]["volume"]), 4.0 / 3.0 * PI * 512.0), "{whole}");

    let p = measure(&d, skin, Some(json!({"point": [20, 0, 0]})), None);
    assert!(near(num(&p["between"]["distance"]["value"]), 12.0), "{p}");
    assert!(near3(vec3(&p["between"]["distance"]["from"]), [8.0, 0.0, 0.0]), "{p}");
    assert_eq!(p["between"]["centres"]["how"], "centre to centre", "{p}");
    assert!(near(num(&p["between"]["centres"]["value"]), 20.0), "{p}");

    let inside = measure(&box_doc(), json!("body1"), Some(json!({"point": [0, 0, 0]})), None);
    assert_eq!(inside["between"]["distance"]["inside"], json!(true), "{inside}");
}

fn error_of(m: &Value) -> String {
    m["error"]["message"].as_str().unwrap_or_else(|| panic!("no error: {m}")).to_string()
}

#[test]
fn a_selector_that_does_not_measure_says_why_in_plain_words() {
    let d = box_doc();
    let e = error_of(&measure(&d, json!("body9"), None, None));
    assert!(e.contains("there is no body 'body9'") && e.contains("body1"), "{e}");
    let e = error_of(&measure(&d, json!({"kind": "vertex"}), None, None));
    assert!(e.starts_with("a is not a selector"), "{e}");
    let e = error_of(&measure(&d, json!({"body": "body1", "face": 99}), None, None));
    assert!(e.contains("has 6 faces"), "{e}");
    let e = error_of(&measure(&d, json!("body1"), None, Some("angle")));
    assert!(e.contains("two"), "{e}");

    let s = doc(json!([{"id": "sp", "type": "sphere", "radius": 8}]));
    let ins = inspected(&s);
    let skin = face_by_surface(&ins, 0, "sphere", None);
    let e = error_of(&measure(&s, json!({"point": [0, 0, 20]}), Some(skin), Some("angle")));
    assert!(e.contains("an angle takes a planar face"), "{e}");
}
