use std::path::PathBuf;

use serde_json::{json, Map, Value};

use super::*;

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().expect("an object")
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/versions")
}

fn read(path: PathBuf) -> Map<String, Value> {
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    obj(serde_json::from_str(&text).unwrap())
}

/// FundaCAD 1's store gives an extrude an empty `hiddenBodies` as it opens, which is not migration.
fn without_store_defaults(mut doc: Map<String, Value>, before: &Map<String, Value>) -> Map<String, Value> {
    let had = |i: usize| before["features"][i].get("hiddenBodies").is_some();
    if let Some(features) = doc.get_mut("features").and_then(Value::as_array_mut) {
        for (i, f) in features.iter_mut().enumerate() {
            let f = f.as_object_mut().unwrap();
            if !had(i) && f.get("hiddenBodies") == Some(&json!([])) {
                f.shift_remove("hiddenBodies");
            }
        }
    }
    doc
}

#[test]
fn every_version_fixture_opens_as_fundacad_1_opened_it() {
    for v in 1..=10 {
        let before = read(fixtures().join(format!("v{v}.funda")));
        let want = without_store_defaults(read(fixtures().join(format!("expected/v{v}.json"))), &before);
        let mut got = before.clone();
        assert_eq!(migrate(&mut got), Ok(v), "v{v} reports its version");
        assert_eq!(Value::Object(got), Value::Object(want), "v{v}");
    }
}

#[test]
fn a_migrated_document_migrates_to_itself() {
    for v in [1, 2, 8] {
        let mut once = read(fixtures().join(format!("v{v}.funda")));
        migrate(&mut once).unwrap();
        let mut twice = once.clone();
        assert_eq!(migrate(&mut twice), Ok(u64::from(DOCUMENT_VERSION)));
        assert_eq!(twice, once, "v{v}");
    }
}

#[test]
fn a_newer_document_is_refused_and_left_as_it_was() {
    let newer = u64::from(DOCUMENT_VERSION) + 1;
    let before = obj(json!({"version": newer, "parameters": {"w": 4}, "features": [{"id": "x7", "type": "combine"}]}));
    let mut doc = before.clone();
    let err = migrate(&mut doc).unwrap_err();
    assert_eq!(err, Newer { version: newer });
    assert_eq!(doc, before);
    assert_eq!(
        err.to_string(),
        format!(
            "it was saved by a newer FundaCAD (document version {newer}, this build reads up to {DOCUMENT_VERSION}), update FundaCAD to open it"
        )
    );
}

#[test]
fn this_builds_version_is_read() {
    let mut doc = obj(json!({"version": DOCUMENT_VERSION, "parameters": {}, "features": []}));
    assert_eq!(migrate(&mut doc), Ok(u64::from(DOCUMENT_VERSION)));
    assert_eq!(Value::Object(doc), json!({"version": DOCUMENT_VERSION, "parameters": {}, "features": []}));
}

#[test]
fn a_document_with_nothing_gets_only_the_stamp() {
    let mut doc = Map::new();
    assert_eq!(migrate(&mut doc), Ok(1));
    assert_eq!(Value::Object(doc), json!({"version": DOCUMENT_VERSION}));
}

#[test]
fn polygon_angles_turn_to_degrees_only_before_version_2() {
    let poly = |version: Option<u64>| {
        let mut d = obj(json!({"features": [{"id": "s3", "type": "sketch", "entities": [
            {"type": "polygon", "id": "e4", "x": 7, "y": -2, "radius": 3, "sides": 5, "angle": std::f64::consts::FRAC_PI_4},
            {"type": "line", "id": "e5", "x1": 1, "y1": 2, "x2": 3, "y2": 5, "angle": 1.0}
        ]}]}));
        if let Some(v) = version {
            d.insert("version".into(), json!(v));
        }
        migrate(&mut d).unwrap();
        let e = &d["features"][0]["entities"];
        (e[0]["angle"].as_f64().unwrap(), e[1]["angle"].as_f64().unwrap())
    };
    assert_eq!(poly(None), (45.0, 1.0));
    assert_eq!(poly(Some(1)), (45.0, 1.0));
    assert_eq!(poly(Some(2)), (std::f64::consts::FRAC_PI_4, 1.0));
}

