//! The server over a real pipe, spoken to by a real client. A port of
//! the Python MCP server's `test_protocol.py`.
//!
//! Everything else here tests a function. This tests the PROTOCOL, which is
//! where the failures nothing else can see live: a stray write to stdout
//! corrupts the stream, a reply to a notification is a protocol error the host
//! may hang up over, and a tool that fails instead of returning isError takes
//! the whole session down instead of telling the model what went wrong.
//!
//! The last group builds real geometry, so it spawns the engine and is the
//! slowest thing in this directory. It is here anyway: "can an agent go from an
//! empty document to a solid" is the only question this whole server exists to
//! answer.

mod common;

use std::collections::BTreeMap;

use common::{env, Mcp, ToolReply};
use serde_json::{json, Value};

fn drive(steps: &[(&str, Value)]) -> Vec<ToolReply> {
    let cwd = std::env::temp_dir();
    drive_in(&cwd, steps)
}

fn drive_in(cwd: &std::path::Path, steps: &[(&str, Value)]) -> Vec<ToolReply> {
    let mut mcp = Mcp::start(&BTreeMap::new(), cwd);
    steps
        .iter()
        .map(|(name, args)| mcp.call(name, args.clone()))
        .collect()
}

fn one(name: &str, args: Value) -> ToolReply {
    drive(&[(name, args)]).remove(0)
}

// --- the handshake -----------------------------------------------------------

#[test]
fn the_server_initializes_and_lists_its_tools() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    let tools = mcp.tools();
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .collect();
    for want in [
        "schema",
        "build",
        "inspect",
        "view",
        "feature_add",
        "param_set",
        "doc_save",
    ] {
        assert!(names.contains(&want), "{want} is not offered: {names:?}");
    }
    for t in &tools {
        let name = t["name"].as_str().unwrap_or_default();
        assert!(
            t.get("description").and_then(Value::as_str).is_some_and(|d| !d.is_empty()),
            "{name}"
        );
        assert_eq!(t["inputSchema"]["type"], json!("object"), "{name}");
        for req in t["inputSchema"]["required"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
        {
            let key = req.as_str().unwrap_or_default();
            assert!(
                t["inputSchema"]["properties"].get(key).is_some(),
                "{name}: {key}"
            );
        }
    }
}

#[test]
fn a_notification_gets_no_reply() {
    // MCP notifications carry no id, and answering one desynchronises every
    // reply after it: the client would match the next request against a stale
    // message and hang. `Mcp::start` sends `initialized` and then the first
    // tool call has to come back correctly, which is the assertion.
    let r = one("schema", json!({"type": "box"}));
    assert!(!r.is_error && r.text.contains("box"));
}

#[test]
fn an_unknown_tool_is_an_is_error_result_and_not_a_crash() {
    let r = one("no_such_tool", json!({}));
    assert!(r.is_error && r.text.contains("no_such_tool"), "{}", r.text);
}

#[test]
fn a_tool_that_fails_comes_back_as_is_error_with_the_reason() {
    let r = one("feature_add", json!({"feature": {"nope": 1}}));
    assert!(r.is_error && r.text.contains("type"), "{}", r.text);
}

#[test]
fn the_server_survives_a_failed_call_and_keeps_answering() {
    // The property that makes isError worth having: the session continues.
    let rs = drive(&[
        ("feature_add", json!({"feature": {}})),
        (
            "feature_add",
            json!({"feature": {"type": "box", "length": 1, "width": 1, "height": 1}}),
        ),
        ("doc_get", json!({})),
    ]);
    assert!(rs[0].is_error);
    assert!(!rs[1].is_error, "{}", rs[1].text);
    assert!(rs[2].text.contains("bx1"), "{}", rs[2].text);
}

// --- documents ---------------------------------------------------------------

