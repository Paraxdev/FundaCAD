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
    assert_eq!(print["area"], json!(504), "{print}");
    assert_eq!(print["surface"], "plane");
    assert_eq!(print["faces"], 26);
    assert!(print["points"].as_array().is_some_and(|p| p.len() >= 12), "{print}");

    let face: u64 = key.split('#').nth(1).unwrap().parse().unwrap();
    ok(mcp.call("material_assign", json!({"material": null, "faces": [{"body": "body1", "face": face}]})));
    let saved = saved_document(&mut mcp, "cleared");
    assert!(saved.get("faceMaterials").is_none(), "{saved}");
    assert!(saved.get("facePrints").is_none(), "{saved}");
}

#[test]
fn a_filleted_face_keeps_one_material_and_the_number_measure_shows() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    box_part(&mut mcp);
    let top = json!({"kind": "face", "by": "nearest", "point": [0, 0, 5], "body": "body1"});
    ok(mcp.call("material_assign", json!({"material": "m-steel", "faces": [top.clone()]})));
    ok(mcp.call(
        "feature_add",
        json!({"feature": {"id": "soft", "type": "fillet", "radius": 1,
                           "edges": {"kind": "edge", "by": "all", "body": "body1"}}}),
    ));

    // No build between the fillet and this: the assign has to catch up first.
    ok(mcp.call("material_assign", json!({"material": "m-glass", "faces": [top.clone()]})));
    let saved = saved_document(&mut mcp, "second");
    let keys = saved["faceMaterials"].as_object().expect("the face keys");
    assert_eq!(keys.len(), 1, "{saved}");
    let (key, material) = keys.iter().next().unwrap();
    assert_eq!(material, "m-glass");
    let now: u64 = key.split('#').nth(1).unwrap().parse().unwrap();

    let measured = ok(mcp.call("measure", json!({"a": top})));
    assert!(measured.split(|c: char| !c.is_alphanumeric()).any(|w| w == format!("F{now}")), "F{now}: {measured}");
    assert!(ok(mcp.call("material_list", json!({}))).contains(&format!("body1 F{now}")));

    ok(mcp.call("material_assign", json!({"material": null, "faces": [{"body": "body1", "face": now}]})));
    assert!(saved_document(&mut mcp, "off").get("faceMaterials").is_none());
}

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mcp-materials.json")
}

// The numbers a print's sampled points hold follow the tessellation, so only these are held to the fixture.
fn stable_print(print: &Value) -> Value {
    json!([print["centroid"], print["normal"], print["area"], print["surface"], print["faces"]])
}

fn assert_same_materials(saved: &Value, want: &Value) {
    for key in ["features", "materials", "bodyMaterial", "faceMaterials"] {
        assert_eq!(saved[key], want[key], "{key}");
    }
    let (saved, want) = (saved["facePrints"].as_object().unwrap(), want["facePrints"].as_object().unwrap());
    assert_eq!(saved.keys().collect::<Vec<_>>(), want.keys().collect::<Vec<_>>());
    for (key, print) in want {
        assert_eq!(stable_print(&saved[key]), stable_print(print), "{key}");
    }
}

