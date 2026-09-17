//! Per-face and per-edge geometry questions: BRep_Tool, BRepTools::UVBounds,
//! BRepAdaptor closure, GeomAPI_ProjectPointOnSurf and BRepClass_FaceClassifier.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/surface_query.hxx");

        type TopoDS_Face = crate::topo_ds::TopoDS_Face;
        type TopoDS_Edge = crate::topo_ds::TopoDS_Edge;

        /// `out` gets umin, umax, vmin, vmax.
        pub fn BRepTools_uv_bounds(face: &TopoDS_Face, out: &mut [f64]) -> Result<()>;
        /// Bit 0 u closed, 1 v closed, 2 u periodic, 3 v periodic.
        pub fn BRepAdaptor_Surface_closure(face: &TopoDS_Face) -> Result<i32>;
        /// `out` gets the point and the unit normal, flipped for a reversed face.
        pub fn BRepGProp_Face_point_normal(face: &TopoDS_Face, u: f64, v: f64, out: &mut [f64]) -> Result<()>;
        /// `out` gets u, v, distance and the projected point. False when nothing projects.
        pub fn GeomAPI_ProjectPointOnSurf_face(
            face: &TopoDS_Face,
            x: f64,
            y: f64,
            z: f64,
            out: &mut [f64],
        ) -> Result<bool>;
        /// TopAbs_State: 0 in, 1 out, 2 on, 3 unknown.
        pub fn BRepClass_FaceClassifier_uv(face: &TopoDS_Face, u: f64, v: f64, tol: f64) -> Result<i32>;
        pub fn BRepClass_FaceClassifier_point(face: &TopoDS_Face, x: f64, y: f64, z: f64, tol: f64) -> Result<i32>;

        /// `out` gets first, last parameter. Bits: 0 closed, 1 periodic, 2 degenerated.
        pub fn BRepAdaptor_Curve_range(edge: &TopoDS_Edge, out: &mut [f64]) -> Result<i32>;
        /// `out` gets the point and the first derivative at parameter `t`.
        pub fn BRepAdaptor_Curve_d1(edge: &TopoDS_Edge, t: f64, out: &mut [f64]) -> Result<()>;
        /// The edge is a seam of `face`, it bounds the face on both sides.
        pub fn BRep_Tool_is_closed_on(edge: &TopoDS_Edge, face: &TopoDS_Face) -> bool;
        pub fn BRep_Tool_edge_tolerance(edge: &TopoDS_Edge) -> f64;
        pub fn BRep_Tool_face_tolerance(face: &TopoDS_Face) -> f64;
    }
}
