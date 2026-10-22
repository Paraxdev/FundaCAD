use fundacad_mcp::edits::*;
use fundacad_mcp::model;
use serde_json::json;

#[test]
fn unknown_ops_and_arguments_are_named() {
    let mut doc = model::new_document();
    let e = apply(&mut doc, &json!({"op": "nope"}), &mut Vec::new()).err().unwrap();
    assert!(e.contains("no op 'nope'"), "{e}");
    let e = apply(&mut doc, &json!({"op": "remove", "id": "x", "at": 1}), &mut Vec::new()).err().unwrap();
    assert!(e.contains("'at'"), "{e}");
}
