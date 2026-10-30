//! Material edits on the document map, checked against what the Render workspace would write for the same edit.

use fundacad_mcp::materials::starter;
use fundacad_mcp::materials_doc::*;
use fundacad_mcp::model::{new_document, Doc};
use serde_json::{json, Value};

fn args(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn ids(doc: &Doc) -> Vec<String> {
    library(doc).iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
}

fn find(doc: &Doc, id: &str) -> Value {
    library(doc).into_iter().find(|m| m["id"] == id).map(Value::Object).unwrap_or(Value::Null)
}

#[test]
fn a_missing_or_empty_library_reads_as_the_starter_and_rows_are_repaired() {
    let mut doc = new_document();
    let starter_ids: Vec<String> = starter().iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids(&doc), starter_ids);
    doc.insert("materials".into(), json!([]));
    assert_eq!(ids(&doc), starter_ids);
    doc.insert("materials".into(), json!([{"color": "#f00", "roughness": 3}, {"name": "no colour"}]));
    assert_eq!(
        Value::Object(library(&doc)[0].clone()),
        json!({"id": "m-material-1", "name": "m-material-1", "color": "#ff0000", "roughness": 1})
    );
    assert_eq!(library(&doc).len(), 1);
}

#[test]
fn creating_appends_to_the_library_like_add_material() {
    let mut doc = new_document();
    let out = set(&mut doc, &args(json!({"name": "Blue anodised", "metalness": 0.8}))).unwrap();
    assert!(out.created);
    assert_eq!(out.id, "m-blue-anodised");
    assert_eq!(
        Value::Object(out.material),
        json!({"id": "m-blue-anodised", "name": "Blue anodised", "color": "#9aa7b4", "metalness": 0.8})
    );
    let lib = doc["materials"].as_array().unwrap();
    assert_eq!(lib.len(), starter().len() + 1, "the starter rows are kept in front of it");
    let again = set(&mut doc, &args(json!({"name": "Blue anodised", "color": "#2050c0"}))).unwrap();
    assert_eq!(again.id, "m-blue-anodised-2");
    let unnamed = set(&mut doc, &args(json!({"id": "m-mine"}))).unwrap();
    assert_eq!((unnamed.id.as_str(), unnamed.material["name"].as_str()), ("m-mine", Some("Material")));
}

#[test]
fn from_copies_a_starter_or_document_material_under_a_fresh_name() {
    let mut doc = new_document();
    let out = set(&mut doc, &args(json!({"from": "m-glass", "attenuationColor": "#2a8f6a"}))).unwrap();
    assert_eq!(out.id, "m-glass-2");
    assert_eq!(out.material["name"], "Glass 2");
    assert_eq!(out.material["opacity"], json!(0.25));
    assert_eq!(out.material["attenuationColor"], "#2a8f6a");
    assert!(set(&mut doc, &args(json!({"from": "m-nothing"}))).unwrap_err().0.contains("m-nothing"));
}

#[test]
fn an_edit_keeps_the_other_fields_and_null_goes_back_to_the_default() {
    let mut doc = new_document();
    let edit = json!({"id": "m-carpaint", "roughness": 0.2, "clearcoat": null, "flakes": 0.6});
    let out = set(&mut doc, &args(edit)).unwrap();
    assert!(!out.created);
    assert_eq!(
        find(&doc, "m-carpaint"),
        json!({"id": "m-carpaint", "name": "Car paint, red", "color": "#a51321", "metalness": 0.55, "roughness": 0.2, "flakes": 0.6})
    );
    let renamed = set(&mut doc, &args(json!({"id": "m-carpaint", "name": "Paint"}))).unwrap();
    assert_eq!(renamed.material["name"], "Paint");
    assert_eq!(ids(&doc)[7], "m-carpaint", "an edit stays where it was");
}

#[test]
fn from_on_an_existing_material_resets_its_look_but_keeps_its_id_and_name() {
    let mut doc = new_document();
    let out = set(&mut doc, &args(json!({"id": "m-wood", "from": "m-chrome"}))).unwrap();
    assert_eq!(
        Value::Object(out.material),
        json!({"id": "m-wood", "name": "Wood", "color": "#e8ecf0", "metalness": 1, "roughness": 0.03})
    );
}

#[test]
fn out_of_range_numbers_are_clamped_and_said() {
    let mut doc = new_document();
    let out = set(&mut doc, &args(json!({"name": "Hot", "roughness": 1.5, "ior": 0.5}))).unwrap();
    assert_eq!(out.material["roughness"], json!(1));
    assert_eq!(out.material["ior"], json!(1));
    assert!(out.notes.iter().any(|n| n.contains("roughness") && n.contains("1.5")), "{:?}", out.notes);
    assert!(out.notes.iter().any(|n| n.contains("ior")), "{:?}", out.notes);
}