#[test]
fn combine_becomes_boolean_only_before_version_9() {
    let ops = |version: u64| {
        let mut d = obj(json!({"version": version, "features": [
            {"id": "k1", "type": "combine", "operation": "cut", "keepTools": true},
            {"id": "k2", "type": "combine", "operation": "join", "keepTools": false},
            {"id": "k3", "type": "combine", "operation": "intersect"},
            {"id": "k4", "type": "combine", "operation": "weird"}
        ]}));
        migrate(&mut d).unwrap();
        d["features"].clone()
    };
    assert_eq!(
        ops(8),
        json!([
            {"id": "k1", "type": "boolean", "operation": "subtract", "keepOriginals": true},
            {"id": "k2", "type": "boolean", "operation": "union"},
            {"id": "k3", "type": "boolean", "operation": "intersect"},
            {"id": "k4", "type": "boolean", "operation": "union"}
        ])
    );
    assert_eq!(ops(9)[0], json!({"id": "k1", "type": "combine", "operation": "cut", "keepTools": true}));
}

#[test]
fn dimension_constraints_get_ids_past_the_highest_and_others_none() {
    let mut d = obj(json!({"version": 10, "features": [
        {"id": "s1", "type": "sketch", "constraints": [
            {"type": "distance", "line": "e1", "value": 4},
            {"type": "horizontal", "line": "e1"},
            {"type": "radius", "circle": "e2", "value": 2, "id": "c6"}
        ]},
        {"id": "s2", "type": "sketch", "constraints": [{"type": "angle", "a": "e3", "b": "e4", "value": 30}]},
        {"id": "x1", "type": "box", "constraints": [{"value": 1}]}
    ]}));
    migrate(&mut d).unwrap();
    assert_eq!(
        d["features"],
        json!([
            {"id": "s1", "type": "sketch", "constraints": [
                {"type": "distance", "line": "e1", "value": 4, "id": "c7"},
                {"type": "horizontal", "line": "e1"},
                {"type": "radius", "circle": "e2", "value": 2, "id": "c6"}
            ]},
            {"id": "s2", "type": "sketch", "constraints": [{"type": "angle", "a": "e3", "b": "e4", "value": 30, "id": "c8"}]},
            {"id": "x1", "type": "box", "constraints": [{"value": 1}]}
        ])
    );
}

#[test]
fn bare_names_bind_to_model_parameters_once_per_target() {
    let mut d = obj(json!({"version": 3, "parameters": {"t": 2.5, "n": 6},
    "paramDefs": {"d4": {"expr": "old", "value": 1, "unit": "mm", "target": {"kind": "feature", "feature": "x2", "field": "distance"}}},
    "features": [
        {"id": "x1", "type": "extrude", "sketch": "s9", "distance": "t", "operation": "new"},
        {"id": "x2", "type": "extrude", "sketch": "s9", "distance": "t"},
        {"id": "x3", "type": "extrude", "sketch": "s9", "distance": "nope"},
        {"id": "s9", "type": "sketch", "entities": [
            {"type": "polygon", "id": "e2", "x": 1, "y": 3, "radius": 4, "sides": "n", "angle": 0},
            {"type": "line", "id": "e3", "x1": "t", "y1": 0, "x2": 1, "y2": 1}
        ]}
    ]}));
    migrate(&mut d).unwrap();
    assert_eq!(
        Value::Object(d),
        json!({"version": DOCUMENT_VERSION, "parameters": {"t": 2.5, "n": 6},
        "paramDefs": {
            "d4": {"expr": "t", "value": 2.5, "unit": "mm", "target": {"kind": "feature", "feature": "x2", "field": "distance"}},
            "t": {"expr": "2.5", "value": 2.5, "unit": "mm"},
            "n": {"expr": "6", "value": 6, "unit": "mm"},
            "d5": {"expr": "t", "value": 2.5, "unit": "mm", "target": {"kind": "feature", "feature": "x1", "field": "distance"}},
            "d6": {"expr": "n", "value": 6, "unit": "count", "target": {"kind": "entity", "sketch": "s9", "entity": "e2", "field": "sides"}}
        },
        "features": [
            {"id": "x1", "type": "extrude", "sketch": "s9", "distance": 2.5, "operation": "new"},
            {"id": "x2", "type": "extrude", "sketch": "s9", "distance": 2.5},
            {"id": "x3", "type": "extrude", "sketch": "s9", "distance": "nope"},
            {"id": "s9", "type": "sketch", "entities": [
                {"type": "polygon", "id": "e2", "x": 1, "y": 3, "radius": 4, "sides": 6, "angle": 0},
                {"type": "line", "id": "e3", "x1": "t", "y1": 0, "x2": 1, "y2": 1}
            ]}
        ]})
    );
}

#[test]
fn a_parameter_value_is_written_as_javascript_would() {
    assert_eq!(js_string(&json!(5)), "5");
    assert_eq!(js_string(&json!(5.0)), "5");
    assert_eq!(js_string(&json!(-0.25)), "-0.25");
    assert_eq!(js_string(&json!("w*2")), "w*2");
}
