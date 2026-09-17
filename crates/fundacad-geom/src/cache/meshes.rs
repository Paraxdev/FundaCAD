//! The payload caches of sidecar/viewport_mesh.py: in memory by body
//! identity (`_MESH_CACHE`), and on disk as mesh artifacts keyed by the body's
//! checkpoint blob key, `mesh::CODE_VERSION` and the deflections.

use std::collections::HashMap;
use std::time::Duration;

use fundacad_protocol::{Edge, FullBody};
use serde_json::{Map, Value};

use super::store::GeomStore;
use crate::mesh::{self, effective_tolerance, MeshBody, PayloadCache, ViewportProfile};

/// `_MESH_PERSIST_MIN_MS`: cheaper payloads are not worth a disk write.
pub const PERSIST_MIN: Duration = Duration::from_millis(50);

const MAGIC: &[u8; 8] = b"FCMESH01";

struct RamPayload {
    identity: (u64, u64),
    request: (u64, u64, u64),
    payload: FullBody,
}

#[derive(Default)]
pub struct Payloads {
    ram: HashMap<String, RamPayload>,
    pub ram_hits: usize,
    pub disk_hits: usize,
    pub meshed: usize,
}

impl Payloads {
    pub fn clear(&mut self) {
        self.ram.clear();
    }

    pub fn reset_counters(&mut self) {
        self.ram_hits = 0;
        self.disk_hits = 0;
        self.meshed = 0;
    }

    /// Forget bodies the last reply did not carry.
    pub fn retain(&mut self, ids: &std::collections::HashSet<&str>) {
        self.ram.retain(|k, _| ids.contains(k.as_str()));
    }
}

fn request(tolerance: f64, profile: ViewportProfile) -> (u64, u64, u64) {
    (tolerance.to_bits(), profile.size_scale.to_bits(), profile.angular.to_bits())
}

/// `_mesh_key`: hex and dashes only, so it names a file as it is.
pub fn artifact_key(mesh_key: &str, tolerance: f64, profile: ViewportProfile) -> String {
    format!(
        "{mesh_key}-{:x}-{:016x}-{:016x}",
        mesh::CODE_VERSION,
        effective_tolerance(tolerance, profile.size_scale).to_bits(),
        profile.angular.to_bits()
    )
}

pub struct Tiered<'a> {
    pub payloads: &'a mut Payloads,
    pub store: Option<&'a GeomStore>,
    pub persist_after: Duration,
}

impl PayloadCache for Tiered<'_> {
    fn get(&mut self, body: &MeshBody<'_>, tolerance: f64, profile: ViewportProfile) -> Option<FullBody> {
        let req = request(tolerance, profile);
        if let (Some(ident), Some(hit)) = (body.identity, self.payloads.ram.get(&body.id)) {
            if hit.identity == ident && hit.request == req {
                self.payloads.ram_hits += 1;
                return Some(hit.payload.clone());
            }
        }
        let store = self.store?;
        let key = body.mesh_key.as_deref()?;
        let payload = decode(&store.get_mesh(&artifact_key(key, tolerance, profile))?)?;
        self.payloads.disk_hits += 1;
        if let Some(identity) = body.identity {
            self.payloads.ram.insert(
                body.id.clone(),
                RamPayload {
                    identity,
                    request: req,
                    payload: payload.clone(),
                },
            );
        }
        Some(payload)
    }

    fn put(&mut self, body: &MeshBody<'_>, tolerance: f64, profile: ViewportProfile, payload: &FullBody, build: Duration) {
        self.payloads.meshed += 1;
        if let Some(identity) = body.identity {
            self.payloads.ram.insert(
                body.id.clone(),
                RamPayload {
                    identity,
                    request: request(tolerance, profile),
                    payload: payload.clone(),
                },
            );
        }
        if let (Some(store), Some(key)) = (self.store, body.mesh_key.as_deref()) {
            if build >= self.persist_after || profile.size_scale != 1.0 {
                let _ = store.put_mesh(&artifact_key(key, tolerance, profile), &encode(payload));
            }
        }
    }
}

