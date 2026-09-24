//! A control-point bspline sketch written through the MCP builds, and inspect
//! reports the curve it makes as a bspline edge.

mod common;

use common::{env, Mcp};
use serde_json::{json, Value};

fn text(msg: &Value) -> String {
    msg["result"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_bspline_profile_builds_and_inspects_as_a_bspline_edge() {
    let cwd = std::env::temp_dir().join(format!("fundacad-mcp-bspline-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("a working directory");
    let mut mcp = Mcp::start(&env(&[("FUNDACAD_MCP_MODE", "standalone")]), &cwd);
    let mut call = |tool: &str, args: Value| {
        let msg = mcp.rpc("tools/call", json!({"name": tool, "arguments": args}));
        let t = text(&msg);
        assert!(!msg["result"]["isError"].as_bool().unwrap_or(false), "{tool}: {t}");
        t
    };
    call("param_set", json!({"name": "reach", "expr": 34}));
    call("feature_add", json!({"feature": {"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"type": "bspline", "id": "b", "closed": true, "poles": [
            {"x": 0, "y": -20}, {"x": 25, "y": -18}, {"x": "reach", "y": 5}, {"x": 12, "y": 28}, {"x": -15, "y": 22}, {"x": -28, "y": 0}
        ]}
    ]}}));
    call("feature_add", json!({"feature": {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}}));
    let built = call("build", json!({}));
    assert!(built.contains("body1"), "{built}");
    let inspected = call("inspect", json!({"detail": true}));
    assert!(inspected.contains("bspline"), "{inspected}");
    drop(mcp);
    let _ = std::fs::remove_dir_all(&cwd);
}
