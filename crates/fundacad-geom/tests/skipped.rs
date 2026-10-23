//! A feature of a type this build does not know, from a newer version's file, is left out without failing the build:
//! everything else builds and the reply lists what was left out.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::jobs::rebuild_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled")
}

fn messages(r: &Rebuild) -> Vec<&str> {
    r.errors.iter().map(|e| e.message.as_str()).collect()
}

fn skipped(r: &Rebuild) -> Vec<(&str, &str)> {
    r.skipped.iter().map(|s| (s.feature_id.as_str(), s.type_name.as_str())).collect()
}

fn reply(doc: &Value) -> Map<String, Value> {
    match rebuild_result(doc, 0.5, &Map::new(), &NoWatch) {
        JobResult::Json(m) => m,
        JobResult::Mesh(m) => m.fields,
    }
}

#[test]
fn a_feature_of_an_unknown_type_is_skipped_and_the_rest_builds() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "w1", "type": "futureWidget", "size": 3},
        {"id": "b2", "type": "box", "length": 2, "width": 2, "height": 2}
    ]});
    let r = build(&doc);
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    assert_eq!(skipped(&r), vec![("w1", "futureWidget")]);
    assert_eq!(r.bodies.len(), 2, "the box after the skipped feature still builds");
}

#[test]
fn a_document_of_nothing_but_unknown_types_is_an_ok_reply_that_lists_them() {
    let doc = json!({"parameters": {}, "features": [{"id": "w1", "type": "futureWidget"}]});
    let m = reply(&doc);
    assert!(!m.contains_key("error"), "{m:?}");
    assert_eq!(
        m["skippedFeatures"],
        json!([{"feature_id": "w1", "type": "futureWidget", "message": "unknown feature type: futureWidget"}])
    );
}

#[test]
fn the_reply_lists_skips_beside_the_bodies() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "w1", "type": "futureWidget"}
    ]});
    let m = reply(&doc);
    assert_eq!(m["skippedFeatures"][0]["feature_id"], "w1");
    assert!(!m.contains_key("featureErrors"), "a skip is not an error: {m:?}");
}

#[test]
fn a_feature_that_names_a_skipped_one_says_why_it_failed() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "w1", "type": "futureWidget"},
        {"id": "e1", "type": "extrude", "sketch": "w1", "distance": 5, "operation": "new"}
    ]});
    let r = build(&doc);
    let m = messages(&r);
    assert_eq!(m.len(), 1, "{m:?}");
    assert!(m[0].ends_with(" (w1 is from a newer version of FundaCAD and is not built here)"), "{m:?}");
}

#[test]
fn a_body_only_a_skipped_feature_made_is_named_as_the_cause() {
    let doc = json!({"parameters": {}, "bodyIds": {"b1:0": "body1", "w1:0": "body2"}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "w1", "type": "futureWidget"},
        {"id": "f1", "type": "fillet", "edges": {"kind": "edge", "by": "all", "body": "body2"}, "radius": 1}
    ]});
    let r = build(&doc);
    let m = messages(&r);
    assert_eq!(m.len(), 1, "{m:?}");
    assert!(m[0].ends_with(" (w1 is from a newer version of FundaCAD and is not built here)"), "{m:?}");
}

#[test]
fn a_switched_off_unknown_feature_is_not_listed() {
    let doc = json!({"parameters": {"on": 0}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "w1", "type": "futureWidget", "activeWhen": "on"}
    ]});
    let r = build(&doc);
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
    assert!(r.skipped.is_empty(), "{:?}", skipped(&r));
}

/// A plugin that is installed but cannot run is a failure the user can fix, so
/// its features still fail rather than being skipped.
#[cfg(feature = "plugins")]
#[test]
fn a_declared_plugin_that_will_not_load_still_fails_its_features() {
    let dir = std::env::temp_dir().join(format!("fundacad_skipped_{}", std::process::id()));
    let plugin = dir.join("Test.Old");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("manifest.json"), r#"{"id": "Test.Old", "featureTypes": ["oldThing"]}"#).unwrap();
    std::env::set_var("FUNDACAD_PLUGIN_DIR", &dir);
    fundacad_geom::plugins::reset_for_tests();
    fundacad_geom::plugins::load();

    let doc = json!({"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "o1", "type": "oldThing"}
    ]});
    let r = build(&doc);
    assert!(fundacad_geom::plugins::declares_feature("oldThing"));
    assert!(!fundacad_geom::plugins::declares_feature("futureWidget"));
    assert!(r.skipped.is_empty(), "{:?}", skipped(&r));
    let m = messages(&r);
    assert_eq!(m.len(), 1, "{m:?}");
    assert!(m[0].contains("Test.Old") && m[0].contains("would not load"), "{m:?}");

    std::env::remove_var("FUNDACAD_PLUGIN_DIR");
    fundacad_geom::plugins::reset_for_tests();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_future_fixture_builds_all_but_what_it_does_not_know() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/future/v99.funda");
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    doc.as_object_mut().unwrap().remove("geometry");
    let typed = CadDocument::from_value_lenient(&doc).expect("document parses");
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert_eq!(skipped(&r), vec![("w1", "futureWidget")]);
    let m = messages(&r);
    assert_eq!(m.len(), 1, "{m:?}");
    assert!(m[0].ends_with(" (w1 is from a newer version of FundaCAD and is not built here)"), "{m:?}");
    assert_eq!(r.bodies.len(), 2, "the extrude and the box after the skipped feature build");
}

#[test]
fn a_cache_resume_past_a_skipped_feature_still_lists_it() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "w1", "type": "futureWidget"},
        {"id": "b2", "type": "box", "length": 2, "width": 2, "height": 2}
    ]});
    let mut cache = RebuildCache::new(None);
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let first = cache.rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    assert_eq!(skipped(&first), vec![("w1", "futureWidget")]);

    let mut edited = doc.clone();
    edited["features"][2]["length"] = json!(3);
    let typed: CadDocument = serde_json::from_value(edited.clone()).unwrap();
    let again = cache.rebuild(&typed, &edited, &NoWatch).expect("not cancelled");
    assert_eq!(cache.stats.resumed_at, 2, "the edit below the skipped feature resumes past it");
    assert_eq!(skipped(&again), vec![("w1", "futureWidget")]);
}

#[test]
fn a_failure_with_no_bodies_still_lists_what_was_skipped() {
    let doc = json!({"parameters": {}, "bodyIds": {"w1:0": "body1"}, "features": [
        {"id": "w1", "type": "futureWidget"},
        {"id": "f1", "type": "fillet", "edges": {"kind": "edge", "by": "all", "body": "body1"}, "radius": 1}
    ]});
    let m = reply(&doc);
    assert!(!m.contains_key("error"), "{m:?}");
    assert_eq!(m["skippedFeatures"][0]["feature_id"], "w1");
    assert_eq!(m["featureErrors"][0]["feature_id"], "f1", "{m:?}");
}

#[test]
fn the_cause_is_named_by_its_name_without_advice_that_cannot_be_followed() {
    let doc = json!({"parameters": {}, "features": [
        {"id": "w1", "type": "futureSketch", "name": "Gusset profile"},
        {"id": "e1", "type": "extrude", "sketch": "w1", "distance": 5, "operation": "new"}
    ]});
    let r = build(&doc);
    let m = messages(&r);
    assert_eq!(m.len(), 1, "{m:?}");
    assert!(!m[0].contains("fix that sketch"), "{m:?}");
    assert!(m[0].ends_with(" (Gusset profile is from a newer version of FundaCAD and is not built here)"), "{m:?}");
}
