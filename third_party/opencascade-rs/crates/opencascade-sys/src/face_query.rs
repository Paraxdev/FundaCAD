//! Surface parameters (`BRepAdaptor_Surface`), B-rep boxes (`BRepBndLib`),
//! mass properties and arc-length edge sampling (`GCPnts_AbscissaPoint`).

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/face_query.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        /// Kind 0 plane, 1 cylinder, 2 cone, 3 sphere, 4 torus, 5 revolution,
        /// -1 other; `out` (13) is [reversed, dir, location, r1, r2, apex].
        pub fn FQ_surface(face: &TopoDS_Shape, out: &mut [f64]) -> Result<i32>;
        /// Point and raw normal at the middle of `BRepGProp_Face::Bounds`.
        pub fn FQ_mid_normal(face: &TopoDS_Shape, out: &mut [f64]) -> Result<()>;
        /// No triangulation used; false when the box is void.
        pub fn FQ_bbox(shape: &TopoDS_Shape, optimal: bool, out: &mut [f64]) -> Result<bool>;
        /// The TShape's address, an identity for this process.
        pub fn FQ_tshape(shape: &TopoDS_Shape) -> u64;
        /// kind 2 surface, 3 volume: [mass, centre xyz].
        pub fn FQ_mass(shape: &TopoDS_Shape, kind: i32, out: &mut [f64]) -> Result<()>;
        pub fn FQ_edge_length(edge: &TopoDS_Shape) -> Result<f64>;
        pub fn FQ_edge_positions(edge: &TopoDS_Shape, ts: &[f64], out: &mut [f64]) -> Result<()>;
        pub fn FQ_edge_param_points(edge: &TopoDS_Shape, n: i32, out: &mut [f64]) -> Result<bool>;
        /// [axis dir, centre, radius], false when not a circle.
        pub fn FQ_edge_circle(edge: &TopoDS_Shape, out: &mut [f64]) -> Result<bool>;
        pub fn FQ_edge_closed(edge: &TopoDS_Shape) -> Result<bool>;
    }
}