fn put_u32(out: &mut Vec<u8>, v: usize) {
    out.extend_from_slice(&u32::try_from(v).unwrap_or(u32::MAX).to_le_bytes());
}

/// A payload as bytes: the JSON fields, then the arrays little endian.
pub fn encode(b: &FullBody) -> Vec<u8> {
    let fields = serde_json::to_vec(&Value::Object(b.fields.clone())).unwrap_or_default();
    let mut out = Vec::with_capacity(64 + fields.len() + 4 * (b.positions.len() + b.indices.len() + b.face_ids.len()));
    out.extend_from_slice(MAGIC);
    put_u32(&mut out, fields.len());
    out.extend_from_slice(&fields);
    put_u32(&mut out, b.positions.len());
    b.positions.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
    match &b.normals {
        Some(n) => {
            out.push(1);
            put_u32(&mut out, n.len());
            n.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
        }
        None => out.push(0),
    }
    put_u32(&mut out, b.indices.len());
    b.indices.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
    put_u32(&mut out, b.face_ids.len());
    b.face_ids.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
    put_u32(&mut out, b.edges.len());
    for e in &b.edges {
        out.push(u8::from(e.smooth));
        put_u32(&mut out, e.points.len());
        e.points.iter().flatten().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
    }
    out
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        if self.0.len() < n {
            return None;
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Some(head)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u32(&mut self) -> Option<usize> {
        self.take(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    }
    fn f32s(&mut self, n: usize) -> Option<Vec<f32>> {
        let raw = self.take(n.checked_mul(4)?)?;
        Some(raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
    fn u32s(&mut self, n: usize) -> Option<Vec<u32>> {
        let raw = self.take(n.checked_mul(4)?)?;
        Some(raw.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
}

/// None for anything short, foreign or trailing junk, a miss like any other.
pub fn decode(data: &[u8]) -> Option<FullBody> {
    let mut r = Reader(data);
    if r.take(MAGIC.len())? != MAGIC {
        return None;
    }
    let n = r.u32()?;
    let fields: Map<String, Value> = serde_json::from_slice(r.take(n)?).ok()?;
    let n = r.u32()?;
    let positions = r.f32s(n)?;
    let normals = match r.u8()? {
        0 => None,
        _ => {
            let n = r.u32()?;
            Some(r.f32s(n)?)
        }
    };
    let n = r.u32()?;
    let indices = r.u32s(n)?;
    let n = r.u32()?;
    let face_ids = r.u32s(n)?;
    let n = r.u32()?;
    let mut edges = Vec::with_capacity(n.min(1 << 20));
    for _ in 0..n {
        let smooth = r.u8()? != 0;
        let k = r.u32()?;
        let flat = r.f32s(k.checked_mul(3)?)?;
        edges.push(Edge {
            points: flat.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect(),
            smooth,
        });
    }
    if !r.0.is_empty() {
        return None;
    }
    Some(FullBody {
        fields,
        positions,
        normals,
        indices,
        face_ids,
        edges,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_artifact_round_trips_and_junk_is_a_miss() {
        let sphere = crate::kernel::make_sphere(4.0).unwrap();
        let full = mesh::strip_envelope(&mesh::body_payload(&sphere, "b", "B", 0.1, mesh::viewport_profile(1)));
        let bytes = encode(&full);
        let back = decode(&bytes).unwrap();
        assert_eq!(back, full);
        assert_eq!(mesh::etag(&back), mesh::etag(&full));
        assert!(decode(&bytes[..bytes.len() - 1]).is_none());
        assert!(decode(b"FCMESH01garbage").is_none());
        let key = artifact_key(&"ab".repeat(16), 0.1, mesh::viewport_profile(1));
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'), "{key}");
    }
}