#[test]
fn a_document_round_trips_through_a_file() {
    let tmp = tempfile::tempdir().expect("a temp dir");
    let path = tmp.path().join("part.funda");
    let path_text = path.to_string_lossy().replace('\\', "/");
    let rs = drive(&[
        ("param_set", json!({"name": "h", "expr": 12})),
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 40, "width": 30,
                               "height": "h"}}),
        ),
        ("doc_save", json!({"path": path_text})),
    ]);
    for r in &rs {
        assert!(!r.is_error, "{}", r.text);
    }
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("it was saved")).expect("JSON");
    assert_eq!(
        doc["features"][0]["height"],
        json!("h"),
        "the parameter reference was flattened"
    );
    assert_eq!(
        doc["parameters"]["h"],
        json!(12.0),
        "the derived cache the engine reads is missing"
    );
    assert_eq!(doc["paramDefs"]["h"]["expr"], json!("12"));

    let back = drive(&[
        (
            "doc_open",
            json!({"path": path.to_string_lossy().replace('\\', "/")}),
        ),
        ("doc_get", json!({})),
    ]);
    assert!(!back[0].is_error, "{}", back[0].text);
    assert!(back[1].text.contains("bx1"));
}

#[test]
fn a_relative_path_lands_where_the_caller_is_standing() {
    // A relative path resolves against the SERVER process's working directory.
    // An agent that ran the client from its own scratch directory and saved a
    // part watched that directory stay empty while the file appeared inside the
    // repository, which it had been told not to write to. Nothing said so: the
    // reply echoed back the relative path it had been given, which is true from
    // every directory and useful from none.
    let tmp = tempfile::tempdir().expect("a temp dir");
    let rs = drive_in(
        tmp.path(),
        &[
            (
                "feature_add",
                json!({"feature": {"id": "bx1", "type": "box", "length": 4, "width": 4,
                                   "height": 4}}),
            ),
            ("doc_save", json!({"path": "part.funda"})),
        ],
    );
    let last = rs.last().expect("two steps");
    assert!(!last.is_error, "{}", last.text);
    let landed = tmp.path().join("part.funda");
    assert!(landed.exists(), "not in the caller's directory");
    // and the reply says WHERE, so a caller never has to go looking
    assert!(
        last.text.contains(&landed.to_string_lossy().into_owned()),
        "{}",
        last.text
    );
}

#[test]
fn a_refused_edit_leaves_the_document_alone() {
    let rs = drive(&[
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 1, "width": 1,
                               "height": 1}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "sphere", "radius": 2}}),
        ),
        ("doc_get", json!({"features_only": true})),
    ]);
    assert!(rs[1].is_error, "{}", rs[1].text);
    let doc: Value = serde_json::from_str(&rs[2].text).expect("doc_get is JSON");
    assert_eq!(doc["features"].as_array().map(Vec::len), Some(1));
    assert_eq!(doc["features"][0]["type"], json!("box"));
}

#[test]
fn an_expression_in_a_feature_field_is_named_as_such() {
    // The mistake that looks like it ought to work. The app evaluates
    // expressions in the parameter table and writes numbers into fields, so a
    // field holds a number or a bare parameter NAME.
    let rs = drive(&[
        ("param_set", json!({"name": "d", "expr": 20})),
        (
            "feature_add",
            json!({"feature": {"id": "cy1", "type": "cylinder", "radius": "d/2",
                               "height": 30}}),
        ),
    ]);
    assert!(rs[1].text.contains("expression"), "{}", rs[1].text);
    assert!(rs[1].text.contains("param_set"), "{}", rs[1].text);
}

#[test]
fn a_document_problem_is_reported_before_a_build_is_attempted() {
    let r = one(
        "feature_add",
        json!({"feature": {"id": "ex1", "type": "extrude", "sketch": "nothing",
                           "distance": 1, "operation": "new"}}),
    );
    assert!(r.text.contains("nothing"), "{}", r.text);
}

// --- geometry (spawns the engine) --------------------------------------------

#[test]
fn an_empty_document_can_be_taken_all_the_way_to_a_solid() {
    let rs = drive(&[
        ("param_set", json!({"name": "d", "expr": 20})),
        ("param_set", json!({"name": "r", "expr": "d/2"})),
        (
            "feature_add",
            json!({"feature": {"id": "cy1", "type": "cylinder", "radius": "r",
                               "height": 30}}),
        ),
        ("build", json!({})),
        ("inspect", json!({})),
        ("view", json!({"view": "front", "width": 160, "height": 120})),
    ]);
    for (name, r) in [
        "param_set",
        "param_set",
        "feature_add",
        "build",
        "inspect",
        "view",
    ]
    .iter()
    .zip(&rs)
    {
        assert!(!r.is_error, "{name}: {}", r.text);
    }
    assert!(rs[3].text.contains("20.0 x 20.0 x 30.0"), "{}", rs[3].text);
    assert!(rs[4].text.contains("cylinder"), "{}", rs[4].text);
    let png = rs[5].images.first().expect("a render came back");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert!(png.len() > 200);
}

