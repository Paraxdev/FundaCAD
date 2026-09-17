//! The meshed half of a rebuild reply, server.py `_rebuild_job`'s per-body
//! payload loop and `_union_bbox`. A minimal version over `mesh::tessellate`,
//! the seam the full tessellation port replaces.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use fundacad_protocol::{Edge, FullBody, JobResult, MeshResult, WireBody};
use serde_json::{json, Map, Value};

use crate::builder::owners::face_key;
use crate::builder::BuiltBody;
use crate::kernel::{self, Kind};
use crate::mesh;

pub fn mesh_result(bodies: &[BuiltBody], tolerance: f64, known: &Map<String, Value>) -> JobResult {
    let mut out = Vec::with_capacity(bodies.len());
    let mut boxes: Vec<([f64; 3], [f64; 3])> = Vec::new();
    for b in bodies {
        let Ok(m) = mesh::tessellate(&b.shape, tolerance) else {
            continue;
        };
        let mut hasher = DefaultHasher::new();
        for v in &m.positions {
            v.to_bits().hash(&mut hasher);
        }
        m.indices.hash(&mut hasher);
        m.face_ids.hash(&mut hasher);
        let etag = format!("{:016x}", hasher.finish());
        let bbox = m.bbox.map(|bb| {
            boxes.push((bb.min, bb.max));
            json!({ "min": bb.min, "max": bb.max })
        });
        if known.get(&b.id).and_then(Value::as_str) == Some(etag.as_str()) {
            let mut stub = Map::new();
            stub.insert("id".into(), json!(b.id));
            stub.insert("name".into(), json!(b.name));
            stub.insert("etag".into(), json!(etag));
            stub.insert("unchanged".into(), json!(true));
            out.push(WireBody::Stub(stub));
            continue;
        }
        let owners: Vec<Value> = kernel::subshapes(&b.shape, Kind::Face)
            .iter()
            .map(|f| {
                face_key(f)
                    .and_then(|k| b.owners.get(&k))
                    .map_or(Value::Null, |o| json!(o))
            })
            .collect();
        let mut body = FullBody::new(b.id.clone(), b.name.clone(), etag);
        body.fields.insert("faceCount".into(), json!(m.face_count));
        body.fields
            .insert("faceOwners".into(), Value::Array(owners));
        body.fields
            .insert("bbox".into(), bbox.unwrap_or(Value::Null));
        #[allow(clippy::cast_possible_truncation)]
        {
            body.positions = m.positions.iter().map(|v| *v as f32).collect();
            body.edges = m
                .edges
                .iter()
                .map(|e| Edge {
                    points: e
                        .points
                        .iter()
                        .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
                        .collect(),
                    smooth: false,
                })
                .collect();
        }
        body.indices = m.indices;
        body.face_ids = m.face_ids;
        out.push(WireBody::Full(body));
    }
    let bbox = boxes.split_first().map_or(Value::Null, |(first, rest)| {
        let (mut lo, mut hi) = *first;
        for (a, b) in rest {
            for k in 0..3 {
                lo[k] = lo[k].min(a[k]);
                hi[k] = hi[k].max(b[k]);
            }
        }
        json!({ "min": lo, "max": hi })
    });
    let mut fields = Map::new();
    fields.insert("protocol".into(), json!(2));
    fields.insert("bodies".into(), json!([]));
    fields.insert("bbox".into(), bbox);
    JobResult::Mesh(MeshResult {
        fields,
        bodies: out,
    })
}
