//! The `measure` tool over the real protocol and the real engine: a wall
//! measured between two faces `inspect` handed out, and a plain refusal.

mod common;

use std::collections::BTreeMap;

use common::Mcp;
use serde_json::{json, Value};

#[test]
fn measure_gives_the_wall_between_two_inspected_faces() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    let add = mcp.call(
        "feature_add",
        json!({"feature": {"id": "bx", "type": "box", "length": 30, "width": 20, "height": 10}}),
    );
    assert!(!add.is_error, "{}", add.text);
    let ins = mcp.call("inspect", json!({"detail": true, "selectors": true}));
    assert!(!ins.is_error, "{}", ins.text);
    let (_, tail) = ins.text.split_once("selectors:").unwrap_or_else(|| panic!("{}", ins.text));
    let sel: Value = serde_json::from_str(tail.trim()).expect("the selectors are JSON");
    let face = |x: f64| {
        sel["body1"]["faces"]
            .as_object()
            .expect("a face map")
            .values()
            .find(|s| s["fp"]["normal"] == json!([x, 0.0, 0.0]))
            .cloned()
            .unwrap_or_else(|| panic!("no face with normal x {x}"))
    };

    let m = mcp.call("measure", json!({"a": face(-1.0), "b": face(1.0)}));
    assert!(!m.is_error, "{}", m.text);
    assert!(m.text.contains("distance 30 mm"), "{}", m.text);
    assert!(m.text.contains("plane gap 30 mm"), "{}", m.text);
    assert!(m.text.contains("angle 0 deg between the planes, 180 deg between the outward normals"), "{}", m.text);
    assert!(m.text.contains("normal (-1, 0, 0)"), "-0 prints as 0: {}", m.text);
    assert!(m.text.contains("\nraw: {"), "{}", m.text);

    let one = mcp.call("measure", json!({"a": "body1"}));
    assert!(!one.is_error, "{}", one.text);
    assert!(one.text.contains("volume 6000 mm3"), "{}", one.text);

    let bad = mcp.call("measure", json!({"a": "body9"}));
    assert!(bad.is_error, "{}", bad.text);
    assert!(bad.text.contains("there is no body 'body9'"), "{}", bad.text);
}
