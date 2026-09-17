//! Construction helpers for the solid operations: an unbounded plane face.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/solid_ops.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        /// `BRepBuilderAPI_MakeFace(gp_Pln)`: the infinite face of a plane.
        pub fn solid_ops_plane_face(
            origin: &[f64],
            normal: &[f64],
            xdir: &[f64],
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
