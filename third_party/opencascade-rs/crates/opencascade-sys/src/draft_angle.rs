pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/draft_angle.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopTools_ListOfShape = crate::top_tools::TopTools_ListOfShape;

        /// `BRepOffsetAPI_DraftAngle`, every face of `faces` pulled along
        /// `direction` (3) by `angle` radians about the neutral plane through
        /// `plane_origin` (3) with `plane_normal` (3). `refused` gets the index
        /// (1-based) of the first face Add refused, 0 when all were taken.
        pub fn BRepOffsetAPI_DraftAngle_run(
            shape: &TopoDS_Shape,
            faces: &TopTools_ListOfShape,
            direction: &[f64],
            angle: f64,
            plane_origin: &[f64],
            plane_normal: &[f64],
            refused: &mut i32,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
