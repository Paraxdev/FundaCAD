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
        pub fn fo_axial_extent(
            s: &TopoDS_Shape,
            ox: f64,
            oy: f64,
            oz: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            out: &mut [f64],
        ) -> bool;
        pub fn fo_face_wire_list(face: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn fo_axial_scale(
            s: &TopoDS_Shape,
            factor: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            hold: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn fo_screw_sweep(
            wire: &TopoDS_Shape,
            px: f64,
            py: f64,
            pz: f64,
            xx: f64,
            xy: f64,
            xz: f64,
            zx: f64,
            zy: f64,
            zz: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            radius: f64,
            pitch: f64,
            height: f64,
            lefthand: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
