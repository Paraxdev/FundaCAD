use super::import::*;
use serde_json::{json, Value};

#[test]
fn free_ids_skip_taken_ones() {
    assert_eq!(free_ids(["f1", "f2"], 2), ["f3", "f4"]);
    assert_eq!(free_ids(["f1", "f3", "f4"], 3), ["f5", "f6", "f7"]);
    assert_eq!(free_ids(["a", "f2"], 2), ["f3", "f4"]);
    assert_eq!(free_ids([], 1), ["f1"]);
    assert!(free_ids(["f1"], 0).is_empty());
}

#[test]
fn unit_questions_and_order() {
    assert!(asks_for_unit("gltf") && asks_for_unit("vrml") && !asks_for_unit("stl"));
    assert_eq!(unit_choices("cm"), ["cm", "mm", "m", "inch"]);
    assert_eq!(unit_choices("yd"), IMPORT_UNITS);
    assert_eq!(as_import_unit("inch"), Some("inch"));
    assert_eq!(as_import_unit("in"), None);
    assert_eq!(
        Value::Object(import_fields("a.glb", "glb", Some("mm"))),
        json!({"path": "a.glb", "format": "glb", "unit": "mm"})
    );
    assert_eq!(Value::Object(import_fields("a.stl", "stl", Some("mm"))), json!({"path": "a.stl", "format": "stl"}));
}

#[test]
fn a_drawing_adds_one_sketch_per_layer_then_its_geometry() {
    let reply = json!({
        "name": "plate",
        "sketches": [
            {"name": "Outline", "entities": [{"type": "line"}], "fillRule": "evenodd"},
            {"name": "Holes", "entities": []},
        ],
        "geom": {"blob": "abc"},
        "solid": false,
        "unit": "mm",
        "scan": false,
    });
    let doc = json!({"features": [{"id": "f1"}, {"id": "f3"}]});
    let taken = feature_ids(doc.as_object().unwrap());
    assert_eq!(taken, ["f1", "f3"]);
    let out = import_features(reply.as_object().unwrap(), "dxf", "C:/a/plate.dxf", &taken);
    assert_eq!(
        out,
        [
            json!({"id": "f4", "type": "sketch", "plane": "XY", "name": "Outline", "entities": [{"type": "line"}], "fillRule": "evenodd"}),
            json!({"id": "f5", "type": "sketch", "plane": "XY", "name": "Holes", "entities": []}),
            json!({"id": "f6", "type": "import", "format": "dxf", "name": "plate", "geom": {"blob": "abc"},
                   "source": "C:/a/plate.dxf", "solid": false, "unit": "mm"}),
        ]
    );
}

#[test]
fn a_mesh_import_is_one_feature_with_what_the_reply_carried() {
    let reply = json!({"name": "scan", "geom": {"b": 1}, "color": "#aabbcc", "nodes": [1], "scan": true});
    let out = import_features(reply.as_object().unwrap(), "ply", "s.ply", &[]);
    assert_eq!(
        out,
        [json!({"id": "f1", "type": "import", "format": "ply", "name": "scan", "geom": {"b": 1}, "source": "s.ply",
                "solid": true, "color": "#aabbcc", "nodes": [1], "scan": true})]
    );
    assert!(import_features(json!({"name": "empty"}).as_object().unwrap(), "svg", "e.svg", &[]).is_empty());
}
