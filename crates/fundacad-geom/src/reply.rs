//! The meshed half of a rebuild reply: the builder's bodies handed to the
//! viewport payload loop in `mesh`, with their face owners in face order.

use fundacad_protocol::JobResult;
use serde_json::{Map, Value};

use crate::builder::{BuiltBody, Watch};
use crate::mesh::{self, MeshBody};

/// A built body as the payload loop sees it, its face owners read only when
/// the body is actually meshed.
pub fn mesh_body(b: &BuiltBody) -> MeshBody<'_> {
    MeshBody {
        id: b.id.clone(),
        name: b.name.clone(),
        shape: Some(&b.shape),
        owner_map: Some(&b.owners),
        node_ref: b.node_ref.clone().map(Value::String),
        face_colors: b.face_colors.clone(),
        part_color: b.part_color.clone().map(Value::String),
        ..Default::default()
    }
}

pub fn mesh_result(
    bodies: &[BuiltBody],
    tolerance: f64,
    known: &Map<String, Value>,
    watch: &dyn Watch,
) -> JobResult {
    let bodies: Vec<MeshBody<'_>> = bodies.iter().map(mesh_body).collect();
    JobResult::Mesh(mesh::mesh_result_watched(
        &bodies,
        tolerance,
        known,
        &mut |done, total| watch.meshing(done, total),
    ))
}
