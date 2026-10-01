//! Sketch shortcuts: a `polyline` and a `rectangle` by its corners are
//! stored as the entities the app already knows, and a sketch's entities are
//! checked when they are sent. Spawns the engine.

mod common;

use std::collections::BTreeMap;

use common::Mcp;
use serde_json::{json, Value};

fn start() -> Mcp {
    Mcp::start(&BTreeMap::new(), &std::env::temp_dir())
}

fn sketch(entities: Value) -> Value {
    json!({"id": "sk1", "type": "sketch", "plane": "XY", "entities": entities})
}

fn ok(mcp: &mut Mcp, tool: &str, args: Value) -> String {
    let r = mcp.call(tool, args);
    assert!(!r.is_error, "{}", r.text);
    r.text
}

fn refused(mcp: &mut Mcp, tool: &str, args: Value) -> String {
    let r = mcp.call(tool, args);
    assert!(r.is_error, "{}", r.text);
    r.text
}

fn entities(mcp: &mut Mcp) -> Vec<Value> {
    let doc: Value = serde_json::from_str(&ok(mcp, "doc_get", json!({}))).expect("doc_get is JSON");
    doc["features"][0]["entities"].as_array().cloned().unwrap_or_default()
}

#[test]
fn a_closed_polyline_and_a_corner_rectangle_build_the_same_plate() {
    let mut mcp = start();
    let text = ok(
        &mut mcp,
        "feature_add",
        json!({"feature": sketch(json!([{"type": "polyline", "id": "p", "closed": true,
            "points": [[0, 0], [20, 0], [20, "h"], {"x": 0, "y": "h"}]}]))}),
    );
    assert!(text.contains("Added sk1. Polyline p became lines p_1..p_4."), "{text}");
    let lines = entities(&mut mcp);
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[1], json!({"type": "line", "id": "p_2", "x1": 20, "y1": 0, "x2": 20, "y2": "h"}));
    assert_eq!((&lines[3]["x2"], &lines[3]["y2"]), (&json!(0), &json!(0)), "it closes on the first point");
    ok(&mut mcp, "param_set", json!({"name": "h", "expr": 10}));
    ok(&mut mcp, "feature_add", json!({"feature": {"type": "extrude", "sketch": "sk1", "distance": 5, "operation": "new"}}));
    let poly = ok(&mut mcp, "build", json!({}));

    let mut mcp = start();
    let text = ok(
        &mut mcp,
        "edit",
        json!({"ops": [
            {"op": "add", "feature": sketch(json!([{"type": "rectangle", "id": "r", "from": [20, 10], "to": [0, 0]}]))},
            {"op": "add", "feature": {"type": "extrude", "sketch": "sk1", "distance": 5, "operation": "new"}}
        ]}),
    );
    assert!(text.contains("In sk1, r from corners became 20 x 10 centred at (10, 5)."), "{text}");
    assert_eq!(entities(&mut mcp)[0], json!({"type": "rectangle", "id": "r", "width": 20.0, "height": 10.0, "x": 10.0, "y": 5.0}));
    let rect = ok(&mut mcp, "build", json!({}));
    for built in [&poly, &rect] {
        assert!(built.contains("20.0 x 10.0 x 5.0 mm, vol 1000 mm3"), "{built}");
    }
}

#[test]
fn an_unknown_entity_or_field_is_refused_when_it_is_sent() {
    let mut mcp = start();
    let text = refused(&mut mcp, "feature_add", json!({"feature": sketch(json!([{"type": "polygone", "radius": 3}]))}));
    assert!(text.contains("polygone") && text.contains("polyline"), "{text}");
    let text = refused(&mut mcp, "feature_add", json!({"feature": sketch(json!([{"type": "circle", "r": 3}]))}));
    assert!(text.contains("radius"), "{text}");
    let text = refused(
        &mut mcp,
        "feature_add",
        json!({"feature": sketch(json!([{"type": "polyline", "closed": true, "points": [[0, 0], [1, 0]]}]))}),
    );
    assert!(text.contains("a closed polyline needs at least 3 points, got 2"), "{text}");
    let text = refused(
        &mut mcp,
        "feature_add",
        json!({"feature": sketch(json!([{"type": "rectangle", "from": [0, 0], "to": [4, 4], "angle": 30}]))}),
    );
    assert!(text.contains("angle"), "{text}");

    // An update checks what it sends, not what the sketch already held.
    ok(&mut mcp, "feature_add", json!({"feature": sketch(json!([{"type": "circle", "radius": 3}]))}));
    let text = ok(
        &mut mcp,
        "feature_update",
        json!({"id": "sk1", "patch": {"entities": [{"type": "polyline", "points": [[0, 0], [5, 0], [5, 5]]}]}}),
    );
    assert!(text.contains("Polyline pl1 became lines pl1_1, pl1_2."), "{text}");
    refused(&mut mcp, "feature_update", json!({"id": "sk1", "patch": {"entities": [{"type": "line", "x1": 0}]}}));

    // A whole document only has its shortcuts expanded.
    let text = ok(
        &mut mcp,
        "doc_set",
        json!({"document": {"features": [sketch(json!([{"type": "polyline", "id": "q", "points": [[0, 0], [1, 1]]}]))]}}),
    );
    assert!(text.contains("In sk1, polyline q became lines q_1."), "{text}");
}
