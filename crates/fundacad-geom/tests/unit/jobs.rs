use fundacad_geom::builder::NoWatch;
use fundacad_geom::cache;
use fundacad_geom::jobs::*;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};

fn run(doc: Value) -> JobResult {
    rebuild_result(&doc, 0.1, &Map::new(), &NoWatch)
}

#[test]
fn a_built_body_comes_back_meshed_with_the_result_keys() {
    let JobResult::Mesh(m) = run(json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "p", "type": "datumPlane", "plane": "XY", "offset": 3},
        {"id": "x", "type": "shell", "thickness": 0},
    ]})) else {
        panic!("expected a mesh result");
    };
    let keys: Vec<&str> = m.fields.keys().map(String::as_str).collect();
    assert_eq!(keys, ["protocol", "bodies", "bbox", "bodyIds", "datumPlanes", "featureError", "featureErrors"]);
    assert_eq!(m.fields["bodyIds"], json!({"a:0": "body1"}));
    assert_eq!(m.fields["featureError"], json!({"message": "Shell: thickness must not be 0", "feature_id": "x"}));
    assert_eq!(m.bodies.len(), 1);
    let bbox = &m.fields["bbox"];
    assert!((bbox["min"][0].as_f64().unwrap() + 5.0).abs() < 1e-6, "{bbox}");
}

#[test]
fn nothing_built_with_an_error_is_the_fatal_reply() {
    let JobResult::Json(m) = run(json!({"features": [
        {"id": "b", "type": "box", "length": 0, "width": 1, "height": 1},
    ]})) else {
        panic!("expected a json result");
    };
    assert_eq!(
        Value::Object(m),
        json!({"error": {"message": "Box: length must be greater than 0 (got 0)", "feature_id": "b"}})
    );
}

#[test]
fn a_document_of_sketches_is_not_an_error() {
    let JobResult::Json(m) = run(json!({"bodyIds": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": []},
    ]})) else {
        panic!("expected a json result");
    };
    assert_eq!(Value::Object(m), json!({"protocol": 2, "bodies": [], "bbox": null}));
}

#[test]
fn an_edited_move_rebuilds_where_its_new_values_put_the_body() {
    let doc = |dx: f64, rz: f64| {
        json!({"features": [
            {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
            {"id": "m", "type": "move", "dx": dx, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": rz, "bodies": ["body1"]},
        ]})
    };
    let mut cache = cache::RebuildCache::new(None);
    let mut known = Map::new();
    let mut bbox_x = |d: Value, known: &mut Map<String, Value>| {
        let JobResult::Mesh(m) = rebuild_result_cached(&d, 0.1, known, &NoWatch, &mut cache) else {
            panic!("expected a mesh result");
        };
        let fundacad_protocol::WireBody::Full(body) = &m.bodies[0] else {
            panic!("an edited move must resend its body, not a stub");
        };
        known.insert("body1".into(), body.fields["etag"].clone());
        let b = &m.fields["bbox"];
        (b["min"][0].as_f64().unwrap(), b["max"][0].as_f64().unwrap())
    };
    let (lo, hi) = bbox_x(doc(10.0, 0.0), &mut known);
    assert!((lo - 0.0).abs() < 1e-6 && (hi - 20.0).abs() < 1e-6, "{lo} {hi}");
    let (lo, hi) = bbox_x(doc(40.0, 0.0), &mut known);
    assert!((lo - 30.0).abs() < 1e-6 && (hi - 50.0).abs() < 1e-6, "{lo} {hi}");
    let half_diag = 10.0 * std::f64::consts::SQRT_2;
    let (lo, hi) = bbox_x(doc(40.0, 45.0), &mut known);
    assert!((lo - (40.0 - half_diag)).abs() < 1e-3, "{lo}");
    assert!((hi - (40.0 + half_diag)).abs() < 1e-3, "{hi}");
}

#[test]
fn an_unchanged_etag_is_answered_with_a_stub() {
    let doc = json!({"features": [{"id": "a", "type": "sphere", "radius": 3}]});
    let JobResult::Mesh(first) = run(doc.clone()) else { panic!("mesh") };
    let fundacad_protocol::WireBody::Full(body) = &first.bodies[0] else { panic!("full") };
    let mut known = Map::new();
    known.insert("body1".into(), body.fields["etag"].clone());
    let JobResult::Mesh(second) = rebuild_result(&doc, 0.1, &known, &NoWatch) else { panic!("mesh") };
    assert!(matches!(second.bodies[0], fundacad_protocol::WireBody::Stub(_)));
}
