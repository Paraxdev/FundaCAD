//! The viewport mesh of a body in the protocol v2 payload shape, replaces
//! `sidecar/tessellate.py` and the payload half of `sidecar/viewport_mesh.py`
//! (`_compute_payload`, `_body_payload`, `_union_bbox`), plus the body loop of
//! `server._rebuild_job`.
//!
//! Not here yet: mesh passes and `faceColorSlots` (the plugin host),
//! `faceBands` (`face_bands.py`), and every cache tier (RAM identity cache,
//! disk mesh artifacts, instance payloads, helper processes).

pub mod edges;
pub mod profile;
pub mod tessellate;

pub use edges::{edge_polylines, EdgeLine};
pub use profile::{effective_tolerance, viewport_profile, ViewportProfile};
pub use tessellate::{mesh_bbox, tessellate, MeshParams, Tessellation};

use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use fundacad_protocol::{Edge, FullBody, MeshResult, WireBody};
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

/// Bumped with `sidecar/tessellate.py`'s CODE_VERSION whenever the payload
/// changes for the same input, it keys the mesh artifact cache.
pub const CODE_VERSION: u32 = 8;

/// A body as the payload loop sees it.
#[derive(Default)]
pub struct MeshBody<'a> {
    pub id: String,
    pub name: String,
    pub shape: Option<&'a Shape>,
    /// The owning feature id per face, in face order; empty for all null.
    pub face_owners: Vec<Value>,
    pub node_ref: Option<Value>,
    pub face_colors: Option<Value>,
    pub part_color: Option<Value>,
}

/// The full payload of one body, meshed at the wire `tolerance` under
/// `profile`, with null face owners.
pub fn body_payload(
    shape: &Shape,
    id: &str,
    name: &str,
    tolerance: f64,
    profile: ViewportProfile,
) -> FullBody {
    body_payload_for(
        &MeshBody {
            id: id.into(),
            name: name.into(),
            shape: Some(shape),
            ..Default::default()
        },
        shape,
        tolerance,
        profile,
    )
}

fn body_payload_for(
    body: &MeshBody<'_>,
    shape: &Shape,
    tolerance: f64,
    profile: ViewportProfile,
) -> FullBody {
    let access = MeshAccess::new(shape);
    let tess = tessellate(
        shape,
        &access,
        MeshParams {
            linear: effective_tolerance(tolerance, profile.size_scale),
            angular: profile.angular,
            relative: true,
            display: profile.display_normals(),
            force_remesh: false,
        },
    );
    let lines = edge_polylines(&access);
    let face_owners: Vec<Value> = (0..access.face_count())
        .map(|i| body.face_owners.get(i).cloned().unwrap_or(Value::Null))
        .collect();
    let face_count = tess.face_ids.iter().max().map_or(0, |m| m + 1);
    let bbox = bbox_value(mesh_bbox(shape, &tess.positions));

    let mut b = FullBody {
        positions: tess.positions.iter().map(|&v| v as f32).collect(),
        normals: tess
            .normals
            .as_ref()
            .map(|n| n.iter().map(|&v| v as f32).collect()),
        indices: tess.indices,
        face_ids: tess.face_ids,
        edges: lines
            .into_iter()
            .map(|l| Edge {
                points: l
                    .points
                    .iter()
                    .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
                    .collect(),
                smooth: l.smooth,
            })
            .collect(),
        ..Default::default()
    };
    // The mesh keys hold placeholders so they keep the sidecar's key order.
    let mut payload = Map::new();
    payload.insert("positions".into(), Value::Null);
    payload.insert("indices".into(), Value::Null);
    payload.insert("faceIds".into(), Value::Null);
    payload.insert("faceOwners".into(), Value::Array(face_owners));
    payload.insert("edges".into(), Value::Null);
    payload.insert("faceCount".into(), face_count.into());
    payload.insert("bbox".into(), bbox);
    if b.normals.is_some() {
        payload.insert("normals".into(), Value::Null);
    }
    b.fields = payload;
    let tag = etag(&b);
    let mut fields = envelope(body, &tag);
    fields.extend(std::mem::take(&mut b.fields));
    b.fields = fields;
    b
}

