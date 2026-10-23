use fundacad_protocol::envelope::*;
use serde_json::{json, Map};

#[test]
fn shapes() {
    let id = json!("r1");
    assert_eq!(ok(&id, &json!({"pong": true})), r#"{"id": "r1", "ok": true, "result": {"pong": true}}"#);
    assert_eq!(
        err(&id, "", Some(&json!("f1"))),
        r#"{"id": "r1", "ok": false, "error": {"message": "internal error (no message)", "feature_id": "f1"}}"#
    );
    assert_eq!(cancelled(&id), r#"{"id": "r1", "ok": false, "cancelled": true, "error": {"message": "cancelled"}}"#);
    assert_eq!(
        building(&id, 3, -1, -1),
        r#"{"id": "r1", "status": "building", "feature": 3, "meshed": -1, "meshTotal": -1}"#
    );
    assert_eq!(
        queued(&id, &json!({"op": "import", "who": "session"})),
        r#"{"id": "r1", "status": "queued", "behind": {"op": "import", "who": "session"}}"#
    );
    assert_eq!(started(&id), r#"{"id": "r1", "status": "started"}"#);
    assert_eq!(bad_json("x"), r#"{"id": null, "ok": false, "error": {"message": "bad JSON: x"}}"#);
}

#[test]
fn reply_for_dispatches() {
    let id = json!(7);
    let c = cancelled_result();
    assert_eq!(reply_for(&id, c.as_object().unwrap_or(&Map::new())), cancelled(&id));
    let e = json!({"error": {"message": "boom", "feature_id": null}});
    assert_eq!(
        reply_for(&id, e.as_object().unwrap_or(&Map::new())),
        r#"{"id": 7, "ok": false, "error": {"message": "boom"}}"#
    );
}
