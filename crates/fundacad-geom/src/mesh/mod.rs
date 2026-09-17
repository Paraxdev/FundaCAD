//! The viewport mesh of a body in the protocol v2 payload shape, replaces
//! `sidecar/tessellate.py` and the payload half of `sidecar/viewport_mesh.py`
//! (`_compute_payload`, `_body_payload`, `_union_bbox`), plus the body loop of
//! `server._rebuild_job`.
//!
//! Not here yet: mesh passes and `faceColorSlots` (the plugin host),
//! instance payloads and helper processes. The
//! RAM and disk payload caches plug in through `PayloadCache` (crate::cache).

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
    /// Face fingerprint to owning feature, read when `face_owners` is empty.
    pub owner_map: Option<&'a std::collections::HashMap<String, String>>,
    pub node_ref: Option<Value>,
    pub face_colors: Option<Value>,
    pub part_color: Option<Value>,
    /// `Body::identity`, what the in-memory payload cache matches on.
    pub identity: Option<(u64, u64)>,
    /// The content key of the checkpoint blob this shape was stored under.
    pub mesh_key: Option<String>,
}

/// A store of built payloads, consulted before a body is meshed. What it
/// returns and stores has the envelope keys stripped.
pub trait PayloadCache {
    fn get(&mut self, body: &MeshBody<'_>, tolerance: f64, profile: ViewportProfile) -> Option<FullBody>;
    fn put(&mut self, body: &MeshBody<'_>, tolerance: f64, profile: ViewportProfile, payload: &FullBody, build: std::time::Duration);
}

pub struct NoPayloadCache;

impl PayloadCache for NoPayloadCache {
    fn get(&mut self, _: &MeshBody<'_>, _: f64, _: ViewportProfile) -> Option<FullBody> {
        None
    }
    fn put(&mut self, _: &MeshBody<'_>, _: f64, _: ViewportProfile, _: &FullBody, _: std::time::Duration) {}
}

pub const ENVELOPE_KEYS: [&str; 6] = ["id", "name", "etag", "nodeRef", "faceColors", "partColor"];

/// The payload without its envelope, the part a cache may share between bodies.
pub fn strip_envelope(full: &FullBody) -> FullBody {
    let mut out = full.clone();
    for k in ENVELOPE_KEYS {
        out.fields.shift_remove(k);
    }
    out
}

fn with_envelope(body: &MeshBody<'_>, payload: FullBody) -> FullBody {
    let mut out = payload;
    let tag = etag(&out);
    let mut fields = envelope(body, &tag);
    fields.extend(std::mem::take(&mut out.fields));
    out.fields = fields;
    out
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
    let access = crate::bench::phase("mesh_access", || MeshAccess::new(shape));
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
    let lines = crate::bench::phase("edges", || edge_polylines(&access));
    let from_map: Vec<Value> = match body.owner_map {
        Some(owners) if body.face_owners.is_empty() => {
            crate::kernel::subshapes(shape, crate::kernel::Kind::Face)
                .iter()
                .map(|f| {
                    crate::builder::owners::face_key(f)
                        .and_then(|k| owners.get(&k))
                        .map_or(Value::Null, |o| Value::String(o.clone()))
                })
                .collect()
        }
        _ => Vec::new(),
    };
    let listed = if from_map.is_empty() { &body.face_owners } else { &from_map };
    let face_owners: Vec<Value> = (0..access.face_count())
        .map(|i| listed.get(i).cloned().unwrap_or(Value::Null))
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
    let bands = crate::bench::phase("face_bands", || crate::faces::face_bands(shape));
    if !bands.is_empty() {
        payload.insert("faceBands".into(), serde_json::json!(bands));
    }
    if b.normals.is_some() {
        payload.insert("normals".into(), Value::Null);
    }
    b.fields = payload;
    with_envelope(body, b)
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
    mesh_result_full(bodies, tolerance, known, &mut NoPayloadCache, &mut |_, _| {})
}

/// `mesh_result` reporting each body as it starts, which is what keeps the
/// stall watchdog off a long meshing pass.
pub fn mesh_result_watched(
    bodies: &[MeshBody<'_>],
    tolerance: f64,
    known: &Map<String, Value>,
    on_body: &mut dyn FnMut(usize, usize),
) -> MeshResult {
    mesh_result_full(bodies, tolerance, known, &mut NoPayloadCache, on_body)
}

/// `mesh_result`, reusing the payloads `cache` holds.
pub fn mesh_result_cached(
    bodies: &[MeshBody<'_>],
    tolerance: f64,
    known: &Map<String, Value>,
    cache: &mut dyn PayloadCache,
) -> MeshResult {
    mesh_result_full(bodies, tolerance, known, cache, &mut |_, _| {})
}

/// Every body's payload, in body order, `None` where the body has no shape.
///
/// The cache is read and written on this thread, in body order, so a cached
/// run and a fresh one agree; only the bodies that miss are meshed, and those
/// go to other threads when they own their faces outright (crate::par). The
/// progress ticks stay 0, 1, ... n-1, what a serial loop reported, so the
/// watchdog sees the same frames in the same order.
fn built_payloads(
    bodies: &[MeshBody<'_>],
    tolerance: f64,
    profile: ViewportProfile,
    cache: &mut dyn PayloadCache,
    on_body: &mut dyn FnMut(usize, usize),
) -> Vec<Option<FullBody>> {
    let total = bodies.len();
    let mut out: Vec<Option<FullBody>> = Vec::with_capacity(total);
    let mut misses: Vec<usize> = Vec::new();
    for (i, body) in bodies.iter().enumerate() {
        let cached = body
            .shape
            .and_then(|_| cache.get(body, tolerance, profile))
            .map(|payload| with_envelope(body, payload));
        if cached.is_none() && body.shape.is_some() {
            misses.push(i);
        }
        out.push(cached);
    }

    let ticked = std::sync::atomic::AtomicUsize::new(0);
    let tick = std::sync::Mutex::new(on_body);
    let mesh_one = |k: usize| {
        let i = misses[k];
        let body = &bodies[i];
        let shape = body.shape.expect("a miss has a shape");
        let began = std::time::Instant::now();
        let full = crate::bench::phase("body_payload", || {
            body_payload_for(body, shape, tolerance, profile)
        });
        let done = ticked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut t) = tick.lock() {
            t(done, total);
        }
        (full, began.elapsed())
    };
    let made: Vec<(usize, (FullBody, std::time::Duration))> = if crate::par::worth_it(misses.len()) {
        let shapes: Vec<&Shape> = misses.iter().filter_map(|&i| bodies[i].shape).collect();
        let groups = crate::bench::phase("share_groups", || crate::par::share_groups(&shapes));
        crate::bench::note("mesh_groups", groups.len());
        crate::bench::note("mesh_largest_group", groups.iter().map(Vec::len).max().unwrap_or(0));
        let work = crate::par::Shared(&mesh_one);
        crate::par::map_grouped(&groups, move |k| (work.get())(k))
    } else {
        (0..misses.len()).map(|k| (k, mesh_one(k))).collect()
    };
    for (k, (full, took)) in made {
        let i = misses[k];
        cache.put(&bodies[i], tolerance, profile, &strip_envelope(&full), took);
        out[i] = Some(full);
    }
    out
}

/// The payload loop, over `cache` and reporting each body to `on_body`.
pub fn mesh_result_full(
    bodies: &[MeshBody<'_>],
    tolerance: f64,
    known: &Map<String, Value>,
    cache: &mut dyn PayloadCache,
    on_body: &mut dyn FnMut(usize, usize),
) -> MeshResult {
    crate::par::configure_occt();
    let profile = viewport_profile(bodies.len());
    let mut out = Vec::new();
    let mut boxes = Vec::new();
    let mut built = built_payloads(bodies, tolerance, profile, cache, on_body);
    for (i, body) in bodies.iter().enumerate() {
        let Some(full) = built[i].take() else {
            continue;
        };
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