#[test]
fn a_failed_feature_is_reported_and_not_passed_off_as_a_no_op() {
    // The one that bit hardest while this was being written: a rebuild whose
    // feature fails carries the failure in `featureErrors` beside the geometry
    // that did build, not under `errors`. Reading the wrong key made a refused
    // press/pull look like a press/pull that did nothing at all.
    //
    // isError is also true here, on purpose: a body that built beside a
    // feature that failed is still a wrong document, and an agent gating on
    // isError alone (rather than string-matching "FEATURE FAILED") has to see
    // that. The full text, bodies included, still comes back.
    let rs = drive(&[
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 20, "width": 20,
                               "height": 20}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "fil1", "type": "fillet",
                               "edges": {"kind": "edge", "by": "all", "body": "body1"},
                               "radius": 500}}),
        ),
        ("build", json!({})),
    ]);
    assert!(rs[2].is_error, "{}", rs[2].text);
    assert!(rs[2].text.contains("FEATURE FAILED"), "{}", rs[2].text);
    assert!(rs[2].text.contains("fil1"), "{}", rs[2].text);
    assert!(rs[2].text.contains("body1"), "{}", rs[2].text);
}

#[test]
fn view_still_draws_a_partial_build() {
    // build's isError going true on a partial build (the test above) must not
    // make `view` refuse the whole picture: looking at what DID build is the
    // main way an agent checks its work, and a model whose fillet failed
    // (the debowler's chute_blend, in the field) is exactly when a picture
    // matters most. `view` triggers its own rebuild when stale, so this never
    // calls `build` directly.
    let rs = drive(&[
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 20, "width": 20,
                               "height": 20}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "fil1", "type": "fillet",
                               "edges": {"kind": "edge", "by": "all", "body": "body1"},
                               "radius": 500}}),
        ),
        ("view", json!({"view": "iso", "width": 96, "height": 96})),
    ]);
    assert!(!rs[2].is_error, "{}", rs[2].text);
    assert!(rs[2].text.contains("FEATURE FAILED"), "{}", rs[2].text);
    assert!(rs[2].text.contains("fil1"), "{}", rs[2].text);
    let png = rs[2].images.first().expect("a render came back");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn a_fillet_patched_into_a_chamfer_builds_as_a_chamfer() {
    let rs = drive(&[
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 20, "width": 20,
                               "height": 20}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "chute_edges", "type": "fillet",
                               "edges": {"kind": "edge", "by": "all", "body": "body1"},
                               "radius": 2}}),
        ),
        (
            "feature_update",
            json!({"id": "chute_edges",
                   "patch": {"type": "chamfer", "distance": 0.8, "radius": null}}),
        ),
        (
            "feature_update",
            json!({"id": "chute_edges", "patch": {"type": "fillet"}}),
        ),
        ("build", json!({})),
        ("doc_get", json!({"features_only": true})),
    ]);
    assert!(!rs[2].is_error, "{}", rs[2].text);
    assert!(rs[3].is_error, "a fillet with no radius was accepted: {}", rs[3].text);
    assert!(rs[3].text.contains("radius"), "{}", rs[3].text);
    assert!(!rs[4].is_error, "{}", rs[4].text);
    assert!(!rs[4].text.contains("FEATURE FAILED"), "{}", rs[4].text);
    let doc: Value = serde_json::from_str(&rs[5].text).expect("doc_get is JSON");
    assert_eq!(doc["features"][1]["type"], json!("chamfer"));
}

#[test]
fn a_cut_that_splits_a_body_is_reported() {
    let rs = drive(&[
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 200, "width": 200,
                               "height": 10}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "sk1", "type": "sketch", "plane": "XY", "entities": [
                {"type": "rectangle", "id": "r", "x": 99.8, "y": 0, "width": 0.2, "height": 220}]}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "cut1", "type": "extrude", "sketch": "sk1", "distance": 20,
                               "symmetric": true, "operation": "cut", "targets": ["body1"]}}),
        ),
        ("build", json!({})),
    ]);
    assert!(
        rs[3].text.contains("warning (cut1): the cut split Box into 2 pieces"),
        "{}",
        rs[3].text
    );
}

