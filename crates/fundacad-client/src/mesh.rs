//! Rebuild replies turned into plain buffers, and the per-body cache that `known` etags and unchanged stubs refer to.

use fundacad_protocol::frame::{decode_frame_raw, Buf};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

/// A body's edge polylines, packed as the wire carries them: `points` is xyz per point, `counts` the points of each
/// edge in order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Edges {
    pub points: Vec<f32>,
    pub counts: Vec<u32>,
    /// Indices of the edges whose two faces meet tangentially.
    pub smooth: Vec<u32>,
    /// `(edge, per mm of radius, per mm of chord)` for the edges a face curves across.
    pub curvature: Vec<(u32, f32, f32)>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Body {
    pub id: String,
    pub name: String,
    pub etag: String,
    pub positions: Vec<f32>,
    pub normals: Option<Vec<f32>>,
    pub indices: Vec<u32>,
    /// Per triangle, the face it belongs to, local to this body.
    pub face_ids: Vec<u32>,
    /// Per face, the feature that made it.
    pub face_owners: Vec<Option<String>>,
    pub edges: Edges,
    /// Every other field of the payload (`faceCount`, `fault`, `bbox`, colours), as JSON.
    pub fields: Map<String, Value>,
}

/// How long one rebuild took, from the edit that asked for it to the mesh being ready.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Timing {
    /// From the first edit this rebuild carries to the mesh event.
    pub total: Duration,
    /// Edit waiting for the rebuild before it to finish.
    pub queued: Duration,
    /// Request written to the final frame read, the worker's time plus the pipe.
    pub engine: Duration,
    /// Frames read back into buffers.
    pub decode: Duration,
    pub bytes: usize,
    pub frames: usize,
    pub full_send: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Mesh {
    pub revision: u64,
    pub bodies: Vec<Arc<Body>>,
    /// How many of `bodies` came new in this reply, the rest were unchanged and are the cached ones.
    pub fresh: usize,
    /// Every result field but `bodies`: `bbox`, `bodyIds`, `diagnostics`, `featureErrors` and the rest.
    pub result: Map<String, Value>,
    pub timing: Timing,
}

impl Mesh {
    pub fn triangles(&self) -> usize {
        self.bodies.iter().map(|b| b.indices.len() / 3).sum()
    }
}

impl fmt::Display for Mesh {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let t = &self.timing;
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        write!(
            f,
            "rebuild r{} {}: {:.1} ms (queued {:.1}, engine {:.1}, decode {:.2}), {} bodies ({} new), {} tris, {:.1} KiB in {} frames",
            self.revision,
            if t.full_send { "full" } else { "delta" },
            ms(t.total),
            ms(t.queued),
            ms(t.engine),
            ms(t.decode),
            self.bodies.len(),
            self.fresh,
            self.triangles(),
            t.bytes as f64 / 1024.0,
            t.frames,
        )
    }
}

#[derive(Debug, PartialEq)]
pub enum ReplyError {
    /// An unchanged stub names a body the cache does not hold at that etag, so the client resends whole.
    StaleStub(String),
    Corrupt(String),
}

impl From<String> for ReplyError {
    fn from(s: String) -> Self {
        ReplyError::Corrupt(s)
    }
}

impl fmt::Display for ReplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReplyError::StaleStub(id) => write!(f, "body {id} came as unchanged but is not held"),
            ReplyError::Corrupt(s) => f.write_str(s),
        }
    }
}

/// One terminal result being put together, from one frame or a stream of them.
#[derive(Default)]
pub struct Assembly {
    pub result: Map<String, Value>,
    pub bodies: Vec<Arc<Body>>,
    pub fresh: usize,
    manifest_len: Option<usize>,
    next_seq: usize,
}

pub enum Step {
    More,
    Done,
}

impl Assembly {
    /// Takes one binary frame of the reply. A stream's head brings the result fields and the manifest, each chunk a
    /// run of bodies, and the final frame closes it once every manifest body arrived in order.
    pub fn take_binary(&mut self, bytes: &[u8], cache: &BodyCache) -> Result<Step, ReplyError> {
        let (env, bufs) = decode_frame_raw(bytes)?;
        let mut result = match env.get("result") {
            Some(Value::Object(r)) => r.clone(),
            _ => return Err(ReplyError::Corrupt("a binary frame without a result".into())),
        };
        let bodies = match result.shift_remove("bodies") {
            Some(Value::Array(b)) => b,
            _ => Vec::new(),
        };
        self.take_bodies(&bodies, &bufs, cache)?;
        let Some(stream) = env.get("stream") else {
            self.result = result;
            return Ok(Step::Done);
        };
        let seq = stream.get("seq").and_then(Value::as_u64).unwrap_or(0) as usize;
        if seq != self.next_seq {
            return Err(format!("stream frame {seq} arrived where {} was due", self.next_seq).into());
        }
        self.next_seq += 1;
        if seq == 0 {
            let manifest = result.shift_remove("manifest");
            self.manifest_len = manifest.as_ref().and_then(Value::as_array).map(Vec::len);
            self.result = result;
        }
        if stream.get("final").and_then(Value::as_bool) != Some(true) {
            return Ok(Step::More);
        }
        match self.manifest_len {
            Some(n) if n != self.bodies.len() => {
                Err(format!("the stream ended with {} of its {n} bodies", self.bodies.len()).into())
            }
            _ => Ok(Step::Done),
        }
    }

