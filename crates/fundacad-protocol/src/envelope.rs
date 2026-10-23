//! Reply envelopes and the interim status frames, mirroring `_ok`, `_err`, `_reply_for` and `_cancelled_result` of the
//! Python `wire.py`. Every function returns the JSON text of one message.

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
    let message = if message.is_empty() { "internal error (no message)" } else { message };
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

/// A `building` frame that also says which [`crate::build_phase`] the job is in. `feature` is the feature
/// running, -1 outside the feature phase, and the mesh counters are -1 outside the meshing phase.
pub fn building_in(id: &Value, phase: i64, feature: i64, meshed: i64, mesh_total: i64) -> String {
    pyjson::to_string(&json!({
        "id": id, "status": "building", "phase": phase, "feature": feature,
        "meshed": meshed, "meshTotal": mesh_total,
    }))
}

/// `{"id", "status": "importing", "phase", "label", "pct"}`. `phase` is an
/// [`crate::import_stage`], `pct` is -1 while the stage has no fraction.
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
