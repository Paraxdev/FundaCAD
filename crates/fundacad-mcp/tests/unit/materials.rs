//! Replays tests/vectors/materials.json, which tests/document/materialVectors.test.ts replays against the app's
//! rules too, so the MCP cannot repair a material differently from the Render workspace.

use std::collections::HashSet;
use std::path::Path;

use fundacad_mcp::materials::*;
use serde_json::{json, Value};

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/materials.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse")
}

fn cases<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key].as_array().expect(key)
}

#[test]
fn starter_matches_the_app() {
    let v = vectors();
    assert_eq!(serde_json::to_string(&starter()).unwrap(), serde_json::to_string(&v["starter"]).unwrap());
    for (i, m) in starter().iter().enumerate() {
        assert_eq!(normalize_material(m, i).map(Value::Object).as_ref(), Some(m), "starter {i} is in normal form");
    }
}

#[test]
fn normalizes_like_the_app_in_the_same_key_order() {
    let v = vectors();
    for c in cases(&v, "normalize") {
        let index = c["index"].as_u64().unwrap_or(0) as usize;
        let got = normalize_material(&c["raw"], index).map(Value::Object).unwrap_or(Value::Null);
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&c["out"]).unwrap(), "{}", c["name"]);
    }
}

#[test]
fn reads_hex_slugs_and_names_like_the_app() {
    let v = vectors();
    for c in cases(&v, "hex") {
        assert_eq!(as_hex(&c["raw"]).map(Value::from).unwrap_or(Value::Null), c["out"], "{}", c["raw"]);
    }
    for c in cases(&v, "slug") {
        assert_eq!(slug_id(c["name"].as_str().unwrap()), c["id"].as_str().unwrap(), "{}", c["name"]);
    }
    for c in cases(&v, "unique") {
        let taken: HashSet<String> = serde_json::from_value(c["taken"].clone()).unwrap();
        assert_eq!(unique_id(c["id"].as_str().unwrap(), &taken), c["out"].as_str().unwrap());
    }
    for c in cases(&v, "fresh") {
        let names: Vec<String> = serde_json::from_value(c["names"].clone()).unwrap();
        let got = fresh_name(names.iter().map(String::as_str), c["base"].as_str().unwrap());
        assert_eq!(got, c["out"].as_str().unwrap());
    }
}

#[test]
fn writes_whole_numbers_without_a_fraction() {
    let m = normalize_material(&json!({"id": "m", "color": "#fff", "metalness": 1.0, "thickness": 20.0}), 0);
    assert_eq!(
        serde_json::to_string(&m).unwrap(),
        r##"{"id":"m","name":"m","color":"#ffffff","metalness":1,"thickness":20}"##
    );
}

#[test]
fn prints_a_face_like_the_app() {
    let v = vectors();
    for c in cases(&v, "prints") {
        let mut body = fundacad_mcp::mesh::MeshBody::from_value(c);
        body.info.remove("prints");
        let got = fundacad_mcp::face_prints::body_prints(&body);
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&c["prints"]).unwrap(), "{}", c["name"]);
    }
}
