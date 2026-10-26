//! Fillet and chamfer operations for the FundaCAD blend port
//! (include/blend_ops.hxx). Edge lists travel as a compound of the edges.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/blend_ops.hxx");
        include!("opencascade-sys/include/blend_conic.hxx");
        include!("opencascade-sys/include/blend_section.hxx");
        include!("opencascade-sys/include/blend_measure.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type Message_ProgressRange = crate::message::Message_ProgressRange;

        pub fn blend_fillet(
            shape: &TopoDS_Shape,
            edges: &TopoDS_Shape,
            radii: &[f64],
            status: &mut i32,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn blend_chamfer(
            shape: &TopoDS_Shape,
            edges: &TopoDS_Shape,
            d1: &[f64],
            d2: &[f64],
            status: &mut i32,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn blend_copy(
            shape: &TopoDS_Shape,
            edges: &TopoDS_Shape,
        ) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn blend_is_seam(shape: &TopoDS_Shape, edge: &TopoDS_Shape) -> bool;
        pub fn blend_dihedral_deg(
            shape: &TopoDS_Shape,
            edge: &TopoDS_Shape,
            px: f64,
            py: f64,
            pz: f64,
        ) -> f64;
        pub fn blend_face_triangles(faces: &TopoDS_Shape, deflection: f64) -> Result<Vec<f64>>;
        pub fn blend_is_valid(shape: &TopoDS_Shape) -> bool;
        /// `continuity` 1, 2 or 3 is the section's continuity with the faces.
        /// Never throws: `status` 0 built, 1 the profile does not apply, 2 refused.
        pub fn blend_conic(
            sharp: &TopoDS_Shape,
            edges: &TopoDS_Shape,
            radius: f64,
            profile: f64,
            status: &mut i32,
            message: &mut String,
        ) -> UniquePtr<TopoDS_Shape>;
        /// Never throws: `status` 0 built, 1 SectionBlendError, 2 another
        /// exception, 3 cancelled through `progress`, checked between its steps
        /// and inside every boolean. `one_shot` false skips cutting every tool
        /// at once, for when that answer left faces lying on each other.
        #[allow(clippy::too_many_arguments)]
        pub fn blend_section(
            shape: &TopoDS_Shape,
            edges: &TopoDS_Shape,
            chamfer: bool,
            sizes: &[f64],
            size2: f64,
            unit: f64,
            continuity: i32,
            draft: bool,
            profile: f64,
            one_shot: bool,
            progress: &Message_ProgressRange,
            status: &mut i32,
            message: &mut String,
        ) -> UniquePtr<TopoDS_Shape>;
        /// The highest continuity (1, 2 or 3) the section build reaches on `edge` of `shape`.
        pub fn blend_reach(shape: &TopoDS_Shape, edge: &TopoDS_Shape) -> i32;
        /// A test helper, see blend_measure.hxx: curvature and rate jumps across
        /// the tangent contacts, the largest crease, the contact count, the
        /// largest tolerance and 1 when the shape is valid.
        pub fn blend_contact_jumps(shape: &TopoDS_Shape, radius: f64, reach: f64) -> Vec<f64>;
    }
}
