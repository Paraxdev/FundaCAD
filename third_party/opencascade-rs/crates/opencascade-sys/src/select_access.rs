//! Geometry readback for selector resolution, see include/select_access.hxx.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/select_access.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn sa_items(s: &TopoDS_Shape, kind: i32) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        pub fn sa_edge_probe(edge: &TopoDS_Shape, out: &mut [f64]) -> bool;
        pub fn sa_edge_tangent(edge: &TopoDS_Shape, position: f64, out: &mut [f64]) -> bool;
        pub fn sa_edge_line_parallel(
            edge: &TopoDS_Shape,
            ax: f64,
            ay: f64,
            az: f64,
            ang_tol: f64,
        ) -> i32;
        pub fn sa_face_probe(face: &TopoDS_Shape, out: &mut [f64]) -> bool;
        pub fn sa_distance(s: &TopoDS_Shape, x: f64, y: f64, z: f64, out: &mut [f64]) -> bool;
        pub fn sa_surface_distance(face: &TopoDS_Shape, x: f64, y: f64, z: f64) -> f64;
        pub fn sa_bbox_diag(s: &TopoDS_Shape) -> f64;
    }
}
