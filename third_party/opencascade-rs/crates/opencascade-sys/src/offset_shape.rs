//! 3D offsets: `BRepOffset_MakeOffset` (whole shape or per face, offset shape
//! or thick solid) and `BRepOffsetAPI_MakeThickSolid` by join or simple.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/offset_shape.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopTools_ListOfShape = crate::top_tools::TopTools_ListOfShape;
        type Message_ProgressRange = crate::message::Message_ProgressRange;

        /// `mode` 0 skin, 1 pipe, 2 recto verso. `join` 0 arc, 1 tangent,
        /// 2 intersection. `face_offsets` pairs with `faces` for per-face values.
        /// `thick_solid` runs MakeThickSolid with `closing_faces` removed.
        /// `error` gets the BRepOffset_Error code, 0 when none.
        #[allow(clippy::too_many_arguments)]
        pub fn BRepOffset_MakeOffset_run(
            shape: &TopoDS_Shape,
            offset: f64,
            tolerance: f64,
            mode: i32,
            intersection: bool,
            self_intersection: bool,
            join: i32,
            thickening: bool,
            remove_internal_edges: bool,
            faces: &TopTools_ListOfShape,
            face_offsets: &[f64],
            closing_faces: &TopTools_ListOfShape,
            thick_solid: bool,
            progress: &Message_ProgressRange,
            error: &mut i32,
        ) -> Result<UniquePtr<TopoDS_Shape>>;

        #[allow(clippy::too_many_arguments)]
        pub fn BRepOffsetAPI_MakeThickSolid_join(
            shape: &TopoDS_Shape,
            closing_faces: &TopTools_ListOfShape,
            offset: f64,
            tolerance: f64,
            intersection: bool,
            self_intersection: bool,
            join: i32,
            remove_internal_edges: bool,
            progress: &Message_ProgressRange,
        ) -> Result<UniquePtr<TopoDS_Shape>>;

        pub fn BRepOffsetAPI_MakeThickSolid_simple(
            shape: &TopoDS_Shape,
            offset: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
