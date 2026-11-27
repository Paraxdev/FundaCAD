use glam::Vec3;

use super::{apply, fastener_of, request, Doc, Map, Placement, Target, Value, ID};
use serde_json::json;

fn doc() -> Doc {
    let mut d = Doc::new();
    d.insert(
        "features".into(),
        json!([
            {"id": "f1", "type": "extrude"},
            {"id": "f2", "type": "import", "name": "M5x16", "geom": "old", "solid": true,
             "generatedBy": {"plugin": ID, "spec": {"name": "M5x16"}}},
        ]),
    );
    d
}

fn reply(geom: &str) -> Map<String, Value> {
    json!({"geom": geom, "solid": true}).as_object().unwrap().clone()
}

#[test]
fn the_request_carries_the_placement_only_when_there_is_one() {
    let spec = json!({"name": "M3x8"});
    let want = json!({"origin": [1.0, 2.0, 3.0], "zAxis": [-1.0, 0.0, 0.0]});
    let at = Placement { origin: Vec3::new(1.0, 2.0, 3.0), z: -Vec3::X };
    let r = request(&spec, Some(at));
    assert_eq!(r["placement"], want);
    assert_eq!(r["generator"], "fastener");
    assert_eq!(r["output"], "store");
    assert!(!request(&spec, None).contains_key("placement"));
}

#[test]
fn a_moved_fastener_keeps_its_feature_and_takes_the_new_solid() {
    let mut d = doc();
    apply(&mut d, &Target::Moved("f2".into()), &json!({"name": "M5x16"}), &reply("new")).unwrap();
    let f = &d["features"][1];
    assert_eq!(f["id"], "f2");
    assert_eq!(f["geom"], "new");
    assert_eq!(f["generatedBy"]["spec"]["name"], "M5x16");
    assert!(apply(&mut d, &Target::Moved("f9".into()), &json!({}), &reply("x")).is_err());
}

#[test]
fn a_new_fastener_is_an_import_with_its_spec() {
    let mut d = doc();
    apply(&mut d, &Target::New, &json!({"name": "M3x8"}), &reply("g")).unwrap();
    let f = d["features"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(f["type"], json!("import"));
    assert_eq!(f["generatedBy"], json!({"plugin": ID, "spec": {"name": "M3x8"}}));
}

#[test]
fn only_fasteners_are_found_by_their_owners() {
    let d = doc();
    assert_eq!(fastener_of(&d, &["f1".into(), "f2".into()]), Some(("f2".into(), json!({"name": "M5x16"}))));
    assert_eq!(fastener_of(&d, &["f1".into()]), None);
}
