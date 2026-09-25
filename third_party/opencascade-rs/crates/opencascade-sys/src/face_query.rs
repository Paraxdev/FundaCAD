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
        /// The optimal box one face adds to its shape's, false when void.
        pub fn FQ_face_bbox(face: &TopoDS_Shape, out: &mut [f64]) -> Result<bool>;
        /// The TShape's address, an identity for this process.
        pub fn FQ_tshape(shape: &TopoDS_Shape) -> u64;
        /// kind 2 surface, 3 volume: [mass, centre xyz].
        /// The placement as a row-major 3x4 matrix, false for the identity.
        pub fn FQ_location(shape: &TopoDS_Shape, out: &mut [f64]) -> Result<bool>;
        /// The same TShape and orientation with no placement.
        pub fn FQ_unlocated(shape: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn FQ_orientation(shape: &TopoDS_Shape) -> i32;
        /// Edges outside every face or vertices outside every edge.
        pub fn FQ_free_parts(shape: &TopoDS_Shape) -> bool;
        /// 0 plane, 1 cylinder, 2 cone, 3 sphere, 4 torus, 5 bspline, 6 other.
        pub fn FQ_surface_code(face: &TopoDS_Shape) -> i32;
        pub fn FQ_mass(shape: &TopoDS_Shape, kind: i32, out: &mut [f64]) -> Result<()>;
        pub fn FQ_edge_length(edge: &TopoDS_Shape) -> Result<f64>;
        pub fn FQ_edge_positions(edge: &TopoDS_Shape, ts: &[f64], out: &mut [f64]) -> Result<()>;
        pub fn FQ_edge_param_points(edge: &TopoDS_Shape, n: i32, out: &mut [f64]) -> Result<bool>;
        /// [axis dir, centre, radius], false when not a circle.
        pub fn FQ_edge_circle(edge: &TopoDS_Shape, out: &mut [f64]) -> Result<bool>;
        pub fn FQ_edge_closed(edge: &TopoDS_Shape) -> Result<bool>;
        /// Each boundary edge within `deflection`, xyz triples, a NaN triple
        /// after each edge. False when an edge will not sample.
        pub fn FQ_face_boundary(face: &TopoDS_Shape, deflection: f64, out: &mut Vec<f64>) -> Result<bool>;
    }
}
