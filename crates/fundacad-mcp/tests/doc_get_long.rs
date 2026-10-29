//! A long document through `doc_get` and back through `doc_set`: folded `bodyIds` and an import's left out
//! assembly lists come back whole, and `full` still hands out the document as stored.

mod common;

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn long_doc() -> Value {
    let nodes: Vec<Value> = (0..40).map(|i| json!({"name": format!("n{i}"), "parent": 0})).collect();
    let parts: Vec<Value> = (0..40).map(|i| json!({"node": i, "faces": 6})).collect();
    let mut ids = Map::new();
    ids.insert("f1:0".into(), json!("body1"));
    for i in 0..200 {
        ids.insert(format!("sep1:{i}"), json!(format!("body{}", i + 2)));
    }
    json!({
        "features": [
            {"type": "import", "id": "f1", "format": "step", "name": "Printer", "nodes": nodes, "parts": parts},
            {"type": "separate", "id": "sep1", "bodies": ["body1"]}
        ],
        "parameters": {},
        "paramDefs": {},
        "bodyIds": ids,
        "version": 10
    })
}

#[tokio::test]
async fn a_long_document_reads_short_and_comes_back_whole() {
    let engine = FakeEngine::start(|_, _| json!({"ok": true, "result": {}}));
    let srv = FundaCad::with_link(engine.link());
    let r = srv.t_doc_set(obj(json!({"document": long_doc()}))).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    let stored = text_of(&srv.t_doc_get(obj(json!({"full": true}))).await.unwrap());

    let short = text_of(&srv.t_doc_get(Map::new()).await.unwrap());
    assert!(short.len() * 4 < stored.len(), "{} against {}", short.len(), stored.len());
    let got: Value = serde_json::from_str(&short).expect("doc_get is JSON");
    assert_eq!(got["bodyIds"], json!({"f1:0": "body1", "sep1:0..sep1:199": "body2..body201"}));
    assert_eq!(got["features"][0]["nodes"], json!("40 nodes left out, doc_get full true lists them"));
    assert_eq!(got["features"][1], long_doc()["features"][1]);

    let r = srv.t_doc_set(obj(json!({"document": got}))).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    let back = text_of(&srv.t_doc_get(obj(json!({"full": true}))).await.unwrap());
    assert_eq!(back, stored, "doc_set of the short reply keeps every id and every node");
    let full: Value = serde_json::from_str(&back).unwrap();
    assert_eq!(full["bodyIds"], long_doc()["bodyIds"]);
    assert_eq!(full["features"][0]["parts"], long_doc()["features"][0]["parts"]);
}

#[tokio::test]
async fn a_short_reply_set_into_a_fresh_server_asks_for_the_full_one() {
    let engine = FakeEngine::start(|_, _| json!({"ok": true, "result": {}}));
    let first = FundaCad::with_link(engine.link());
    first.t_doc_set(obj(json!({"document": long_doc()}))).await.unwrap();
    let short: Value = serde_json::from_str(&text_of(&first.t_doc_get(Map::new()).await.unwrap())).unwrap();

    let fresh = FundaCad::with_link(engine.link());
    let r = fresh.t_doc_set(obj(json!({"document": short}))).await.unwrap();
    assert!(is_error(&r), "{}", text_of(&r));
    assert!(text_of(&r).contains("doc_get with full true"), "{}", text_of(&r));

    let mut ids_only: Value = serde_json::from_str(&text_of(&first.t_doc_get(Map::new()).await.unwrap())).unwrap();
    ids_only["features"] = long_doc()["features"].clone();
    let r = fresh.t_doc_set(obj(json!({"document": ids_only}))).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
    let got: Value =
        serde_json::from_str(&text_of(&fresh.t_doc_get(obj(json!({"full": true}))).await.unwrap())).unwrap();
    assert_eq!(got["bodyIds"], long_doc()["bodyIds"], "folded ids read back in a fresh server too");
}

#[tokio::test]
async fn a_bodyids_range_that_does_not_add_up_is_refused() {
    let engine = FakeEngine::start(|_, _| json!({"ok": true, "result": {}}));
    let srv = FundaCad::with_link(engine.link());
    let mut doc = long_doc();
    doc["bodyIds"] = json!({"sep1:0..sep1:9": "body2..body5"});
    let r = srv.t_doc_set(obj(json!({"document": doc}))).await.unwrap();
    assert!(is_error(&r), "{}", text_of(&r));
    assert!(text_of(&r).contains("does not count up alike"), "{}", text_of(&r));
}

#[tokio::test]
async fn a_long_timeline_puts_one_feature_to_a_line_and_a_short_one_reads_as_before() {
    let engine = FakeEngine::start(|_, _| json!({"ok": true, "result": {}}));
    let srv = FundaCad::with_link(engine.link());
    let boxes: Vec<Value> = (1..=40)
        .map(|i| json!({"type": "box", "id": format!("bx{i}"), "length": i, "width": 2, "height": 3}))
        .collect();
    srv.t_doc_set(obj(json!({"document": {"features": boxes}}))).await.unwrap();
    let out = text_of(&srv.t_doc_get(Map::new()).await.unwrap());
    let full = text_of(&srv.t_doc_get(obj(json!({"full": true}))).await.unwrap());
    assert!(full.len() > fundacad_mcp::docget::LINES_FROM);
    assert_eq!(out.lines().filter(|l| l.starts_with("  {\"type\": \"box\"")).count(), 40, "{out}");
    assert!(out.len() < full.len(), "{} against {}", out.len(), full.len());
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), serde_json::from_str::<Value>(&full).unwrap());

    srv.t_doc_set(obj(json!({"document": {"features": [{"type": "box", "id": "bx1", "length": 2}]}}))).await.unwrap();
    let short = text_of(&srv.t_doc_get(obj(json!({"features_only": true}))).await.unwrap());
    assert!(short.contains("\n   \"type\": \"box\",\n"), "{short}");
}
