//! A document built in one session comes out of a fresh one with the same body
//! ids and the same volumes, whether it travels through `doc_get` and
//! `doc_set` or through a saved file. Spawns the engine.

mod common;

use std::collections::BTreeMap;

use common::Mcp;
use serde_json::{json, Value};

fn session() -> Mcp {
    Mcp::start(&BTreeMap::new(), &std::env::temp_dir())
}

/// The shape of the timeline that lost its ids: a join, a join that names
/// body1, then a sphere and a cylinder that later features address as body2
/// and body3.
fn timeline() -> Vec<Value> {
    vec![
        json!({"id": "floor", "type": "box", "length": 100, "width": 100, "height": 6, "operation": "new"}),
        json!({"id": "wall", "type": "box", "length": 100, "width": 10, "height": 30, "operation": "join"}),
        json!({"id": "core_fill", "type": "box", "length": 20, "width": 20, "height": 20,
               "operation": "join", "targets": ["body1"]}),
        json!({"id": "bowl_ell", "type": "sphere", "radius": 1, "operation": "new"}),
        json!({"id": "bowl_scale", "type": "scale", "factor": 1, "sx": 10, "sy": 10, "sz": 5,
               "about": [0, 0, 0], "bodies": ["body2"]}),
        json!({"id": "bowl_place", "type": "move", "dx": 0, "dy": 0, "dz": 60, "rx": 0, "ry": 0, "rz": 0,
               "bodies": ["body2"]}),
        json!({"id": "bowl_clip", "type": "cylinder", "radius": 8, "height": 12, "operation": "new"}),
        json!({"id": "bowl_clip_place", "type": "move", "dx": 0, "dy": 0, "dz": -40, "rx": 0, "ry": 0,
               "rz": 0, "bodies": ["body3"]}),
    ]
}

/// Each body's id, size and volume from a build reply, and every failure.
fn outcome(mcp: &mut Mcp) -> Vec<String> {
    let r = mcp.call("build", json!({}));
    assert!(!r.is_error, "{}", r.text);
    let mut out: Vec<String> = r
        .text
        .lines()
        .filter(|l| l.starts_with("body") || l.starts_with("FEATURE FAILED"))
        .map(|l| l.split(", ").take(2).collect::<Vec<_>>().join(", "))
        .collect();
    out.sort();
    out
}

fn doc_set(mcp: &mut Mcp, doc: &Value) {
    let r = mcp.call("doc_set", json!({"document": doc}));
    assert!(!r.is_error, "{}", r.text);
}

#[test]
fn a_document_rebuilds_the_same_ids_in_a_fresh_engine() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let path = tmp.path().join("bowl.funda").to_string_lossy().replace('\\', "/");

    let mut first = session();
    for f in timeline() {
        let r = first.call("feature_add", json!({"feature": f}));
        assert!(!r.is_error, "{}", r.text);
    }
    let built = outcome(&mut first);
    let ids: Vec<&str> = built.iter().map(|l| l.split(' ').next().unwrap_or("")).collect();
    assert_eq!(ids, ["body1", "body2", "body3"], "{built:?}");
    let got: Value = serde_json::from_str(&first.call("doc_get", json!({})).text).expect("JSON");
    assert_eq!(
        got["bodyIds"],
        json!({"floor:0": "body1", "wall:0": "body1", "core_fill:0": "body1",
               "bowl_ell:0": "body2", "bowl_clip:0": "body3"}),
        "doc_get has to hand out the ids it built with"
    );
    assert!(!first.call("doc_save", json!({"path": path})).is_error);
    drop(first);

    let mut fresh = session();
    doc_set(&mut fresh, &got);
    assert_eq!(outcome(&mut fresh), built, "doc_get then doc_set");

    let mut opened = session();
    assert!(!opened.call("doc_open", json!({"path": path})).is_error);
    assert_eq!(outcome(&mut opened), built, "doc_save then doc_open");

    let mut bare = got.clone();
    let o = bare.as_object_mut().expect("an object");
    o.remove("bodyIds");
    o.remove("version");
    let mut handwritten = session();
    doc_set(&mut handwritten, &bare);
    assert_eq!(outcome(&mut handwritten), built, "a document sent without its map");

    let mut partial = got.clone();
    partial["bodyIds"] = json!({"floor:0": "body1"});
    let mut part = session();
    doc_set(&mut part, &partial);
    assert_eq!(outcome(&mut part), built, "a map holding only the first body");
}

#[test]
fn a_long_running_session_numbers_a_new_document_from_the_document() {
    let mut mcp = session();
    let other: Vec<Value> = (0..4)
        .map(|i| json!({"id": format!("b{i}"), "type": "box", "length": 5, "width": 5, "height": 5}))
        .collect();
    doc_set(&mut mcp, &json!({"features": other}));
    assert_eq!(outcome(&mut mcp).len(), 4);

    doc_set(&mut mcp, &json!({"features": timeline()}));
    let ids: Vec<String> = outcome(&mut mcp)
        .iter()
        .map(|l| l.split(' ').next().unwrap_or("").to_owned())
        .collect();
    assert_eq!(ids, ["body1", "body2", "body3"]);
}

#[test]
fn a_file_saved_before_the_map_keeps_the_numbering_it_was_made_with() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let path = tmp.path().join("old.funda");
    let features: Vec<Value> = timeline()
        .into_iter()
        .take(2)
        .chain([json!({"id": "cap", "type": "box", "length": 4, "width": 4, "height": 80,
                        "operation": "join", "targets": ["body2"]})])
        .collect();
    std::fs::write(
        &path,
        json!({"version": 9, "parameters": {}, "features": features}).to_string(),
    )
    .expect("written");
    let mut mcp = session();
    let open = mcp.call("doc_open", json!({"path": path.to_string_lossy().replace('\\', "/")}));
    assert!(!open.is_error, "{}", open.text);
    let built = outcome(&mut mcp);
    assert_eq!(built.len(), 1, "{built:?}");
    assert!(built[0].starts_with("body3 "), "{built:?}");
}
