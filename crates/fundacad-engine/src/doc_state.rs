//! The document the worker holds between rebuilds, patched by deltas.
//!
//! Replaces `_apply_doc_ops` in `sidecar/server.py`. The client sends only the
//! features that changed, `{baseRevision, revision, ops}`; anything the held
//! document cannot answer (a respawned worker, a missed revision, a gap the ops
//! leave) asks for the whole document once with `{"resync": true}`.

use serde_json::{Map, Value};

#[derive(Debug, Default)]
pub struct DocState {
    doc: Option<Value>,
    revision: Option<Value>,
}

impl DocState {
    /// The effective document for this request, or None when it needs a resync.
    /// `computeAll` always carries its document whole.
    pub fn apply(&mut self, req: &Map<String, Value>, _fresh: bool) -> Option<&Value> {
        if let Some(doc) = req.get("document") {
            self.doc = Some(doc.clone());
            self.revision = req.get("revision").cloned();
            return self.doc.as_ref();
        }
        let base = req.get("baseRevision").cloned().unwrap_or(Value::Null);
        if self.doc.is_none() || self.revision.clone().unwrap_or(Value::Null) != base {
            return None;
        }
        let empty = Map::new();
        let ops = req.get("ops").and_then(Value::as_object).unwrap_or(&empty);
        let doc = self.doc.as_mut()?.as_object_mut()?;
        for key in ["parameters", "bodyVisibility", "bodyIds"] {
            if let Some(v) = ops.get(key) {
                doc.insert(key.into(), v.clone());
            }
        }
        if let Some(len) = ops.get("length").and_then(Value::as_u64) {
            let len = len as usize;
            let feats = doc
                .entry("features")
                .or_insert_with(|| Value::Array(vec![]));
            if let Value::Array(a) = feats {
                a.resize(len, Value::Null);
            }
        }
        if let Some(Value::Array(sets)) = ops.get("set") {
            let Some(Value::Array(feats)) = doc.get_mut("features") else {
                self.doc = None;
                return None;
            };
            for pair in sets {
                let (Some(i), Some(f)) = (pair.get(0).and_then(Value::as_u64), pair.get(1)) else {
                    continue;
                };
                if let Some(slot) = feats.get_mut(i as usize) {
                    *slot = f.clone();
                }
            }
        }
        let hole =
            matches!(doc.get("features"), Some(Value::Array(a)) if a.iter().any(Value::is_null));
        if hole {
            self.doc = None;
            return None;
        }
        self.revision = req.get("revision").cloned();
        self.doc.as_ref()
    }
}