#[test]
fn typos_and_wrong_kinds_are_refused_before_anything_is_written() {
    let mut doc = new_document();
    let cases = [
        (json!({"name": "A", "rougness": 0.3}), "rougness"),
        (json!({"name": "A", "color": "red"}), "color"),
        (json!({"name": "A", "metalness": "high"}), "metalness"),
        (json!({"name": "A", "castsLight": "no"}), "castsLight"),
        (json!({"name": "A", "specularColor": 12}), "specularColor"),
        (json!({"name": "  "}), "name"),
        (json!({"id": "m-steel", "color": null}), "color"),
        (json!({"name": "A", "surface": {"kind": "plaid", "scale": 1, "amount": 0.5}}), "surface"),
        (json!({"name": "A", "surfaceGraph": {"nodes": [], "output": "out"}}), "surfaceGraph"),
    ];
    for (a, word) in cases {
        let e = set(&mut doc, &args(a.clone())).unwrap_err().0;
        assert!(e.contains(word), "{a}: {e}");
    }
    assert!(!doc.contains_key("materials"));
}

#[test]
fn a_surface_and_a_graph_are_stored_in_the_node_editor_form_and_repairs_are_said() {
    let mut doc = new_document();
    let graph = json!({
        "nodes": [
            {"id": "n1", "type": "noise", "params": {"scale": 4}, "x": 10, "y": 20},
            {"id": "n2", "type": "sparkle"},
            {"id": "out", "type": "output", "in": {"roughness": "n1"}}
        ],
        "output": "out"
    });
    let surface = json!({"kind": "brushed", "scale": 2, "amount": 1.4, "angle": 45});
    let out = set(&mut doc, &args(json!({"name": "Brushed", "surface": surface, "surfaceGraph": graph}))).unwrap();
    assert_eq!(out.material["surface"], json!({"kind": "brushed", "scale": 2, "amount": 1, "angle": 45}));
    assert_eq!(out.material["surfaceGraph"]["nodes"].as_array().unwrap().len(), 2);
    assert!(out.notes.iter().any(|n| n.contains("surface")), "{:?}", out.notes);
    assert!(out.notes.iter().any(|n| n.contains("n2")), "{:?}", out.notes);
}

#[test]
fn assigning_writes_the_overlays_and_the_library_and_clearing_takes_them_back_out() {
    let mut doc = new_document();
    doc.insert("facePrints".into(), json!({"body1#2": {"area": 1}, "body2#0": {"area": 2}}));
    assign(&mut doc, Some("m-steel"), &["body1".into()], &[("body1".into(), 2), ("body1".into(), 5)]).unwrap();
    assert_eq!(doc["bodyMaterial"], json!({"body1": "m-steel"}));
    assert_eq!(doc["faceMaterials"], json!({"body1#2": "m-steel", "body1#5": "m-steel"}));
    assert_eq!(doc["facePrints"], json!({"body2#0": {"area": 2}}), "a rewritten face resolves by its index");
    assert_eq!(doc["materials"].as_array().unwrap().len(), starter().len(), "worn, so the library is saved");
    let worn = uses(&doc);
    assert_eq!(worn["m-steel"].bodies, vec!["body1".to_string()]);
    assert_eq!(worn["m-steel"].faces, vec![("body1".to_string(), 2), ("body1".to_string(), 5)]);
    assert!(assign(&mut doc, Some("m-none"), &["body1".into()], &[]).unwrap_err().0.contains("m-none"));
    assign(&mut doc, None, &["body1".into()], &[("body1".into(), 2), ("body1".into(), 5)]).unwrap();
    for key in ["bodyMaterial", "faceMaterials", "materials"] {
        assert!(!doc.contains_key(key), "{key} is gone once nothing wears the starter library");
    }
}

#[test]
fn removing_drops_every_use_and_its_prints() {
    let mut doc = new_document();
    set(&mut doc, &args(json!({"id": "m-mine", "color": "#123456"}))).unwrap();
    assign(&mut doc, Some("m-mine"), &["body1".into(), "body2".into()], &[("body3".into(), 1)]).unwrap();
    assign(&mut doc, Some("m-steel"), &["body4".into()], &[]).unwrap();
    doc.insert("facePrints".into(), json!({"body3#1": {"area": 1}}));
    let gone = remove(&mut doc, &["m-mine".into()]).unwrap();
    assert_eq!(gone.bodies, vec!["body1".to_string(), "body2".to_string()]);
    assert_eq!(gone.faces, vec![("body3".to_string(), 1)]);
    assert_eq!(doc["bodyMaterial"], json!({"body4": "m-steel"}));
    assert!(!doc.contains_key("faceMaterials") && !doc.contains_key("facePrints"));
    assert!(!ids(&doc).contains(&"m-mine".to_string()));
    assert!(remove(&mut doc, &["m-mine".into()]).unwrap_err().0.contains("m-mine"));
}

#[test]
fn the_list_names_each_material_its_wearers_and_the_starter_to_copy_from() {
    let mut doc = new_document();
    let text = list(&doc);
    assert!(text.contains("no materials of its own"), "{text}");
    set(&mut doc, &args(json!({"id": "m-mine", "color": "#123456", "emissive": 0.5}))).unwrap();
    assign(&mut doc, Some("m-mine"), &["body1".into()], &[("body2".into(), 3)]).unwrap();
    doc.insert("bodyMaterial".into(), json!({"body1": "m-mine", "body9": "m-lost"}));
    let text = list(&doc);
    assert!(text.contains(r##""id":"m-mine","name":"Material","color":"#123456","emissive":0.5"##), "{text}");
    assert!(text.contains("body1") && text.contains("body2 F3"), "{text}");
    assert!(text.contains("m-lost"), "a body wearing a missing material is pointed out: {text}");
    assert!(text.contains("m-aluminium (Aluminium)"), "{text}");
}
