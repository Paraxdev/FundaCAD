pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/sewing.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopTools_ListOfShape = crate::top_tools::TopTools_ListOfShape;
        type Message_ProgressRange = crate::message::Message_ProgressRange;

        type FcSewing;

        pub fn BRepBuilderAPI_Sewing_run(
            shapes: &TopTools_ListOfShape,
            tolerance: f64,
            cutting: bool,
            non_manifold: bool,
            progress: &Message_ProgressRange,
        ) -> Result<UniquePtr<FcSewing>>;
        pub fn FcSewing_sewed_shape(sewing: &FcSewing) -> UniquePtr<TopoDS_Shape>;
        /// `out` gets free, multiple, degenerated, deleted face counts.
        pub fn FcSewing_counts(sewing: &FcSewing, out: &mut [i32]);
        pub fn FcSewing_free_edges(sewing: &FcSewing) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        /// The sewn counterpart of an input shape, or the shape itself when untouched.
        pub fn FcSewing_modified(sewing: &FcSewing, shape: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn FcSewing_is_modified(sewing: &FcSewing, shape: &TopoDS_Shape) -> bool;

        type FcReShape;

        pub fn BRepTools_ReShape_new() -> UniquePtr<FcReShape>;
        pub fn FcReShape_replace(reshape: &FcReShape, original: &TopoDS_Shape, replacement: &TopoDS_Shape) -> Result<()>;
        pub fn FcReShape_remove(reshape: &FcReShape, shape: &TopoDS_Shape) -> Result<()>;
        pub fn FcReShape_is_recorded(reshape: &FcReShape, shape: &TopoDS_Shape) -> bool;
        pub fn FcReShape_value(reshape: &FcReShape, shape: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn FcReShape_apply(reshape: &FcReShape, shape: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
