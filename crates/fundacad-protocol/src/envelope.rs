//! Reply envelopes and the interim status frames.
//!
//! Replaces `_ok`, `_err`, `_reply_for` and `_cancelled_result` in
//! the Python engine's `wire.py`, and the progress frames the Python engine's `server.py` builds inline
//! (`_building_frame`, the `importing` callback, the cancel acknowledgement and
//! the bad JSON reply). Every function returns the JSON text of one message.

use crate::pyjson;
use serde_json::{json, Map, Value};

/// The result shape for a cancelled op. `ok:false` keeps older clients treating
/// it as a harmless failure, the `cancelled` flag tells a current one apart.
pub fn cancelled_result() -> Value {
    json!({"cancelled": true, "error": {"message": "cancelled"}})
}

pub fn ok(id: &Value, result: &Value) -> String {
    pyjson::to_string(&json!({"id": id, "ok": true, "result": result}))
}

/// An error reply. An empty message is replaced, a blank banner helps nobody.
pub fn err(id: &Value, message: &str, feature_id: Option<&Value>) -> String {
    let mut error = Map::new();
    let message = if message.is_empty() {
        "internal error (no message)"
    } else {
        message
    };
    error.insert("message".into(), Value::from(message));
    if let Some(fid) = feature_id {
        error.insert("feature_id".into(), fid.clone());
    }
    pyjson::to_string(&json!({"id": id, "ok": false, "error": error}))
}

pub fn cancelled(id: &Value) -> String {
    pyjson::to_string(&json!({
        "id": id, "ok": false, "cancelled": true,
        "error": {"message": "cancelled"},
    }))
}

/// Turn a job result object into its text reply: cancelled, error or ok.
pub fn reply_for(id: &Value, res: &Map<String, Value>) -> String {
    if pyjson::truthy(res.get("cancelled")) {
        return cancelled(id);
    }
    if let Some(error) = res.get("error") {
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        // `.get("feature_id")` in Python, so an explicit null is omitted too.
        let fid = error.get("feature_id").filter(|v| !v.is_null());
        return err(id, message, fid);
    }
    let mut out = String::new();
    out.push_str("{\"id\": ");
    pyjson::write_value(&mut out, id);
    out.push_str(", \"ok\": true, \"result\": ");
    pyjson::write_map(&mut out, res);
    out.push('}');
    out
}

/// `{"id", "status": "building", "feature", "meshed", "meshTotal"}`. `feature`
/// is -1 while tessellating, the mesh counters are -1 outside that phase.
pub fn building(id: &Value, feature: i64, meshed: i64, mesh_total: i64) -> String {
    pyjson::to_string(&json!({
        "id": id, "status": "building", "feature": feature,
        "meshed": meshed, "meshTotal": mesh_total,
    }))
}

/// `{"id", "status": "importing", "phase", "label", "pct"}`.
pub fn importing(id: &Value, phase: i64, label: &str, pct: i64) -> String {
    pyjson::to_string(&json!({
        "id": id, "status": "importing", "phase": phase, "label": label, "pct": pct,
    }))
}

/// `{"id", "status": "queued", "behind"}`: the request waits behind another
/// client's job, `behind` says whose and what it is.
pub fn queued(id: &Value, behind: &Value) -> String {
    pyjson::to_string(&json!({"id": id, "status": "queued", "behind": behind}))
}

/// `{"id", "status": "started"}`: a request that was told it was queued is now running.
pub fn started(id: &Value) -> String {
    pyjson::to_string(&json!({"id": id, "status": "started"}))
}

/// The reply to a `cancel` op: whether a running or queued request was hit.
pub fn cancel_ack(id: &Value, hit: bool) -> String {
    ok(id, &json!({"cancelled": hit}))
}

/// Malformed request text, answered with a null id since there is none to echo.
pub fn bad_json(detail: &str) -> String {
    err(&Value::Null, &format!("bad JSON: {detail}"), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes() {
        let id = json!("r1");
        assert_eq!(
            ok(&id, &json!({"pong": true})),
            r#"{"id": "r1", "ok": true, "result": {"pong": true}}"#
        );
        assert_eq!(
            err(&id, "", Some(&json!("f1"))),
            r#"{"id": "r1", "ok": false, "error": {"message": "internal error (no message)", "feature_id": "f1"}}"#
        );
        assert_eq!(
            cancelled(&id),
            r#"{"id": "r1", "ok": false, "cancelled": true, "error": {"message": "cancelled"}}"#
        );
        assert_eq!(
            building(&id, 3, -1, -1),
            r#"{"id": "r1", "status": "building", "feature": 3, "meshed": -1, "meshTotal": -1}"#
        );
        assert_eq!(
            queued(&id, &json!({"op": "import", "who": "session"})),
            r#"{"id": "r1", "status": "queued", "behind": {"op": "import", "who": "session"}}"#
        );
        assert_eq!(started(&id), r#"{"id": "r1", "status": "started"}"#);
        assert_eq!(
            bad_json("x"),
            r#"{"id": null, "ok": false, "error": {"message": "bad JSON: x"}}"#
        );
    }

    #[test]
    fn reply_for_dispatches() {
        let id = json!(7);
        let c = cancelled_result();
        assert_eq!(
            reply_for(&id, c.as_object().unwrap_or(&Map::new())),
            cancelled(&id)
        );
        let e = json!({"error": {"message": "boom", "feature_id": null}});
        assert_eq!(
            reply_for(&id, e.as_object().unwrap_or(&Map::new())),
            r#"{"id": 7, "ok": false, "error": {"message": "boom"}}"#
        );
    }
}
