//! `doc_get` hands out only the geometry, so a `doc_set` of what it gave must not drop the rest of the open
//! document. In live mode the app loads the pushed document with a replacing load, which would lose it.

mod common;

use std::path::Path;

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn project_state() -> Value {
    json!({
        "stress": {"load": {"face": "body1:face7", "force": [12.5, -3.25, -40.0]}, "fixed": ["body1:face2"]},
        "environment": {"preset": "studio", "rotation": 37.5, "exposure": 1.3},
        "materials": {"body1": "pla", "body2": "aluminium-6061"},
        "palette": ["#c03a2b", "#2b7bc0", "#7a9e3f"],
        "elements": [{"id": "e1", "kind": "note", "at": [4.5, -7.25, 13.0]}],
        "referenceImages": [{"id": "r1", "plane": "XZ", "offset": [-6.0, 2.5]}],
        "bodyColors": {"body2": "#aa5500"},
        "faceColors": {"body1:face3": "#00aa55"}
    })
}

fn open_document() -> Value {
    let mut doc = json!({
        "version": 5,
        "parameters": {"wall": 2.5},
        "paramDefs": {"wall": {"expr": "2.5", "unit": "mm"}},
        "features": [{"id": "b1", "type": "box", "size": [30, 18, 7], "name": "base"}],
        "bodyIds": {}
    });
    for (k, v) in project_state().as_object().unwrap() {
        doc[k] = v.clone();
    }
    doc
}

fn incoming_features() -> Value {
    json!([{"id": "c1", "type": "cylinder", "radius": 4.25, "height": 13, "name": "peg"}])
}

fn write(path: &Path, doc: &Value) {
    std::fs::write(path, serde_json::to_string(doc).unwrap()).unwrap();
}

fn call<E: std::fmt::Debug>(r: Result<rmcp::model::CallToolResult, E>) {
    let r = r.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
}

async fn saved(srv: &FundaCad, dir: &Path, name: &str) -> Map<String, Value> {
    let path = dir.join(name);
    call(srv.t_doc_save(args(json!({"path": path.to_string_lossy()}))).await);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

async fn opened_server(dir: &Path) -> (FakeEngine, FundaCad) {
    let engine = FakeEngine::always(json!({"ok": false, "error": {"message": "no engine in this test"}}));
    let srv = FundaCad::with_link(engine.link());
    let path = dir.join("open.funda");
    write(&path, &open_document());
    call(srv.t_doc_open(args(json!({"path": path.to_string_lossy()}))).await);
    (engine, srv)
}

/// The document `doc_set` should leave: the incoming geometry over the open document's project state.
fn expected(incoming: &Value, kept: &[&str], body_ids: &Value) -> Map<String, Value> {
    let mut want = incoming.as_object().unwrap().clone();
    let state = project_state();
    for k in kept {
        want.entry(k.to_string()).or_insert_with(|| state[k].clone());
    }
    want.insert("bodyIds".into(), body_ids.clone());
    want.entry("parameters").or_insert_with(|| json!({}));
    want.entry("paramDefs").or_insert_with(|| json!({}));
    want.entry("version").or_insert_with(|| json!(fundacad_mcp::model::FORMAT_VERSION));
    want
}

const ALL_STATE: [&str; 8] =
    ["stress", "environment", "materials", "palette", "elements", "referenceImages", "bodyColors", "faceColors"];

#[tokio::test]
async fn a_doc_set_of_the_geometry_alone_keeps_the_open_documents_project_state() {
    let dir = tempfile::tempdir().unwrap();
    let (_engine, srv) = opened_server(dir.path()).await;
    let incoming = json!({"parameters": {"wall": 3.75}, "paramDefs": {"wall": {"expr": "3.75", "unit": "mm", "value": 3.75}},
                          "features": incoming_features()});
    call(srv.t_doc_set(args(json!({"document": incoming}))).await);

    let got = saved(&srv, dir.path(), "after.funda").await;
    assert_eq!(got, expected(&incoming, &ALL_STATE, &got["bodyIds"]));
    assert_eq!(got["features"], incoming_features());
}

#[tokio::test]
async fn a_key_the_assistant_sends_replaces_the_open_one_and_null_clears_it() {
    let dir = tempfile::tempdir().unwrap();
    let (_engine, srv) = opened_server(dir.path()).await;
    let incoming = json!({
        "features": incoming_features(),
        "stress": {"load": {"face": "body1:face4", "force": [0.0, 8.5, -2.0]}, "fixed": []},
        "materials": {},
        "environment": null
    });
    call(srv.t_doc_set(args(json!({"document": incoming}))).await);

    let got = saved(&srv, dir.path(), "after.funda").await;
    let mut want =
        expected(&incoming, &["palette", "elements", "referenceImages", "bodyColors", "faceColors"], &got["bodyIds"]);
    want.remove("environment");
    assert_eq!(got, want);
}

#[tokio::test]
async fn a_second_doc_set_without_the_state_still_keeps_it_and_doc_open_replaces_everything() {
    let dir = tempfile::tempdir().unwrap();
    let (_engine, srv) = opened_server(dir.path()).await;
    let incoming = json!({"features": incoming_features()});
    call(srv.t_doc_set(args(json!({"document": incoming}))).await);
    let again = json!({"features": [{"id": "s1", "type": "sphere", "radius": 6.5, "name": "knob"}]});
    call(srv.t_doc_set(args(json!({"document": again}))).await);
    let twice = saved(&srv, dir.path(), "twice.funda").await;
    assert_eq!(twice, expected(&again, &ALL_STATE, &twice["bodyIds"]));

    let other = dir.path().join("other.funda");
    let bare = json!({"version": 5, "parameters": {}, "paramDefs": {}, "bodyIds": {},
                      "features": [{"id": "t1", "type": "torus", "major": 9.5, "minor": 1.75}]});
    write(&other, &bare);
    call(srv.t_doc_open(args(json!({"path": other.to_string_lossy()}))).await);
    let reopened = saved(&srv, dir.path(), "reopened.funda").await;
    assert_eq!(Value::Object(reopened), bare);

    call(srv.t_doc_new(Map::new()).await);
    let fresh = saved(&srv, dir.path(), "fresh.funda").await;
    let empty = json!({"version": fundacad_mcp::model::FORMAT_VERSION, "parameters": {}, "paramDefs": {},
                       "features": [], "bodyIds": {}});
    assert_eq!(Value::Object(fresh), empty);
}
