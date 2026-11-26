//! The link to the engine worker lands here with fundacad-client (breadcrumb tk7dkvga). Until then the
//! app opens binary STL files.

use crate::viewport::mesh::{self, Mesh};

pub fn open(path: &std::path::Path) -> Result<Mesh, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    mesh::load_stl(&bytes)
}