/// `id`, `name`, `etag` and the envelope keys that change without the geometry.
fn envelope(body: &MeshBody<'_>, etag: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), body.id.clone().into());
    m.insert("name".into(), body.name.clone().into());
    m.insert("etag".into(), etag.into());
    if let Some(v) = body.node_ref.as_ref().filter(|v| truthy(v)) {
        m.insert("nodeRef".into(), v.clone());
    }
    if let Some(v) = body.face_colors.as_ref().filter(|v| truthy(v)) {
        m.insert("faceColors".into(), v.clone());
    }
    if let Some(v) = body.part_color.as_ref().filter(|v| truthy(v)) {
        m.insert("partColor".into(), v.clone());
    }
    m
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn bbox_value(bb: Option<([f64; 3], [f64; 3])>) -> Value {
    match bb {
        Some((min, max)) => json!({"min": min, "max": max}),
        None => Value::Null,
    }
}

/// The body's etag: blake2b-128 of everything the payload carries, as 32 hex
/// digits. The sidecar hands out a random one per cache entry; a content hash
/// is the same promise without the cache, and survives a worker restart.
/// Envelope keys (`id`, `name`, `nodeRef`, colours) are not part of it.
pub fn etag(body: &FullBody) -> String {
    let mut h = match Blake2bVar::new(16) {
        Ok(h) => h,
        Err(_) => return String::new(),
    };
    let mut section = |tag: &[u8], len: usize, bytes: &mut dyn Iterator<Item = [u8; 4]>| {
        h.update(tag);
        h.update(&(len as u64).to_le_bytes());
        for b in bytes {
            h.update(&b);
        }
    };
    section(
        b"positions",
        body.positions.len(),
        &mut body.positions.iter().map(|v| v.to_le_bytes()),
    );
    let normals = body.normals.as_deref().unwrap_or(&[]);
    section(
        if body.normals.is_some() {
            b"normals"
        } else {
            b"no-normals"
        },
        normals.len(),
        &mut normals.iter().map(|v| v.to_le_bytes()),
    );
    section(
        b"indices",
        body.indices.len(),
        &mut body.indices.iter().map(|v| v.to_le_bytes()),
    );
    section(
        b"faceIds",
        body.face_ids.len(),
        &mut body.face_ids.iter().map(|v| v.to_le_bytes()),
    );
    for e in &body.edges {
        section(
            if e.smooth { b"edge-smooth" } else { b"edge" },
            e.points.len(),
            &mut e.points.iter().flatten().map(|v| v.to_le_bytes()),
        );
    }
    let mut rest = body.fields.clone();
    for k in ["id", "name", "etag", "nodeRef", "faceColors", "partColor"] {
        rest.shift_remove(k);
    }
    h.update(Value::Object(rest).to_string().as_bytes());
    let mut out = [0u8; 16];
    if h.finalize_variable(&mut out).is_err() {
        return String::new();
    }
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// Union of per-body `{"min", "max"}` boxes, null when there are none.
pub fn union_bbox<'a>(boxes: impl IntoIterator<Item = &'a Value>) -> Value {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut any = false;
    for bb in boxes {
        let (Some(lo), Some(hi)) = (bb.get("min"), bb.get("max")) else {
            continue;
        };
        any = true;
        for k in 0..3 {
            min[k] = min[k].min(lo[k].as_f64().unwrap_or(f64::INFINITY));
            max[k] = max[k].max(hi[k].as_f64().unwrap_or(f64::NEG_INFINITY));
        }
    }
    if any {
        json!({"min": min, "max": max})
    } else {
        Value::Null
    }
}

/// The body loop of `_rebuild_job`: one profile for the whole reply, a body
/// without a shape left out, a stub for a body whose etag the client holds,
/// and the document bbox as the union of the body boxes. The builder's own
/// keys (`bodyIds`, `datumPlanes`, errors, ...) are the caller's to add.
pub fn mesh_result(
    bodies: &[MeshBody<'_>],
    tolerance: f64,
    known: &Map<String, Value>,
) -> MeshResult {
    mesh_result_watched(bodies, tolerance, known, &mut |_, _| {})
}

/// [`mesh_result`] reporting each body as it starts, which is what keeps the
/// stall watchdog off a long meshing pass.
pub fn mesh_result_watched(
    bodies: &[MeshBody<'_>],
    tolerance: f64,
    known: &Map<String, Value>,
    on_body: &mut dyn FnMut(usize, usize),
) -> MeshResult {
    let profile = viewport_profile(bodies.len());
    let mut out = Vec::new();
    let mut boxes = Vec::new();
    for (i, body) in bodies.iter().enumerate() {
        on_body(i, bodies.len());
        let Some(shape) = body.shape else {
            continue;
        };
        let full = body_payload_for(body, shape, tolerance, profile);
        boxes.push(full.fields.get("bbox").cloned().unwrap_or(Value::Null));
        let tag = full.fields.get("etag").cloned().unwrap_or(Value::Null);
        if known.get(&body.id) == Some(&tag) {
            let mut stub = envelope(body, tag.as_str().unwrap_or_default());
            stub.insert("unchanged".into(), Value::Bool(true));
            out.push(WireBody::Stub(stub));
        } else {
            out.push(WireBody::Full(full));
        }
    }
    let mut fields = Map::new();
    fields.insert("protocol".into(), 2.into());
    fields.insert("bodies".into(), Value::Null);
    fields.insert("bbox".into(), union_bbox(&boxes));
    MeshResult {
        fields,
        bodies: out,
    }
}
