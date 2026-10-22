//! Loose ends: `inspect` with `sketch` lists the ends that keep a profile
//! open, and `sketch_tie` ties them so the engine closes it. Spawns the engine.

mod common;

use common::Mcp;
use serde_json::{json, Value};

fn start() -> Mcp {
    Mcp::start(
        &common::env(&[("FUNDACAD_MCP_MODE", "standalone"), ("FUNDACAD_MCP_SHADOW", "0")]),
        &std::env::temp_dir(),
    )
}

fn line(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Value {
    json!({"type": "line", "id": id, "x1": x1, "y1": y1, "x2": x2, "y2": y2})
}

fn looses(text: &str) -> Value {
    let at = text.find("looseEnds: ").expect("a looseEnds block") + "looseEnds: ".len();
    let end = text[at..].find('\n').map_or(text.len(), |n| at + n);
    serde_json::from_str(&text[at..end]).expect("looseEnds is JSON")
}

// 4e-5 is under the sketcher's region weld, so the app fills the square,
// and over the engine's 1e-7 closing tolerance, so the extrude is refused.
#[test]
fn a_square_with_a_hairline_gap_builds_once_its_loose_ends_are_tied() {
    let mut mcp = start();
    let square = json!([
        line("a", 0.0, 0.0, 10.0, 0.0),
        line("b", 10.0, 0.0, 10.0, 8.0),
        line("c", 10.0, 8.0, 0.0, 8.0),
        line("d", 0.0, 8.0, 0.0, 4e-5)
    ]);
    let r = mcp.call(
        "edit",
        json!({"ops": [
            {"op": "add", "feature": {"id": "s1", "type": "sketch", "plane": "XY", "entities": square}},
            {"op": "add", "feature": {"type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"}}
        ]}),
    );
    assert!(!r.is_error, "{}", r.text);
    let built = mcp.call("build", json!({}));
    assert!(built.is_error && built.text.contains("closed profile"), "{}", built.text);

    let r = mcp.call("inspect", json!({"sketch": "s1", "tolerance": 0.1}));
    assert!(!r.is_error, "{}", r.text);
    let le = looses(&r.text);
    assert_eq!(le["open"], json!([]));
    assert_eq!(le["untied"].as_array().map(Vec::len), Some(8), "{}", r.text);
    let d1 = le["untied"].as_array().unwrap().iter().find(|u| u["entity"] == json!("d") && u["p"] == json!(1)).unwrap();
    assert_eq!(d1["touches"], json!({"entity": "a", "p": 0}));
    assert_eq!(d1["at"], json!([0.0, 4e-5]));

    let r = mcp.call("sketch_tie", json!({"sketch": "s1", "tolerance": 0.1, "build": true}));
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("tied 4 loose ends in s1"), "{}", r.text);
    assert!(r.text.contains("body1"), "{}", r.text);
    let le = looses(&mcp.call("inspect", json!({"sketch": "s1", "tolerance": 0.1})).text);
    assert_eq!((&le["open"], &le["untied"]), (&json!([]), &json!([])));
}

#[test]
fn inspect_names_a_missing_sketch_and_an_open_end() {
    let mut mcp = start();
    let r = mcp.call("edit", json!({"ops": [
        {"op": "add", "feature": {"id": "s1", "type": "sketch", "plane": "XY", "entities": [line("a", 0.0, 0.0, 10.0, 0.0)]}}
    ]}));
    assert!(!r.is_error, "{}", r.text);
    let r = mcp.call("inspect", json!({"sketch": "s1"}));
    assert!(r.text.contains("s1: 2 open ends, 0 untied ends"), "{}", r.text);
    assert_eq!(looses(&r.text)["open"][1], json!({"entity": "a", "p": 1, "at": [10.0, 0.0]}));
    assert!(mcp.call("inspect", json!({"sketch": "nope"})).is_error);
    assert!(mcp.call("sketch_tie", json!({"sketch": "s1", "tolerance": -1})).is_error);
}
