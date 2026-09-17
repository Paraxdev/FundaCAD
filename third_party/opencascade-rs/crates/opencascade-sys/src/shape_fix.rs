pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/shape_fix.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopoDS_Wire = crate::topo_ds::TopoDS_Wire;
        type TopoDS_Face = crate::topo_ds::TopoDS_Face;
        type Message_ProgressRange = crate::message::Message_ProgressRange;

        /// A non-positive precision or tolerance keeps the ShapeFix default.
        pub fn ShapeFix_Shape_perform(
            shape: &TopoDS_Shape,
            precision: f64,
            min_tolerance: f64,
            max_tolerance: f64,
            progress: &Message_ProgressRange,
            modified: &mut bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;

        /// A shell becomes a solid through `SolidFromShell`, a solid is fixed in place.
        pub fn ShapeFix_Solid_perform(
            shape: &TopoDS_Shape,
            precision: f64,
            max_tolerance: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;

        pub fn ShapeFix_Wire_perform(
            wire: &TopoDS_Wire,
            face: &TopoDS_Face,
            precision: f64,
            modified: &mut bool,
        ) -> Result<UniquePtr<TopoDS_Wire>>;

        pub fn ShapeFix_Face_perform(
            face: &TopoDS_Face,
            precision: f64,
            modified: &mut bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
