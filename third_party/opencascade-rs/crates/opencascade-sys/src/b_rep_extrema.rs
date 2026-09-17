pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/b_rep_extrema.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type Message_ProgressRange = crate::message::Message_ProgressRange;

        type BRepExtrema_DistShapeShape;

        /// A non-positive deflection keeps the default, Precision::Confusion.
        pub fn BRepExtrema_DistShapeShape_perform(
            shape_1: &TopoDS_Shape,
            shape_2: &TopoDS_Shape,
            deflection: f64,
            progress: &Message_ProgressRange,
        ) -> Result<UniquePtr<BRepExtrema_DistShapeShape>>;
        pub fn IsDone(self: &BRepExtrema_DistShapeShape) -> bool;
        pub fn Value(self: &BRepExtrema_DistShapeShape) -> Result<f64>;
        pub fn NbSolution(self: &BRepExtrema_DistShapeShape) -> i32;
        pub fn InnerSolution(self: &BRepExtrema_DistShapeShape) -> bool;

        /// Solution `index` (1-based) on shape 1 or 2: `out` gets x, y, z, the
        /// support kind (0 vertex, 1 edge, 2 face) and its parameters (t, or u, v).
        pub fn BRepExtrema_DistShapeShape_solution(
            dist: &BRepExtrema_DistShapeShape,
            index: i32,
            on_first: bool,
            out: &mut [f64],
        ) -> Result<()>;
        pub fn BRepExtrema_DistShapeShape_support(
            dist: &BRepExtrema_DistShapeShape,
            index: i32,
            on_first: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;

        pub fn BRepExtrema_vertex(x: f64, y: f64, z: f64) -> UniquePtr<TopoDS_Shape>;
    }
}
