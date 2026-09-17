//! Joint placement (include/joint_ops.hxx).

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/joint_ops.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        /// `shape` moved so the `moving` frame (origin, z, x) meets the `fixed` one.
        pub fn jt_mated(
            shape: &TopoDS_Shape,
            fixed: &[f64],
            moving: &[f64],
            offset: f64,
            angle: f64,
            flush: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
