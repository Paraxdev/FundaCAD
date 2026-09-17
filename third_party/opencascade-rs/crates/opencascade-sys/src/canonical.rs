pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/canonical.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn canonical_convertible(shape: &TopoDS_Shape) -> Result<bool>;
        pub fn canonical_surface_types(shape: &TopoDS_Shape) -> Result<Vec<i32>>;
        pub fn canonical_swept_to_elementary(shape: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn canonical_convert(
            work: &TopoDS_Shape,
            tol: f64,
            converted: &mut i32,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
