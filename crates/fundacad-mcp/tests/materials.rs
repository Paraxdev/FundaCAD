//! The render material tools over the real protocol and the real engine.

mod common;

use std::collections::BTreeMap;

use common::{Mcp, ToolReply};
use serde_json::{json, Value};

fn ok(reply: ToolReply) -> String {
    assert!(!reply.is_error, "{}", reply.text);
    reply.text
}

fn refused(reply: ToolReply, word: &str) {
    assert!(reply.is_error, "{}", reply.text);
    assert!(reply.text.contains(word), "{word}: {}", reply.text);
}

fn box_part(mcp: &mut Mcp) -> Value {
    ok(mcp
        .call("feature_add", json!({"feature": {"id": "bx", "type": "box", "length": 30, "width": 20, "height": 10}})));
    let text = ok(mcp.call("inspect", json!({"detail": true, "selectors": true})));
    let (_, tail) = text.split_once("selectors:").unwrap_or_else(|| panic!("{text}"));
    let selectors: Value = serde_json::from_str(tail.trim()).expect("the selectors are JSON");
    selectors["body1"]["faces"].as_object().expect("a face map").values().next().expect("a face").clone()
}

fn saved_document(mcp: &mut Mcp, name: &str) -> Value {
    let path = std::env::temp_dir().join(format!("mcp-materials-{}-{name}.funda", std::process::id()));
    ok(mcp.call("doc_save", json!({"path": path})));
    let saved = serde_json::from_slice(&std::fs::read(&path).expect("saved")).expect("JSON");
    _ = std::fs::remove_file(&path);
    saved
}

#[test]
fn a_material_goes_on_a_body_and_a_face_and_comes_off_again() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    let face = box_part(&mut mcp);
    assert!(ok(mcp.call("material_list", json!({}))).contains("m-carpaint"));

    let made =
        ok(mcp.call("material_set", json!({"from": "m-glass", "name": "Green glass", "attenuationColor": "#2a8f6a"})));
    assert!(made.contains("Created m-green-glass"), "{made}");
    ok(mcp.call("material_assign", json!({"material": "m-green-glass", "bodies": ["body1"]})));
    ok(mcp.call(
        "material_assign",
        json!({"material": "m-steel", "faces": [face.clone(), {"body": "body1", "face": 4}]}),
    ));

    let list = ok(mcp.call("material_list", json!({})));
    assert!(list.contains("worn by bodies body1"), "{list}");
    assert!(list.contains("body1 F4"), "{list}");

    ok(mcp.call(
        "material_assign",
        json!({"material": null, "bodies": ["body1"], "faces": [{"body": "body1", "face": 4}, face]}),
    ));
    let list = ok(mcp.call("material_list", json!({})));
    assert!(!list.contains("worn by"), "{list}");
    ok(mcp.call("material_remove", json!({"ids": ["m-green-glass"]})));
    assert!(!ok(mcp.call("material_list", json!({}))).contains("m-green-glass"));
}

#[test]
fn what_cannot_be_assigned_is_refused_with_the_reason() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    box_part(&mut mcp);
    refused(mcp.call("material_assign", json!({"material": "m-steel"})), "bodies");
    refused(mcp.call("material_assign", json!({"material": "m-none", "bodies": ["body1"]})), "m-none");
    refused(mcp.call("material_assign", json!({"material": "m-steel", "bodies": ["body9"]})), "body9");
    refused(
        mcp.call("material_assign", json!({"material": "m-steel", "faces": [{"body": "body1", "edge": 0}]})),
        "not a face",
    );
    refused(
        mcp.call("material_assign", json!({"material": "m-steel", "faces": [{"body": "body1", "face": 99}]})),
        "faces[0]",
    );
    refused(mcp.call("material_remove", json!({"ids": ["m-none"]})), "m-none");
    refused(mcp.call("material_set", json!({"name": "A", "rougness": 0.3})), "rougness");
}

#[test]
fn faces_wait_while_the_timeline_is_not_whole_and_bodies_do_not() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    box_part(&mut mcp);
    let doc: Value = serde_json::from_str(&ok(mcp.call("doc_get", json!({})))).expect("a document");
    let mut doc = doc.as_object().expect("a map").clone();
    doc.insert("rollback".into(), json!(1));
    ok(mcp.call("doc_set", json!({"document": doc})));
    refused(
        mcp.call("material_assign", json!({"material": "m-steel", "faces": [{"body": "body1", "face": 0}]})),
        "rolled back",
    );
    ok(mcp.call("material_assign", json!({"material": "m-steel", "bodies": ["body1"]})));
}

#[test]
fn an_assigned_face_is_saved_with_its_print_and_a_later_fillet_does_not_lose_it() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    box_part(&mut mcp);
    let top = json!({"kind": "face", "by": "nearest", "point": [0, 0, 5], "body": "body1"});
    ok(mcp.call("material_assign", json!({"material": "m-steel", "faces": [top]})));
    ok(mcp.call(
        "feature_add",
        json!({"feature": {"id": "soft", "type": "fillet", "radius": 1,
                           "edges": {"kind": "edge", "by": "all", "body": "body1"}}}),
    ));
    ok(mcp.call("build", json!({})));
    let saved = saved_document(&mut mcp, "print");
    let keys = saved["faceMaterials"].as_object().expect("the face keys");
    assert_eq!(keys.len(), 1, "{saved}");
    let (key, material) = keys.iter().next().unwrap();
    assert_eq!(material, "m-steel");
    let print = &saved["facePrints"][key];
    assert_eq!(print["centroid"], json!([0, 0, 5]), "{print}");
    assert_eq!(print["normal"], json!([0, 0, 1]), "{print}");
    assert_eq!(print["area"], json!(600), "{print}");
    assert_eq!(print["surface"], "plane");
    assert_eq!(print["faces"], 6);
    assert_eq!(print["points"].as_array().map(Vec::len), Some(24), "{print}");

    let face: u64 = key.split('#').nth(1).unwrap().parse().unwrap();
    ok(mcp.call("material_assign", json!({"material": null, "faces": [{"body": "body1", "face": face}]})));
    let saved = saved_document(&mut mcp, "cleared");
    assert!(saved.get("facePrints").is_none(), "{saved}");
}
