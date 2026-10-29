//! A model of a few bodies reads as it always did: below FOLD_FROM rows nothing folds into ranges or pages.
//! Spawns the engine.

mod common;

use std::collections::BTreeMap;

use common::Mcp;
use serde_json::{json, Value};

fn reply(mcp: &mut Mcp, tool: &str, args: Value) -> String {
    let r = mcp.call(tool, args.clone());
    assert!(!r.is_error && r.error.is_none(), "{tool} {args}: {} {:?}", r.text, r.error);
    r.text
}

fn boxes(n: usize) -> Mcp {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    let ops: Vec<Value> = (1..=n)
        .map(|i| json!({"op": "add", "feature": {"type": "box", "length": i, "width": 2, "height": 2}}))
        .collect();
    reply(&mut mcp, "edit", json!({ "ops": ops }));
    mcp
}

#[test]
fn each_body_gone_since_the_last_build_is_named_on_a_short_model() {
    let mut mcp = boxes(5);
    reply(&mut mcp, "build", json!({}));
    let ops: Vec<Value> = (2..=4).map(|i| json!({"op": "remove", "id": format!("bx{i}")})).collect();
    reply(&mut mcp, "edit", json!({ "ops": ops }));
    assert_eq!(
        reply(&mut mcp, "build", json!({})),
        "gone since the last build: body2, body3, body4\nall bodies unchanged (2)"
    );
}

#[test]
fn inspect_details_every_body_of_a_model_of_eight_in_one_reply() {
    let mut mcp = boxes(8);
    let deep = reply(&mut mcp, "inspect", json!({"detail": true, "selectors": true}));
    let listed: Vec<&str> =
        deep.lines().filter(|l| l.starts_with("body")).map(|l| l.split(' ').next().unwrap()).collect();
    assert_eq!(listed, (1..=8).map(|i| format!("body{i}")).collect::<Vec<_>>(), "{deep}");
    assert!(!deep.contains("showing bodies"), "{deep}");
    for i in 1..=8 {
        assert!(deep.contains(&format!("\"body\":\"body{i}\"")), "the selectors of body{i}: {deep}");
    }
}
