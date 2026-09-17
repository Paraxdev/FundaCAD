//! In-memory BREP serialisation (BinTools binary, BRepTools ASCII) and
//! `BRepBuilderAPI_Copy`.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/shape_io.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type Message_ProgressRange = crate::message::Message_ProgressRange;

        /// `version` 1 to 4, 0 for current.
        pub fn BinTools_write_bytes(
            shape: &TopoDS_Shape,
            with_triangles: bool,
            with_normals: bool,
            version: i32,
            progress: &Message_ProgressRange,
        ) -> Result<Vec<u8>>;
        pub fn BinTools_read_bytes(bytes: &[u8], progress: &Message_ProgressRange) -> Result<UniquePtr<TopoDS_Shape>>;

        /// `version` 1 to 3, 0 for current.
        pub fn BRepTools_write_string(
            shape: &TopoDS_Shape,
            with_triangles: bool,
            with_normals: bool,
            version: i32,
            progress: &Message_ProgressRange,
        ) -> Result<String>;
        pub fn BRepTools_read_string(text: &str, progress: &Message_ProgressRange) -> Result<UniquePtr<TopoDS_Shape>>;

        pub fn BRepBuilderAPI_Copy_shape(
            shape: &TopoDS_Shape,
            copy_geometry: bool,
            copy_mesh: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
