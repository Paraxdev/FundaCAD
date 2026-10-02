//! The `printability` op as the app calls it: findings with their faces,
//! the settings and bodies they were checked with, lay flat and the
//! refusals.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::printcheck::op::printability_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Value};

fn run(req: Value) -> Value {
    let Value::Object(m) = req else {
        panic!("a request is an object")
    };
    match printability_result(&m, &NoWatch) {
        JobResult::Json(m) => Value::Object(m),
        _ => panic!("expected a JSON result"),
    }
}

fn error_of(v: &Value) -> String {
    v["error"]["message"].as_str().unwrap_or_else(|| panic!("expected an error: {v}")).to_string()
}

/// A 20 x 20 x 10 block on z = 0 and, beside it, a 0.6 mm fin.
fn block_and_fin() -> Value {
    json!({"features": [
        {"id": "b", "type": "box", "length": 20, "width": 20, "height": 10},
        {"id": "m", "type": "move", "dz": 5, "bodies": ["body1"]},
        {"id": "f", "type": "box", "length": 0.6, "width": 20, "height": 10},
        {"id": "n", "type": "move", "dx": 30, "dz": 5, "bodies": ["body2"]},
    ]})
}

#[test]
fn a_thin_fin_is_one_wall_finding_with_both_its_faces() {
    let r = run(json!({"document": block_and_fin(), "op": "printability", "id": 7, "binary": true}));
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(r["settings"], json!({"nozzle": 0.4, "layer": 0.2, "overhang": 45.0, "minGap": 0.2, "maxBridge": 10.0, "up": "+Z", "layFlat": false}));
    assert_eq!(r["header"], "+Z up as modelled, bed at z = 0");
    let bodies = r["bodies"].as_array().unwrap();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0]["id"], "body1");
    assert_eq!(bodies[0]["up"], json!([0.0, 0.0, 1.0]));
    assert_eq!(bodies[0]["openEdges"], 0);
    assert_eq!(bodies[0]["bedFace"], Value::Null);
    assert_eq!(bodies[0]["insideOut"], false);
    let findings = r["findings"].as_array().unwrap();
    assert_eq!(findings.len(), 1, "{r}");
    let f = &findings[0];
    assert_eq!(f["kind"], "wall");
    assert_eq!(f["body"], "body2");
    assert!((f["value"].as_f64().unwrap() - 0.6).abs() < 1e-3, "{f}");
    assert!((f["limit"].as_f64().unwrap() - 0.8).abs() < 1e-9, "{f}");
    let other = &f["other"];
    assert_eq!(other["body"], "body2");
    assert_ne!(other["face"], f["face"], "a wall is between two faces");
    let at = f["at"].as_array().unwrap();
    assert!((at[0].as_f64().unwrap() - 30.0).abs() < 0.5, "{f}");
    assert!(r["report"].as_str().unwrap().contains("wall F"), "{r}");
    assert_eq!(r["errors"], json!([]));
}

#[test]
fn only_the_bodies_asked_for_are_checked_and_a_wrong_name_is_refused() {
    let r = run(json!({"document": block_and_fin(), "bodies": ["body1"]}));
    assert_eq!(r["bodies"].as_array().unwrap().len(), 1, "{r}");
    assert_eq!(r["findings"], json!([]));
    let r = run(json!({"document": block_and_fin(), "bodies": ["nope"]}));
    assert_eq!(error_of(&r), "no body 'nope' in this build. Check the ids or names against `build`.");
}

#[test]
fn bad_settings_are_refused_and_unknown_keys_pass() {
    let r = run(json!({"document": block_and_fin(), "nozzle": -1}));
    assert!(error_of(&r).starts_with("`nozzle` is a number above 0"), "{r}");
    let r = run(json!({"document": block_and_fin(), "up": "+Z", "layFlat": true}));
    assert!(error_of(&r).starts_with("give `up` or `layFlat`, not both"), "{r}");
    let r = run(json!({"document": block_and_fin(), "chunked": true, "revision": 3}));
    assert!(r.get("error").is_none(), "{r}");
}

#[test]
fn an_overhang_names_its_face_and_turning_the_part_over_clears_it() {
    // A T: a 4 mm cap 20 wide on a 4 mm stem, the cap's underside hangs.
    let doc = json!({"features": [
        {"id": "s", "type": "box", "length": 4, "width": 4, "height": 10},
        {"id": "m", "type": "move", "dz": 5, "bodies": ["body1"]},
        {"id": "c", "type": "box", "length": 20, "width": 4, "height": 4},
        {"id": "n", "type": "move", "dz": 12, "bodies": ["body2"]},
        {"id": "j", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]},
    ]});
    let r = run(json!({"document": doc}));
    let findings = r["findings"].as_array().unwrap();
    assert!(!findings.is_empty(), "{r}");
    assert!(findings.iter().all(|f| f["kind"] == "overhang" && f["body"] == "body1"), "{r}");
    let f = &findings[0];
    assert_eq!(f["value"], 90.0, "a flat underside leans all the way");
    assert!((f["low"].as_f64().unwrap() - 10.0).abs() < 1e-6, "{f}");
    assert_eq!(f["other"], Value::Null);
    // Laid on its largest flat face, the cap's top, nothing hangs.
    let r = run(json!({"document": doc, "layFlat": true}));
    assert_eq!(r["settings"]["up"], Value::Null);
    assert_eq!(r["settings"]["layFlat"], true);
    assert!(r["bodies"][0]["bedFace"].is_number(), "{r}");
    assert!(r["header"].as_str().unwrap().starts_with("laid flat as export would (body1 on F"), "{r}");
    assert_eq!(r["findings"], json!([]), "{r}");
}

#[test]
fn bodies_touching_print_fused_and_the_pair_names_both() {
    let doc = json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "m", "type": "move", "dx": 10.1, "bodies": ["body2"]},
    ]});
    let r = run(json!({"document": doc}));
    let fused: Vec<&Value> = r["findings"].as_array().unwrap().iter().filter(|f| f["kind"] == "fused").collect();
    assert_eq!(fused.len(), 1, "{r}");
    let pair = [fused[0]["body"].as_str().unwrap(), fused[0]["other"]["body"].as_str().unwrap()];
    assert!(pair == ["body1", "body2"] || pair == ["body2", "body1"], "{r}");
}

#[test]
fn an_empty_document_has_nothing_to_check() {
    let r = run(json!({"document": {"features": []}}));
    assert_eq!(r["bodies"], json!([]));
    assert_eq!(r["findings"], json!([]));
    assert_eq!(r["report"], "Nothing built to check.");
}

#[test]
fn a_failed_build_says_why_even_when_bodies_are_named() {
    let doc = json!({"features": [{"id": "bx", "type": "box", "length": -5, "width": 10, "height": 10}]});
    let r = run(json!({"document": doc, "bodies": ["body1"]}));
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(r["bodies"], json!([]));
    assert_eq!(r["report"], "Nothing built to check.");
    assert_eq!(r["errors"][0]["feature_id"], "bx", "{r}");
}