    /// A text reply's result, inline arrays and all, which the worker sends when nothing was meshed.
    pub fn take_text(&mut self, mut result: Map<String, Value>, cache: &BodyCache) -> Result<(), ReplyError> {
        let bodies = match result.shift_remove("bodies") {
            Some(Value::Array(b)) => b,
            _ => Vec::new(),
        };
        self.take_bodies(&bodies, &[], cache)?;
        self.result = result;
        Ok(())
    }

    fn take_bodies(&mut self, bodies: &[Value], bufs: &[Buf], cache: &BodyCache) -> Result<(), ReplyError> {
        for b in bodies {
            let Some(f) = b.as_object() else { continue };
            let s = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            let (id, etag) = (s("id"), s("etag"));
            if f.get("unchanged").and_then(Value::as_bool) == Some(true) {
                let held = cache.get(&id, &etag).ok_or_else(|| ReplyError::StaleStub(id.clone()))?;
                self.bodies.push(held);
                continue;
            }
            self.bodies.push(Arc::new(read_body(f, bufs, id, s("name"), etag)?));
            self.fresh += 1;
        }
        Ok(())
    }
}

fn f32s(v: Option<&Value>, bufs: &[Buf]) -> Option<Vec<f32>> {
    match v? {
        Value::Object(r) => match bufs.get(r.get("$buf")?.as_u64()? as usize)? {
            Buf::F32(x) => Some(x.clone()),
            Buf::U32(_) => None,
        },
        Value::Array(a) => Some(a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()),
        _ => None,
    }
}

fn u32s(v: Option<&Value>, bufs: &[Buf]) -> Option<Vec<u32>> {
    match v? {
        Value::Object(r) => match bufs.get(r.get("$buf")?.as_u64()? as usize)? {
            Buf::U32(x) => Some(x.clone()),
            Buf::F32(_) => None,
        },
        Value::Array(a) => Some(a.iter().map(|x| x.as_u64().unwrap_or(0) as u32).collect()),
        _ => None,
    }
}

const MESH_KEYS: [&str; 7] = ["positions", "normals", "indices", "faceIds", "faceOwners", "edges", "unchanged"];

fn read_body(f: &Map<String, Value>, bufs: &[Buf], id: String, name: String, etag: String) -> Result<Body, String> {
    let positions = f32s(f.get("positions"), bufs).ok_or_else(|| format!("body {id} has no positions"))?;
    let indices = u32s(f.get("indices"), bufs).ok_or_else(|| format!("body {id} has no indices"))?;
    let face_ids = u32s(f.get("faceIds"), bufs).unwrap_or_default();
    let normals = f32s(f.get("normals"), bufs);
    let face_owners = f
        .get("faceOwners")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|o| match o {
                    Value::Null => None,
                    Value::String(s) => Some(s.clone()),
                    other => Some(other.to_string()),
                })
                .collect()
        })
        .unwrap_or_default();
    let edges = match f.get("edges") {
        Some(packed @ Value::Object(_)) => read_packed_edges(packed, bufs),
        Some(Value::Array(list)) => read_inline_edges(list),
        _ => Edges::default(),
    };
    let fields = f.iter().filter(|(k, _)| !MESH_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    Ok(Body { id, name, etag, positions, normals, indices, face_ids, face_owners, edges, fields })
}

fn read_packed_edges(packed: &Value, bufs: &[Buf]) -> Edges {
    let idx = |k: &str| -> Vec<u32> {
        packed.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64).map(|i| i as u32).collect()
    };
    let curvature = packed
        .get("curvature")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p.get(0)?.as_u64()? as u32, p.get(1)?.as_f64()? as f32, p.get(2)?.as_f64()? as f32)))
        .collect();
    Edges {
        points: f32s(packed.get("$pts"), bufs).unwrap_or_default(),
        counts: u32s(packed.get("$counts"), bufs).unwrap_or_default(),
        smooth: idx("smooth"),
        curvature,
    }
}

