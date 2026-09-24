//! A fillet picked through the MCP on the corner where a round wall's seam
//! meets its rim rounds the rim, and a fillet on the seam itself is refused.

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

fn ring(mcp: &mut Mcp) {
    for f in [
        json!({"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "id": "o", "x": 0, "y": 0, "radius": 50},
            {"type": "circle", "id": "i", "x": 0, "y": 0, "radius": 48}]}),
        json!({"id": "e", "type": "extrude", "sketch": "s", "distance": 34.4,
               "operation": "new", "regions": [[49, 0, 0]]}),
    ] {
        let msg = mcp.rpc("tools/call", json!({"name": "feature_add", "arguments": {"feature": f}}));
        assert!(!msg["result"]["isError"].as_bool().unwrap_or(false), "{}", text(&msg));
    }
}

fn faces_after_fillet_at(point: [f64; 3]) -> (String, Value) {
    let cwd = std::env::temp_dir().join(format!(
        "fundacad-mcp-seam-{}-{}",
        std::process::id(),
        point[2]
    ));
    std::fs::create_dir_all(&cwd).expect("a working directory");
    let mut mcp = Mcp::start(&env(&[("FUNDACAD_MCP_MODE", "standalone")]), &cwd);
    ring(&mut mcp);
    let fil = json!({"id": "fil", "type": "fillet", "radius": 1,
                     "edges": [{"kind": "edge", "by": "nearest", "point": point, "body": "body1"}]});
    mcp.rpc("tools/call", json!({"name": "feature_add", "arguments": {"feature": fil}}));
    let built = text(&mcp.rpc("tools/call", json!({"name": "build", "arguments": {}})));
    let doc = mcp.rpc("tools/call", json!({"name": "inspect", "arguments": {"detail": true}}));
    drop(mcp);
    let _ = std::fs::remove_dir_all(&cwd);
    (built, doc)
}

#[test]
fn a_fillet_on_the_seam_corner_rounds_the_rim() {
    let (built, inspected) = faces_after_fillet_at([50.0, 0.0, 34.4]);
    assert!(!built.contains("fil"), "the fillet failed: {built}");
    let t = text(&inspected);
    assert!(t.contains("5 faces") || t.contains("faces: 5"), "the rim is not rounded: {t}");
}

#[test]
fn a_fillet_on_the_seam_itself_says_so() {
    let (built, _) = faces_after_fillet_at([50.0, 0.0, 17.2]);
    assert!(built.contains("seam"), "the seam fillet was not refused: {built}");
}
