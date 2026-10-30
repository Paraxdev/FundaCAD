//! Material edits on the document map, checked against what the Render workspace would write for the same edit.

use fundacad_mcp::materials::starter;
use fundacad_mcp::materials_doc::*;
use fundacad_mcp::mesh::MeshBody;
use fundacad_mcp::model::{new_document, Doc};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn args(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn ids(doc: &Doc) -> Vec<String> {
    library(doc).iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
}

fn find(doc: &Doc, id: &str) -> Value {
    library(doc).into_iter().find(|m| m["id"] == id).map(Value::Object).unwrap_or(Value::Null)
}

/// `count` unit squares stacked up from `z`, one face each.
fn flat_faces(id: &str, count: u32, z: f32) -> MeshBody {
    let mut positions = vec![];
    let mut indices = vec![];
    for n in 0..count {
        let at = z + 5.0 * n as f32;
        positions.extend([0.0, 0.0, at, 1.0, 0.0, at, 1.0, 1.0, at, 0.0, 1.0, at]);
        indices.extend([0, 1, 2, 0, 2, 3].map(|i| i + 4 * n));
    }
    MeshBody {
        info: json!({"id": id, "faceCount": count}).as_object().unwrap().clone(),
        positions,
        indices,
        face_ids: (0..count).flat_map(|n| [n, n]).collect(),
        edges: vec![],
    }
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
fn a_graph_the_shader_could_not_compile_is_refused() {
    let out = |wires: Value| json!({"id": "o", "type": "output", "in": wires});
    let noise = json!({"id": "n", "type": "noise"});
    let ramp = json!({"id": "r", "type": "ramp", "in": {"t": "n"}});
    let cases = [
        (json!({"nodes": [noise, out(json!({"roughness": "gone"}))], "output": "o"}), "gone"),
        (json!({"nodes": [noise, ramp, out(json!({"roughness": "r"}))], "output": "o"}), "a colour"),
        (json!({"nodes": [noise, out(json!({"color": "n"}))], "output": "o"}), "a number"),
        (json!({"nodes": [noise, out(json!({"glow": "n"}))], "output": "o"}), "glow"),
        (
            json!({"nodes": [{"id": "n", "type": "mix", "in": {"a": "o"}}, out(json!({"bump": "n"}))], "output": "o"}),
            "output",
        ),
        (
            json!({"nodes": [{"id": "a", "type": "mix", "in": {"a": "b"}}, {"id": "b", "type": "mix", "in": {"a": "a"}},
                             out(json!({"bump": "a"}))], "output": "o"}),
            "loop",
        ),
        (json!({"nodes": [noise, noise, out(json!({"bump": "n"}))], "output": "o"}), "twice"),
        (
            json!({"nodes": [{"id": "a-b", "type": "noise"}, {"id": "a_b", "type": "noise"}, out(json!({"bump": "a-b"}))],
                   "output": "o"}),
            "twice",
        ),
        (json!({"nodes": [noise], "output": "n"}), "output"),
        (
            json!({"nodes": [{"id": "r", "type": "ramp", "params": {"colorA": "red"}}, out(json!({"color": "r"}))],
                   "output": "o"}),
            "colorA",
        ),
        (
            json!({"nodes": [{"id": "r", "type": "colorramp", "params": {"stops": "black to white"}},
                             out(json!({"color": "r"}))], "output": "o"}),
            "stops",
        ),
    ];
    for (graph, word) in cases {
        let mut doc = new_document();
        let e = set(&mut doc, &args(json!({"name": "A", "surfaceGraph": graph.clone()}))).unwrap_err().0;
        assert!(e.contains(word), "{graph}: {e}");
    }
    let good = json!({"nodes": [
        {"id": "n", "type": "noise", "params": {"scale": 3}},
        {"id": "r", "type": "colorramp", "params": {"stops": "0:#102030;1:#a0b0c0"}, "in": {"t": "n"}},
        {"id": "o", "type": "output", "in": {"roughness": "n", "color": "r"}, "params": {"colorAmount": 0.5}}
    ], "output": "o"});
    let mut doc = new_document();
    set(&mut doc, &args(json!({"name": "A", "surfaceGraph": good}))).unwrap();
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

#[test]
fn a_face_lost_in_a_rebuild_paints_nothing_and_the_list_says_so() {
    let mesh = flat_faces("body1", 2, 0.0);
    let here = fundacad_mcp::face_prints::body_prints(&mesh)[0].clone();
    let gone = fundacad_mcp::face_prints::body_prints(&flat_faces("body1", 3, 50.0))[1].clone();
    let mut d = new_document();
    d.insert("materials".into(), json!([{"id": "m-a", "color": "#102030"}, {"id": "m-b", "color": "#fff"}]));
    d.insert("faceMaterials".into(), json!({"body1#1": "m-a", "body1#0": "m-b", "body1#9": "m-b", "body2#0": "m-a"}));
    d.insert("facePrints".into(), json!({"body1#1": gone, "body1#0": here}));
    let mesh = [mesh];

    let got = paint(&d, &mesh);
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got["body1"].faces, BTreeMap::from([(0, [255, 255, 255])]), "F1 is another face by now");
    assert_eq!(
        lost_faces_note(&d, &mesh).as_deref(),
        Some(
            "On no face since a rebuild, so drawn nowhere: body1 F1 (m-a), body1 F9 (m-b), body2 F0 (m-a). Those numbers may name other faces now. material_assign can put a material on the face again, or clear the old number."
        )
    );

    let mut held = d.clone();
    held.insert("suppressed".into(), json!(["f1"]));
    assert_eq!(lost_faces_note(&held, &mesh), None, "numbers mean nothing while the timeline is not whole");

    d.insert("faceMaterials".into(), json!({"body1#0": "m-b"}));
    assert_eq!(lost_faces_note(&d, &mesh), None);
}

#[test]
fn saved_face_numbers_from_before_the_last_build_are_called_out() {
    let mut d = new_document();
    assert_eq!(unbuilt_faces_note(&d), None, "no face wears anything");
    d.insert("faceMaterials".into(), json!({"body1#1": "m-a"}));
    assert_eq!(
        unbuilt_faces_note(&d).as_deref(),
        Some(
            "The document has not been built since it last changed, so these face numbers may name other faces. After `build` they are current, and this list names any that are on no face."
        )
    );
    d.insert("rollback".into(), json!("f1"));
    assert_eq!(unbuilt_faces_note(&d), None, "a build does not move them while the timeline is not whole");
}

#[test]
fn a_face_moves_to_its_new_number_unless_the_timeline_is_not_whole() {
    let quad = |z: f32| [0.0, 0.0, z, 1.0, 0.0, z, 1.0, 1.0, z, 0.0, 1.0, z];
    let mesh = MeshBody {
        info: json!({"id": "body1", "faceCount": 2}).as_object().unwrap().clone(),
        positions: [quad(0.0), quad(5.0)].concat(),
        indices: vec![0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
        face_ids: vec![0, 0, 1, 1],
        edges: vec![],
    };
    let lower = fundacad_mcp::face_prints::body_prints(&mesh)[0].clone();
    let doc = |extra: Value| {
        let mut d = json!({"faceMaterials": {"body1#1": "m-a"}, "facePrints": {"body1#1": lower}});
        d.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        d.as_object().unwrap().clone()
    };

    let mut whole = doc(json!({}));
    rekey_faces(&mut whole, std::slice::from_ref(&mesh));
    assert_eq!(whole["faceMaterials"], json!({"body1#0": "m-a"}));
    assert_eq!(whole["facePrints"], json!({"body1#0": lower}));

    for off in [json!({"rollback": 1}), json!({"suppressed": ["f1"]})] {
        let mut held = doc(off);
        rekey_faces(&mut held, std::slice::from_ref(&mesh));
        assert_eq!(held["faceMaterials"], json!({"body1#1": "m-a"}));
    }
}

#[test]
fn the_live_edit_says_what_a_material_edit_changed_and_nothing_else() {
    let mut before = new_document();
    let m_a = json!({"id": "m-a", "name": "A", "color": "#111111"});
    before.insert("materials".into(), json!([m_a]));
    before.insert("bodyMaterial".into(), json!({"body1": "m-a", "body2": "m-a"}));
    before.insert("faceMaterials".into(), json!({"body1#1": "m-a", "body1#2": "m-a"}));
    before.insert("facePrints".into(), json!({"body1#1": {"p": [1]}, "body1#2": {"p": [2]}}));

    assert_eq!(live_edit(&before, &before), json!({"kind": "materials"}));

    let mut after = before.clone();
    after.insert("features".into(), json!([{"id": "other"}]));
    after.insert("bodyMaterial".into(), json!({"body1": "m-a", "body3": "m-a"}));
    after.insert("faceMaterials".into(), json!({"body1#1": "m-a", "body1#5": "m-a"}));
    after.insert("facePrints".into(), json!({"body1#1": {"p": [9]}, "body1#5": {"p": [5]}}));
    assert_eq!(
        live_edit(&before, &after),
        json!({"kind": "materials",
        "bodies": {"body2": null, "body3": "m-a"},
        "faces": [
            {"body": "body1", "face": 1, "material": "m-a", "print": {"p": [9]}},
            {"body": "body1", "face": 2, "material": null},
            {"body": "body1", "face": 5, "material": "m-a", "print": {"p": [5]}},
        ]})
    );

    let mut edited = before.clone();
    set(&mut edited, &args(json!({"id": "m-a", "roughness": 0.5}))).unwrap();
    let edit = live_edit(&before, &edited);
    assert_eq!(edit["library"], Value::Array(library(&edited).into_iter().map(Value::Object).collect()));
    assert!(edit.get("bodies").is_none() && edit.get("faces").is_none(), "{edit}");

    // The starter library stands in for a missing one, so writing it down is no change.
    let mut bare = new_document();
    let plain = bare.clone();
    assign(&mut bare, None, &["body1".to_string()], &[]).unwrap();
    assert_eq!(live_edit(&plain, &bare), json!({"kind": "materials"}));
}

#[test]
fn the_paint_for_view_reads_the_assignments_and_skips_what_it_cannot_place() {
    let mut d = new_document();
    d.insert(
        "materials".into(),
        json!([{"id": "m-a", "name": "A", "color": "#102030"}, {"id": "m-b", "color": "#fff"}]),
    );
    d.insert("bodyMaterial".into(), json!({"body1": "m-a", "body2": "m-gone"}));
    d.insert("faceMaterials".into(), json!({"body1#2": "m-b", "body3#0": "m-a", "nonsense": "m-a"}));
    let mesh = [flat_faces("body1", 3, 0.0), flat_faces("body3", 1, 0.0)];
    let got = paint(&d, &mesh);
    assert_eq!(got.len(), 2, "{got:?}");
    assert_eq!(got["body1"].body, Some([16, 32, 48]));
    assert_eq!(got["body1"].faces.get(&2), Some(&[255, 255, 255]));
    assert_eq!((got["body3"].body, got["body3"].faces.get(&0)), (None, Some(&[16, 32, 48])));

    // Under a rollback the numbers belong to another build than the one drawn.
    d.insert("rollback".into(), json!(1));
    let held = paint(&d, &mesh);
    assert_eq!(held["body1"].body, Some([16, 32, 48]));
    assert!(held["body1"].faces.is_empty() && !held.contains_key("body3"), "{held:?}");
}
