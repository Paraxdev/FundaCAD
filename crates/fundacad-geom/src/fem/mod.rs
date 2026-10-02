//! Finite element analysis: the tetrahedral mesher, the TET10 solver and their shared types.

pub mod solve;
pub mod tetmesh;

/// A closed, welded, outward-wound triangle mesh of one solid, each triangle tagged with its B-rep face index.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SurfaceMesh {
    pub positions: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub face_ids: Vec<u32>,
}

/// Target element size (lattice spacing, mm) and the most tetrahedra the caller accepts
/// (0 means no limit).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeshOptions {
    pub size: f64,
    pub max_tets: usize,
}

/// Linear tetrahedra, positively oriented (det > 0), plus the boundary triangles (outward) with the face index each lies on.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TetMesh {
    pub nodes: Vec<[f64; 3]>,
    pub tets: Vec<[u32; 4]>,
    pub boundary: Vec<[u32; 3]>,
    pub boundary_face: Vec<u32>,
}

/// Quality of a mesh. `size` is the element size actually used, larger than the requested
/// one when the mesh had to be coarsened to stay within `max_tets`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MeshStats {
    pub min_dihedral_deg: f64,
    pub max_dihedral_deg: f64,
    pub volume: f64,
    pub size: f64,
}