// tests/document/mcpMaterialsFile.test.ts reads the same fixture through the app's store.
// Set BLESS_MCP_MATERIALS=1 to write the fixture again after a change meant to alter the file.
#[test]
fn a_saved_file_holds_what_the_app_reads_and_opens_again_unchanged() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    box_part(&mut mcp);
    let graph = json!({"nodes": [
        {"id": "n", "type": "noise", "params": {"scale": 3}, "x": 40, "y": 60},
        {"id": "r", "type": "colorramp", "params": {"stops": "0:#102030;1:#a0b0c0"}, "in": {"t": "n"}},
        {"id": "o", "type": "output", "in": {"roughness": "n", "color": "r"}, "params": {"colorAmount": 0.5}}
    ], "output": "o"});
    ok(mcp.call(
        "material_set",
        json!({"name": "Teal paint", "color": "#1a7f7a", "metalness": 0.4, "roughness": 0.35, "clearcoat": 1,
               "flakes": 0.5, "flakeSize": 0.2,
               "surface": {"kind": "brushed", "scale": 2, "amount": 0.6, "angle": 45},
               "surfaceGraph": graph}),
    ));
    ok(mcp.call("material_set", json!({"from": "m-glass", "name": "Green glass", "attenuationColor": "#2a8f6a"})));
    ok(mcp.call("material_assign", json!({"material": "m-teal-paint", "bodies": ["body1"]})));
    let (top, bottom) = (
        json!({"kind": "face", "by": "nearest", "point": [0, 0, 5], "body": "body1"}),
        json!({"kind": "face", "by": "nearest", "point": [0, 0, -5], "body": "body1"}),
    );
    ok(mcp.call("material_assign", json!({"material": "m-green-glass", "faces": [top]})));
    ok(mcp.call("material_assign", json!({"material": "m-steel", "faces": [bottom]})));

    let path = std::env::temp_dir().join(format!("mcp-materials-{}-file.funda", std::process::id()));
    ok(mcp.call("doc_save", json!({"path": path})));
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).expect("saved")).expect("JSON");
    if std::env::var_os("BLESS_MCP_MATERIALS").is_some() {
        std::fs::write(fixture_path(), serde_json::to_string_pretty(&saved).unwrap() + "\n").expect("blessed");
    }
    let fixture = serde_json::from_slice(&std::fs::read(fixture_path()).expect("the fixture")).expect("JSON");
    assert_same_materials(&saved, &fixture);

    ok(mcp.call("doc_open", json!({"path": path})));
    let list = ok(mcp.call("material_list", json!({})));
    assert!(list.contains("worn by bodies body1"), "{list}");
    assert!(list.contains("m-green-glass"), "{list}");
    ok(mcp.call("build", json!({})));
    let again = saved_document(&mut mcp, "again");
    _ = std::fs::remove_file(&path);
    assert_same_materials(&again, &fixture);
}

#[test]
fn a_saved_face_that_is_gone_is_reported_and_not_painted_on_another_face() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    box_part(&mut mcp);
    ok(mcp.call("material_set", json!({"id": "m-green", "name": "Green", "color": "#00dd00"})));
    let shot = |mcp: &mut Mcp| {
        let reply = mcp.call("view", json!({"width": 200, "height": 200}));
        assert!(!reply.is_error, "{}", reply.text);
        reply.images.into_iter().next().expect("a picture")
    };
    let plain = shot(&mut mcp);

    let mut file = saved_document(&mut mcp, "lost");
    file["faceMaterials"] = json!({"body1#1": "m-green"});
    file["facePrints"] = json!({"body1#1": {"centroid": [0, 0, 500], "normal": [0, 0, 1], "area": 1, "surface": "plane",
                                            "points": [0, 0, 500], "faces": 7}});
    let path = std::env::temp_dir().join(format!("mcp-materials-{}-lost.funda", std::process::id()));
    std::fs::write(&path, file.to_string()).expect("written");
    ok(mcp.call("doc_open", json!({"path": path})));
    _ = std::fs::remove_file(&path);

    assert_eq!(shot(&mut mcp), plain, "the old number names another face now");
    let list = ok(mcp.call("material_list", json!({})));
    assert!(list.contains("On no face since a rebuild, so drawn nowhere: body1 F1 (m-green)."), "{list}");
    ok(mcp.call("material_assign", json!({"material": null, "faces": [{"body": "body1", "face": 1}]})));
    let list = ok(mcp.call("material_list", json!({})));
    assert!(!list.contains("On no face"), "{list}");
}

#[test]
fn view_shows_an_assigned_colour() {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    box_part(&mut mcp);
    let shot = |mcp: &mut Mcp| {
        let reply = mcp.call("view", json!({"width": 200, "height": 200}));
        assert!(!reply.is_error, "{}", reply.text);
        reply.images.into_iter().next().expect("a picture")
    };
    let plain = shot(&mut mcp);
    ok(mcp.call("material_set", json!({"id": "m-green", "name": "Green", "color": "#00dd00"})));
    assert_eq!(shot(&mut mcp), plain, "a material nothing wears paints nothing");
    ok(mcp.call("material_assign", json!({"material": "m-green", "bodies": ["body1"]})));
    let green = shot(&mut mcp);
    assert_ne!(green, plain);
    ok(mcp.call("material_assign", json!({"material": "m-green", "faces": [{"body": "body1", "face": 1}]})));
    ok(mcp.call("material_assign", json!({"material": null, "bodies": ["body1"]})));
    let one_face = shot(&mut mcp);
    assert_ne!(one_face, plain);
    assert_ne!(one_face, green);
}
