//! Sketch helpers (include/sketch_ops.hxx): glyph faces, cylinder axes and
//! points on an edge by length fraction.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/sketch_ops.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn sk_cylinder_axis(face: &TopoDS_Shape, out: &mut [f64]) -> Result<bool>;
        pub fn sk_edge_at(edge: &TopoDS_Shape, fraction: f64, out: &mut [f64]) -> Result<()>;
        pub fn sk_glyph_face(data: &[f64]) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
