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

fn rect(id: &str, (x0, y0): (f64, f64), (x1, y1): (f64, f64)) -> Value {
    json!({"id": id, "type": "rectangle", "width": x1 - x0, "height": y1 - y0, "x": (x0 + x1) / 2.0, "y": (y0 + y1) / 2.0})
}

fn volume(built: &str) -> f64 {
    let at = built.find("vol ").expect("a volume") + 4;
    built[at..].split_whitespace().next().unwrap().parse().unwrap()
}

#[test]
fn merging_overlapping_rectangles_keeps_the_solid_and_leaves_one_area() {
    let mut mcp = start();
    ok(
        &mut mcp,
        "edit",
        json!({"ops": [
            {"op": "add", "feature": json!({"id": "sk1", "type": "sketch", "plane": "XY",
                "entities": [rect("a", (0.0, 0.0), (20.0, 10.0)), rect("b", (10.0, 0.0), (20.0, 30.0))],
                "constraints": [{"type": "horizontal", "line": "a~0"}, {"type": "vertical", "line": "z"}]})},
            {"op": "add", "feature": {"type": "extrude", "sketch": "sk1", "distance": 5, "operation": "new"}}
        ]}),
    );
    let whole = volume(&ok(&mut mcp, "build", json!({})));
    let text = ok(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["a", "b"], "build": true}));
    assert!(text.contains("Merged a, b in sk1 into 6 entities (m1_1..m1_6): 1 outline. A point inside it: [") , "{text}");
    assert!(text.contains("Dropped 1 constraint on the merged shapes."), "{text}");
    // The build after it found the very same solid.
    assert!(text.ends_with("build:\nall bodies unchanged (1)"), "{text}");
    let again = volume(&ok(&mut mcp, "build", json!({"full": true})));
    assert!((again - whole).abs() < 1e-6 && (whole - 2000.0).abs() < 1e-6, "{whole} then {again}");
    let ents = entities(&mut mcp);
    assert_eq!(ents.len(), 6);
    assert!(ents.iter().all(|e| e["type"] == "line"));
    let doc: Value = serde_json::from_str(&ok(&mut mcp, "doc_get", json!({}))).unwrap();
    assert_eq!(doc["features"][0]["constraints"], json!([{"type": "vertical", "line": "z"}]));
}

#[test]
fn a_merged_frame_keeps_its_hole_with_the_seed_it_gives() {
    let mut mcp = start();
    ok(
        &mut mcp,
        "feature_add",
        json!({"feature": {"id": "sk1", "type": "sketch", "plane": "XZ", "entities": [
            rect("s", (0.0, 0.0), (30.0, 5.0)), rect("n", (0.0, 25.0), (30.0, 30.0)),
            rect("w", (0.0, 0.0), (5.0, 30.0)), rect("e", (25.0, 0.0), (30.0, 30.0))]}}),
    );
    let text = ok(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["s", "n", "w", "e"], "id": "frame"}));
    assert!(text.contains("1 outline with 1 hole") && text.contains("give it `regions`"), "{text}");
    let at = text.find("A point inside it: ").unwrap() + "A point inside it: ".len();
    let seed: Value = serde_json::from_str(&text[at..text[at..].find(']').unwrap() + at + 1]).unwrap();
    ok(&mut mcp, "feature_add", json!({"feature": {"type": "extrude", "sketch": "sk1", "distance": 2, "operation": "new", "regions": [seed]}}));
    let built = ok(&mut mcp, "build", json!({}));
    assert!((volume(&built) - 1000.0).abs() < 1e-6, "{built}");
}

#[test]
fn a_merge_that_would_lose_something_is_refused_and_changes_nothing() {
    let mut mcp = start();
    ok(&mut mcp, "param_set", json!({"name": "w", "expr": 20}));
    ok(
        &mut mcp,
        "feature_add",
        json!({"feature": {"id": "sk1", "type": "sketch", "plane": "XY", "entities": [
            {"id": "a", "type": "rectangle", "width": "w", "height": 10, "x": 10, "y": 5},
            rect("b", (10.0, 0.0), (20.0, 30.0)),
            {"id": "e", "type": "ellipse", "rx": 3, "ry": 2, "x": 5, "y": 5}],
            "patterns": [{"id": "pt", "type": "patternRect", "sources": ["b"], "countX": 2, "countY": 1, "spacingX": 40, "spacingY": 0}]}}),
    );
    let before = ok(&mut mcp, "doc_get", json!({}));
    let text = refused(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["a", "b"]}));
    assert!(text.contains("pattern pt repeats b"), "{text}");
    ok(&mut mcp, "feature_update", json!({"id": "sk1", "patch": {"patterns": null}}));
    let text = refused(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["a", "b"]}));
    assert!(text.contains("sized by w") && text.contains("bake: true"), "{text}");
    let text = refused(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["a", "e"], "bake": true}));
    assert!(text.contains("e is an ellipse"), "{text}");
    refused(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["a"]}));
    refused(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["a", "nope"]}));
    let after: Value = serde_json::from_str(&ok(&mut mcp, "doc_get", json!({}))).unwrap();
    let before: Value = serde_json::from_str(&before).unwrap();
    assert_eq!(after["features"][0]["entities"], before["features"][0]["entities"]);
    let text = ok(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["a", "b"], "bake": true}));
    assert!(text.contains("into 6 entities"), "{text}");
}

#[test]
fn a_merge_trims_offsets_names_what_reads_the_sketch_and_reuses_no_id() {
    let mut mcp = start();
    ok(
        &mut mcp,
        "edit",
        json!({"ops": [
            {"op": "add", "feature": json!({"id": "sk1", "type": "sketch", "plane": "XY", "entities": [
                rect("s", (0.0, 0.0), (30.0, 5.0)), rect("n", (0.0, 25.0), (30.0, 30.0)),
                rect("w", (0.0, 0.0), (5.0, 30.0)), rect("e", (25.0, 0.0), (30.0, 30.0)),
                rect("c", (40.0, 0.0), (50.0, 10.0)), rect("d", (60.0, 0.0), (70.0, 10.0))],
                "constraints": [
                    {"type": "offset", "value": 2, "pairs": [{"src": "s~0", "cpy": "c~0"}, {"src": "d~0", "cpy": "c~1"}]},
                    {"type": "offset", "value": 2, "pairs": [{"src": "s~1", "cpy": "c~0"}]}]})},
            {"op": "add", "feature": {"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": 2, "operation": "new"}},
            {"op": "add", "feature": {"id": "ex2", "type": "extrude", "sketch": "sk1", "distance": 2, "operation": "new", "region": [2.5, 2.5, 0]}}
        ]}),
    );
    let text = ok(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["s", "n", "w", "e"]}));
    assert!(text.contains("Dropped 1 constraint") && text.contains("1 offset lost the pairs"), "{text}");
    assert!(text.contains("ex1 takes the whole sketch, so the hole is now filled."), "{text}");
    assert!(text.contains("ex2 reads areas of this sketch by point"), "{text}");
    let doc: Value = serde_json::from_str(&ok(&mut mcp, "doc_get", json!({}))).unwrap();
    assert_eq!(doc["features"][0]["constraints"][0]["pairs"], json!([{"src": "d~0", "cpy": "c~1"}]));
    let text = ok(&mut mcp, "sketch_merge", json!({"sketch": "sk1", "entities": ["m1_1", "m1_2", "m1_3", "m1_4", "m1_5", "m1_6", "m1_7", "m1_8", "c"]}));
    assert!(text.contains("(m2_1, m2_2") || text.contains("(m2_1.."), "{text}");
}
