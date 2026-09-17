//! The mesh result a rebuild hands to the wire.
//!
//! Replaces the result dicts `sidecar/server.py` passes to `sidecar/wire.py`:
//! the top-level result (`protocol`, `bbox`, `diagnostics`, ...) and its
//! per-body payloads. The mesh arrays are typed, at the width they travel in,
//! everything else stays JSON so a new field needs no protocol change.

use crate::pyjson;
use serde_json::{Map, Value};

/// One edge polyline of a body, for the outline pass.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Edge {
    pub points: Vec<[f32; 3]>,
    /// The two faces meet tangentially.
    pub smooth: bool,
}

/// A body whose mesh the client does not hold, sent in full.
///
/// `fields` carries every non-array field (`id`, `name`, `etag`, `faceOwners`,
/// `faceCount`, `bbox`, ...) in the order they are written. The mesh keys
/// (`positions`, `normals`, `indices`, `faceIds`, `edges`) are written where
/// `fields` already has them, whatever their placeholder value, and appended in
/// that order otherwise, which is how the Python dict update behaves.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FullBody {
    pub fields: Map<String, Value>,
    pub positions: Vec<f32>,
    pub normals: Option<Vec<f32>>,
    pub indices: Vec<u32>,
    pub face_ids: Vec<u32>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WireBody {
    /// The client already holds this etag. Sent verbatim, it should carry
    /// `id`, `name`, `etag` and `"unchanged": true`.
    Stub(Map<String, Value>),
    Full(FullBody),
}

/// A successful `rebuild` / `computeAll` result. `fields` is every top-level
/// key but `bodies`; a `bodies` placeholder in it pins where the list goes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MeshResult {
    pub fields: Map<String, Value>,
    pub bodies: Vec<WireBody>,
}

/// What a job produced: a mesh result, or any other result object (an error,
/// a resync, a cancellation, the reply of a non-mesh op).
#[derive(Debug, Clone, PartialEq)]
pub enum JobResult {
    Mesh(MeshResult),
    Json(Map<String, Value>),
}

pub(crate) const F32: &str = "f32";
pub(crate) const U32: &str = "u32";

impl FullBody {
    pub fn new(id: impl Into<Value>, name: impl Into<Value>, etag: impl Into<Value>) -> Self {
        let mut fields = Map::new();
        fields.insert("id".into(), id.into());
        fields.insert("name".into(), name.into());
        fields.insert("etag".into(), etag.into());
        FullBody {
            fields,
            ..Default::default()
        }
    }

    pub fn id(&self) -> &Value {
        self.fields.get("id").unwrap_or(&Value::Null)
    }

    /// The body as inline JSON, for the text reply a client that did not opt
    /// into binary frames receives.
    pub fn to_json(&self) -> Map<String, Value> {
        let floats = |v: &[f32]| Value::Array(v.iter().map(|x| f32_value(*x)).collect());
        let mut m = self.fields.clone();
        m.insert("positions".into(), floats(&self.positions));
        match &self.normals {
            Some(n) => {
                m.insert("normals".into(), floats(n));
            }
            None => {
                m.shift_remove("normals");
            }
        }
        m.insert(
            "indices".into(),
            self.indices.iter().copied().map(Value::from).collect(),
        );
        m.insert(
            "faceIds".into(),
            self.face_ids.iter().copied().map(Value::from).collect(),
        );
        let id = self.id();
        let edges = self
            .edges
            .iter()
            .map(|e| {
                let mut em = Map::new();
                let pts = e
                    .points
                    .iter()
                    .map(|p| Value::Array(p.iter().map(|x| f32_value(*x)).collect()));
                em.insert("points".into(), Value::Array(pts.collect()));
                em.insert("body".into(), id.clone());
                if e.smooth {
                    em.insert("smooth".into(), Value::Bool(true));
                }
                Value::Object(em)
            })
            .collect();
        m.insert("edges".into(), Value::Array(edges));
        m
    }
}

fn f32_value(x: f32) -> Value {
    serde_json::Number::from_f64(f64::from(x)).map_or(Value::Null, Value::Number)
}

impl WireBody {
    pub fn stub(id: impl Into<Value>, name: impl Into<Value>, etag: impl Into<Value>) -> Self {
        let mut m = Map::new();
        m.insert("id".into(), id.into());
        m.insert("name".into(), name.into());
        m.insert("etag".into(), etag.into());
        m.insert("unchanged".into(), Value::Bool(true));
        WireBody::Stub(m)
    }

    pub fn fields(&self) -> &Map<String, Value> {
        match self {
            WireBody::Stub(m) => m,
            WireBody::Full(b) => &b.fields,
        }
    }

    pub fn to_json(&self) -> Map<String, Value> {
        match self {
            WireBody::Stub(m) => m.clone(),
            WireBody::Full(b) => b.to_json(),
        }
    }

    /// `_body_wire_size`: an estimate for packing decisions only.
    pub fn wire_size(&self) -> usize {
        match self {
            WireBody::Stub(_) => 128,
            WireBody::Full(b) => {
                let mut n = b.positions.len()
                    + b.indices.len()
                    + b.face_ids.len()
                    + b.normals.as_ref().map_or(0, Vec::len);
                for e in &b.edges {
                    n += 3 * e.points.len() + 1;
                }
                let owners = b
                    .fields
                    .get("faceOwners")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                4 * n + 24 * owners + 256
            }
        }
    }

    /// `_manifest_entry`: one row of the head frame's manifest.
    pub fn manifest_entry(&self) -> Map<String, Value> {
        let f = self.fields();
        let get = |k: &str| f.get(k).cloned().unwrap_or(Value::Null);
        let mut e = Map::new();
        e.insert("id".into(), get("id"));
        e.insert("name".into(), get("name"));
        e.insert("etag".into(), get("etag"));
        for key in ["nodeRef", "faceColors", "partColor"] {
            if let Some(v) = f.get(key).filter(|v| !v.is_null()) {
                e.insert(key.into(), v.clone());
            }
        }
        let b = match self {
            WireBody::Stub(_) => {
                e.insert("unchanged".into(), Value::Bool(true));
                return e;
            }
            WireBody::Full(b) => b,
        };
        e.insert(
            "faceCount".into(),
            f.get("faceCount").cloned().unwrap_or(Value::from(0)),
        );
        e.insert("nVerts3".into(), b.positions.len().into());
        e.insert("nIdx".into(), b.indices.len().into());
        e.insert("nTris".into(), b.face_ids.len().into());
        e.insert("nEdges".into(), b.edges.len().into());
        if b.normals.is_some() {
            e.insert("hasNormals".into(), Value::Bool(true));
        }
        e
    }
}

impl MeshResult {
    /// The whole result as inline JSON, bodies included.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut m = self.fields.clone();
        let bodies = self
            .bodies
            .iter()
            .map(|b| Value::Object(b.to_json()))
            .collect();
        m.insert("bodies".into(), Value::Array(bodies));
        m
    }

    /// `"error" in res or res.get("resync")`: not a mesh reply after all.
    pub(crate) fn is_error_or_resync(&self) -> bool {
        self.fields.contains_key("error") || pyjson::truthy(self.fields.get("resync"))
    }
}

impl JobResult {
    pub fn body_count(&self) -> usize {
        match self {
            JobResult::Mesh(m) => m.bodies.len(),
            JobResult::Json(m) => m
                .get("bodies")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
        }
    }

    pub fn to_json(&self) -> Map<String, Value> {
        match self {
            JobResult::Mesh(m) => m.to_json(),
            JobResult::Json(m) => m.clone(),
        }
    }
}
