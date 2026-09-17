//! Viewport tessellation in the wire format of docs/PROTOCOL.md.
//!
//! One `BodyMesh` is the per-body payload of a protocol v2 `rebuild` reply:
//! flat positions, triangle indices, one B-rep face id per triangle (what the
//! picker turns into a face selection), edge polylines for the outline pass,
//! and the bounding box. This replaces `sidecar/tessellate.py` and
//! `sidecar/viewport_mesh.py` for the shape it is handed; the per-body cache,
//! etags and face owners are layered on by the caller.

use crate::measure::{bbox, Bbox};
use opencascade::primitives::Shape;
use serde::{Deserialize, Serialize};

/// Number of samples per edge polyline. The sidecar samples curves adaptively;
/// a fixed count is enough for the outline pass until that lands.
pub const EDGE_SAMPLES: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgePolyline {
    pub id: String,
    pub points: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub face_ids: Vec<u32>,
    pub face_count: u32,
    pub edges: Vec<EdgePolyline>,
    pub bbox: Option<Bbox>,
}

#[derive(Debug, thiserror::Error)]
pub enum MeshError {
    #[error("triangulation failed: {0}")]
    Triangulation(String),
}

/// Mesh `shape` at `tolerance` (linear deflection, model units).
pub fn tessellate(shape: &Shape, tolerance: f64) -> Result<BodyMesh, MeshError> {
    let faces = shape
        .tessellate_faces(tolerance)
        .map_err(|e| MeshError::Triangulation(format!("{e:?}")))?;

    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut face_ids: Vec<u32> = Vec::new();
    let mut face_count = 0u32;
    for fm in faces {
        face_count = face_count.max(fm.face_id + 1);
        let base = (positions.len() / 3) as u32;
        positions.extend_from_slice(&fm.positions);
        for tri in fm.indices.chunks_exact(3) {
            indices.extend_from_slice(&[base + tri[0], base + tri[1], base + tri[2]]);
            face_ids.push(fm.face_id);
        }
    }

    let edges = shape
        .edge_polylines(EDGE_SAMPLES)
        .into_iter()
        .map(|e| EdgePolyline {
            id: e.id,
            points: e.points.into_iter().map(|p| [p.x, p.y, p.z]).collect(),
        })
        .collect();

    Ok(BodyMesh { positions, indices, face_ids, face_count, edges, bbox: bbox(shape) })
}
