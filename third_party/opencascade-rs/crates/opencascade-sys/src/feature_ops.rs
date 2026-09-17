//! Hole, loft and sweep operations for the FundaCAD timeline builder
//! (include/feature_ops.hxx).

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/feature_ops.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn fo_polygon_face(pts: &[f64]) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn fo_distance_to_point(s: &TopoDS_Shape, x: f64, y: f64, z: f64) -> f64;
        pub fn fo_length(s: &TopoDS_Shape) -> f64;
        pub fn fo_loft(sections: &TopoDS_Shape, ruled: bool) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn fo_sweep(profile: &TopoDS_Shape, path: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
