//! Bulk triangulation and edge readback for the viewport mesh, see
//! include/mesh_access.hxx.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/mesh_access.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        type MeshAccess;

        pub fn mesh_access_new(shape: &TopoDS_Shape) -> UniquePtr<MeshAccess>;
        pub fn mesh_access_mesh(
            shape: &TopoDS_Shape,
            linear: f64,
            relative: bool,
            angular: f64,
            parallel: bool,
            clean_first: bool,
        ) -> bool;
        pub fn mesh_access_read_brep(text: &str) -> UniquePtr<TopoDS_Shape>;
        pub fn mesh_access_bnd_box(shape: &TopoDS_Shape, out: &mut Vec<f64>) -> bool;

        pub fn mesh_access_face_count(m: &MeshAccess) -> i32;
        pub fn mesh_access_face_reversed(m: &MeshAccess, face: i32) -> bool;
        pub fn mesh_access_face_plane_normal(m: &MeshAccess, face: i32, out: &mut Vec<f64>) -> bool;
        pub fn mesh_access_face_triangulation(
            m: &MeshAccess,
            face: i32,
            with_normals: bool,
            nodes: &mut Vec<f64>,
            tris: &mut Vec<i32>,
            normals: &mut Vec<f64>,
        ) -> bool;

        pub fn mesh_access_edge_count(m: &MeshAccess) -> i32;
        pub fn mesh_access_edge_faces(m: &MeshAccess, edge: i32, out: &mut Vec<i32>);
        pub fn mesh_access_edge_degenerated(m: &MeshAccess, edge: i32) -> bool;
        pub fn mesh_access_edge_closed_on(m: &MeshAccess, edge: i32, ancestor: i32) -> bool;
        pub fn mesh_access_edge_line(m: &MeshAccess, edge: i32, out: &mut Vec<f64>) -> i32;
        pub fn mesh_access_edge_range(
            m: &MeshAccess,
            edge: i32,
            first: &mut f64,
            last: &mut f64,
        ) -> bool;
        pub fn mesh_access_edge_values(
            m: &MeshAccess,
            edge: i32,
            params: &[f64],
            out: &mut Vec<f64>,
        ) -> bool;
        pub fn mesh_access_edge_deflection(
            m: &MeshAccess,
            edge: i32,
            deflection: f64,
            points: &mut Vec<f64>,
            params: &mut Vec<f64>,
        ) -> bool;
        pub fn mesh_access_edge_smooth(m: &MeshAccess, edge: i32, cos_tol: f64) -> i32;
        pub fn mesh_access_edge_brep_range(
            m: &MeshAccess,
            edge: i32,
            first: &mut f64,
            last: &mut f64,
        ) -> bool;
        pub fn mesh_access_edge_face_normal(
            m: &MeshAccess,
            edge: i32,
            ancestor: i32,
            t: f64,
            out: &mut Vec<f64>,
        ) -> bool;
    }
}
