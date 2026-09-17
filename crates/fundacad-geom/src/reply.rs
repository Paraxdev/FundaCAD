//! The meshed half of a rebuild reply: the builder's bodies handed to the
//! viewport payload loop in `mesh`, with their face owners in face order.

use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};

use crate::builder::owners::face_key;
use crate::builder::BuiltBody;
use crate::kernel::{self, Kind};
use crate::mesh::{self, MeshBody};

pub fn mesh_result(bodies: &[BuiltBody], tolerance: f64, known: &Map<String, Value>) -> JobResult {
    let bodies: Vec<MeshBody<'_>> = bodies
        .iter()
        .map(|b| MeshBody {
            id: b.id.clone(),
            name: b.name.clone(),
            shape: Some(&b.shape),
            face_owners: kernel::subshapes(&b.shape, Kind::Face)
                .iter()
                .map(|f| {
                    face_key(f)
                        .and_then(|k| b.owners.get(&k))
                        .map_or(Value::Null, |o| json!(o))
                })
                .collect(),
            node_ref: b.node_ref.clone().map(Value::String),
            face_colors: b.face_colors.clone(),
            part_color: b.part_color.clone().map(Value::String),
        })
        .collect();
    JobResult::Mesh(mesh::mesh_result(&bodies, tolerance, known))
}