fn read_inline_edges(list: &[Value]) -> Edges {
    let mut e = Edges::default();
    for (i, edge) in list.iter().enumerate() {
        let pts = edge.get("points").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        for p in pts {
            for k in 0..3 {
                e.points.push(p.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32);
            }
        }
        e.counts.push(pts.len() as u32);
        if edge.get("smooth").and_then(Value::as_bool) == Some(true) {
            e.smooth.push(i as u32);
        }
        if let Some(k) = edge.get("curvature").and_then(Value::as_array) {
            let at = |j: usize| k.get(j).and_then(Value::as_f64).unwrap_or(0.0) as f32;
            e.curvature.push((i as u32, at(0), at(1)));
        }
    }
    e
}

/// The last mesh of every body, by id, which `known` advertises and an unchanged stub points back at.
#[derive(Default)]
pub struct BodyCache(HashMap<String, Arc<Body>>);

impl BodyCache {
    pub fn get(&self, id: &str, etag: &str) -> Option<Arc<Body>> {
        self.0.get(id).filter(|b| b.etag == etag).cloned()
    }

    pub fn known(&self) -> Value {
        Value::Object(self.0.iter().map(|(id, b)| (id.clone(), Value::String(b.etag.clone()))).collect())
    }

    /// Keeps exactly the bodies of the latest mesh.
    pub fn replace(&mut self, bodies: &[Arc<Body>]) {
        self.0 = bodies.iter().map(|b| (b.id.clone(), b.clone())).collect();
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fundacad_protocol::frame::encode_binary_reply;
    use fundacad_protocol::{Edge, FullBody, Limits, MeshResult, WireBody};
    use serde_json::json;

    fn full(id: &str, etag: &str) -> WireBody {
        let mut b = FullBody::new(id, format!("Body {id}"), etag);
        b.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        b.normals = Some(vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]);
        b.indices = vec![0, 1, 2];
        b.face_ids = vec![0];
        b.fields.insert("faceOwners".into(), json!(["f1"]));
        b.fields.insert("faceCount".into(), json!(1));
        b.edges = vec![
            Edge { points: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], smooth: false, curvature: None },
            Edge { points: vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0]], smooth: true, curvature: Some([0.5, 0.25]) },
        ];
        WireBody::Full(b)
    }

    #[test]
    fn a_binary_reply_reads_back_into_buffers() {
        let mut fields = Map::new();
        fields.insert("protocol".into(), json!(2));
        fields.insert("bbox".into(), json!({"min": [0, 0, 0], "max": [1, 1, 0]}));
        let res = MeshResult { fields, bodies: vec![full("b1", "e1")] };
        let frame = encode_binary_reply(&json!("r1"), &res, &Limits::default()).unwrap();
        let mut a = Assembly::default();
        assert!(matches!(a.take_binary(&frame, &BodyCache::default()).unwrap(), Step::Done));
        let b = &a.bodies[0];
        assert_eq!(b.indices, vec![0, 1, 2]);
        assert_eq!(b.positions.len(), 9);
        assert_eq!(b.face_owners, vec![Some("f1".to_owned())]);
        assert_eq!(b.edges.counts, vec![2, 3]);
        assert_eq!(b.edges.points.len(), 15);
        assert_eq!(b.edges.smooth, vec![1]);
        assert_eq!(b.edges.curvature, vec![(1, 0.5, 0.25)]);
        assert_eq!(b.fields["faceCount"], json!(1));
        assert!(a.result.contains_key("bbox"));
    }

    #[test]
    fn a_stub_takes_the_cached_body() {
        let res = MeshResult { fields: Map::new(), bodies: vec![full("b1", "e1")] };
        let frame = encode_binary_reply(&json!("r1"), &res, &Limits::default()).unwrap();
        let mut a = Assembly::default();
        a.take_binary(&frame, &BodyCache::default()).unwrap();
        let mut cache = BodyCache::default();
        cache.replace(&a.bodies);

        let res = MeshResult { fields: Map::new(), bodies: vec![WireBody::stub("b1", "Body b1", "e1")] };
        let frame = encode_binary_reply(&json!("r2"), &res, &Limits::default()).unwrap();
        let mut b = Assembly::default();
        b.take_binary(&frame, &cache).unwrap();
        assert_eq!(b.fresh, 0);
        assert!(Arc::ptr_eq(&a.bodies[0], &b.bodies[0]));

        let res = MeshResult { fields: Map::new(), bodies: vec![WireBody::stub("b1", "Body b1", "stale")] };
        let frame = encode_binary_reply(&json!("r3"), &res, &Limits::default()).unwrap();
        assert!(matches!(Assembly::default().take_binary(&frame, &cache), Err(ReplyError::StaleStub(_))));
    }
}
