//! Imported geometry moved through the engine's socket rather than its disk.
//!
//! An `import` feature's `geom` is a hash into the blob store of the engine
//! that read the file, and that store is wherever THAT process resolved it.
//! This process may resolve a different one (another APPDATA, a sandbox, an
//! engine started by someone else), so saving and opening ask the engine for
//! the bytes, or hand them to it, instead of trusting a shared directory.

use base64::Engine as _;
use serde_json::{json, Value};

use crate::link::EngineLink;

const CHUNK: usize = 16 * 1024 * 1024;

fn reply_result(reply: &Value, op: &str) -> Result<Value, String> {
    if reply.get("ok") == Some(&json!(true)) {
        return Ok(reply.get("result").cloned().unwrap_or_else(|| json!({})));
    }
    let why = reply
        .get("error")
        .map(|e| e.get("message").and_then(Value::as_str).map_or_else(|| e.to_string(), str::to_string))
        .unwrap_or_else(|| reply.to_string());
    Err(format!("{op}: {why}"))
}

/// What a failed blob transfer means for the person reading the reply. An
/// engine that does not know the op is an older build than this server.
pub fn engine_problem(e: &str) -> String {
    if e.contains("unknown op") {
        format!(
            "The engine is an older build than this MCP server and cannot hand geometry over \
             ({e}). Run the fundacad-engine from the same build as fundacad-mcp, or restart \
             FundaCAD after updating it."
        )
    } else {
        format!("The engine could not be asked for the geometry: {e}")
    }
}

/// The blob's bytes from the engine, None when it has no such blob. Checked
/// against the hash before it is trusted, so a torn or stale file on the
/// engine's side is never written into a document.
pub async fn fetch(link: &EngineLink, hash: &str) -> Result<Option<Vec<u8>>, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut data: Vec<u8> = Vec::new();
    loop {
        let reply = link
            .call("blobRead", json!({"hash": hash, "offset": data.len()}))
            .await
            .map_err(|e| e.to_string())?;
        let r = reply_result(&reply, "blobRead")?;
        if r.get("missing") == Some(&json!(true)) {
            return Ok(None);
        }
        let size = r.get("size").and_then(Value::as_u64).unwrap_or(0) as usize;
        let piece = r
            .get("data")
            .and_then(Value::as_str)
            .and_then(|d| b64.decode(d).ok())
            .ok_or("blobRead: the engine sent no data")?;
        if piece.is_empty() && data.len() < size {
            return Err("blobRead: the engine stopped short of the whole blob".into());
        }
        data.extend_from_slice(&piece);
        if data.len() >= size {
            break;
        }
    }
    if crate::docfile::hash(&data) != hash {
        return Ok(None);
    }
    Ok(Some(data))
}

/// Make sure the engine holds every one of `blobs`, sending only the ones it
/// says it lacks.
pub async fn push(link: &EngineLink, blobs: &[(String, Vec<u8>)]) -> Result<usize, String> {
    if blobs.is_empty() {
        return Ok(0);
    }
    let hashes: Vec<&str> = blobs.iter().map(|(h, _)| h.as_str()).collect();
    let reply = link
        .call("blobHas", json!({"hashes": hashes}))
        .await
        .map_err(|e| e.to_string())?;
    let r = reply_result(&reply, "blobHas")?;
    let missing: Vec<&str> = r
        .get("missing")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut sent = 0;
    for (hash, data) in blobs.iter().filter(|(h, _)| missing.contains(&h.as_str())) {
        let mut offset = 0;
        loop {
            let end = (offset + CHUNK).min(data.len());
            let reply = link
                .call(
                    "blobWrite",
                    json!({"hash": hash, "offset": offset, "total": data.len(),
                           "data": b64.encode(&data[offset..end])}),
                )
                .await
                .map_err(|e| e.to_string())?;
            let r = reply_result(&reply, "blobWrite")?;
            offset = end;
            if r.get("stored") == Some(&json!(true)) {
                break;
            }
            if offset >= data.len() {
                return Err(format!("blobWrite: the engine did not keep {hash}"));
            }
        }
        sent += 1;
    }
    Ok(sent)
}