#[test]
fn inspect_hands_back_a_selector_that_addresses_the_face_it_names() {
    // The whole point of inspect: an agent that has never clicked on anything
    // can still write the next feature. The proof is using one of the selectors
    // it returns to press/pull that face, and getting a body that changed.
    let rs = drive(&[
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 20, "width": 20,
                               "height": 20}}),
        ),
        ("build", json!({})),
        ("inspect", json!({"detail": true, "selectors": true})),
    ]);
    assert!(!rs[2].is_error, "{}", rs[2].text);
    let (_, tail) = rs[2]
        .text
        .split_once("selectors:")
        .unwrap_or_else(|| panic!("{}", rs[2].text));
    let body: Value = serde_json::from_str(tail.trim()).expect("the selectors are JSON");
    let top = body["body1"]["faces"]
        .as_object()
        .expect("a face map")
        .values()
        .find(|sel| sel["fp"]["normal"] == json!([0.0, 0.0, 1.0]))
        .cloned()
        .expect("no face selector reported an upward normal");

    let rs2 = drive(&[
        (
            "feature_add",
            json!({"feature": {"id": "bx1", "type": "box", "length": 20, "width": 20,
                               "height": 20}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "pp1", "type": "press-pull", "face": top,
                               "distance": 5, "operation": "join"}}),
        ),
        ("build", json!({})),
    ]);
    assert!(!rs2[2].text.contains("FEATURE FAILED"), "{}", rs2[2].text);
    assert!(rs2[2].text.contains("20.0 x 20.0 x 25.0"), "{}", rs2[2].text);
}

#[test]
fn a_press_pull_along_the_axis_deepens_a_drilled_hole() {
    let drill = [[0.0, -11.0], [2.0, -11.0], [2.0, 4.0], [0.0, 6.0]];
    let entities: Vec<Value> = (0..4)
        .map(|i| {
            let (a, b) = (drill[i], drill[(i + 1) % 4]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
        })
        .collect();
    let rs = drive(&[
        ("param_set", json!({"name": "deeper", "expr": -2})),
        ("feature_add", json!({"feature": {"id": "bx1", "type": "box", "length": 20, "width": 20, "height": 20}})),
        ("feature_add", json!({"feature": {"id": "sk1", "type": "sketch", "plane": "XZ", "entities": entities}})),
        (
            "feature_add",
            json!({"feature": {"id": "drill", "type": "revolve", "sketch": "sk1", "axis": "Z", "angle": 360,
                               "operation": "cut", "targets": ["body1"]}}),
        ),
        (
            "feature_add",
            json!({"feature": {"id": "pp1", "type": "press-pull", "direction": "axis",
                               "face": {"kind": "face", "by": "nearest", "point": [0.7071, 0.7071, 5.0], "body": "body1"},
                               "distance": "deeper", "operation": "cut", "body": "body1"}}),
        ),
        ("build", json!({})),
    ]);
    for r in &rs {
        assert!(!r.is_error, "{}", r.text);
    }
    assert!(!rs[4].text.to_lowercase().contains("problem"), "{}", rs[4].text);
    assert!(!rs[5].text.contains("FEATURE FAILED"), "{}", rs[5].text);
    assert!(rs[5].text.contains("vol 7790.56 mm3, 8 faces"), "{}", rs[5].text);
}

#[test]
fn the_schema_is_also_a_resource() {
    // `fundacad://schema` is what a host reads without spending a tool call.
    let mut mcp = Mcp::start(&env(&[]), &std::env::temp_dir());
    let listed = mcp.rpc("resources/list", json!({}));
    assert_eq!(
        listed["result"]["resources"][0]["uri"],
        json!("fundacad://schema")
    );
    let read = mcp.rpc("resources/read", json!({"uri": "fundacad://schema"}));
    let text = read["result"]["contents"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(text.contains("FundaCAD document schema"), "{text:.120}");
    let missing = mcp.rpc("resources/read", json!({"uri": "fundacad://nope"}));
    assert!(missing.get("error").is_some(), "{missing}");
}
