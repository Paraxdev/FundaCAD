//! Fillet and chamfer operations for the FundaCAD blend port
//! (include/blend_ops.hxx). Edge lists travel as a compound of the edges.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/blend_ops.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn blend_fillet(
            shape: &TopoDS_Shape,
            edges: &TopoDS_Shape,
            radii: &[f64],
            status: &mut i32,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn blend_chamfer(
            shape: &TopoDS_Shape,
            edges: &TopoDS_Shape,
            d1: &[f64],
            d2: &[f64],
            status: &mut i32,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn blend_copy(
            shape: &TopoDS_Shape,
            edges: &TopoDS_Shape,
        ) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn blend_is_seam(shape: &TopoDS_Shape, edge: &TopoDS_Shape) -> bool;
        pub fn blend_dihedral_deg(
            shape: &TopoDS_Shape,
            edge: &TopoDS_Shape,
            px: f64,
            py: f64,
            pz: f64,
        ) -> f64;
        pub fn blend_face_triangles(faces: &TopoDS_Shape, deflection: f64) -> Result<Vec<f64>>;
        pub fn blend_is_valid(shape: &TopoDS_Shape) -> bool;
    }
}
