//! A document whose `features`, `parameters` or `paramDefs` has the wrong type is refused where it
//! comes in, so no later edit meets a shape it cannot work on.

mod common;

use common::{is_error, text_of, FakeEngine};
use fundacad_mcp::docfile;
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Map, Value};

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn misshapen() -> Vec<Value> {
    vec![
        json!({"features": {}}),
        json!({"features": "box"}),
        json!({"features": [], "paramDefs": []}),
        json!({"features": [], "parameters": 3}),
    ]
}

#[test]
fn a_file_with_a_misshapen_document_is_refused_on_open() {
    let tmp = tempfile::tempdir().unwrap();
    for (i, doc) in misshapen().into_iter().enumerate() {
        let path = tmp.path().join(format!("odd{i}.funda"));
        std::fs::write(&path, doc.to_string()).unwrap();
        let read = docfile::read(&path, Some(&tmp.path().join("b")));
        assert!(read.is_err(), "{doc} was opened");
    }
}

#[test]
fn a_well_shaped_document_without_parameters_still_opens() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("plain.funda");
    std::fs::write(&path, json!({"features": []}).to_string()).unwrap();
    assert!(docfile::read(&path, Some(&tmp.path().join("b"))).is_ok());
}

#[tokio::test]
async fn doc_set_refuses_a_misshapen_document_and_a_param_set_after_it_works() {
    let engine = FakeEngine::always(json!({"ok": false, "error": {"message": "no engine in this test"}}));
    let srv = FundaCad::with_link(engine.link());
    for doc in misshapen() {
        let r = srv.t_doc_set(args(json!({"document": doc}))).await.unwrap();
        assert!(is_error(&r), "{doc} was taken: {}", text_of(&r));
    }
    let r = srv.t_param_set(args(json!({"name": "w", "expr": "10"}))).await.unwrap();
    assert!(!is_error(&r), "{}", text_of(&r));
}
