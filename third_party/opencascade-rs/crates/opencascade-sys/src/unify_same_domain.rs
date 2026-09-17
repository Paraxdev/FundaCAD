pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/unify_same_domain.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopTools_ListOfShape = crate::top_tools::TopTools_ListOfShape;
        type FcHistory = crate::b_rep_tools_history::FcHistory;
        type ShapeUpgrade_UnifySameDomain = crate::shape_upgrade::ShapeUpgrade_UnifySameDomain;

        /// A non-positive tolerance keeps the default. `keep` lists edges and
        /// vertices that must survive the merge.
        #[allow(clippy::too_many_arguments)]
        pub fn ShapeUpgrade_UnifySameDomain_run(
            shape: &TopoDS_Shape,
            unify_edges: bool,
            unify_faces: bool,
            concat_bsplines: bool,
            allow_internal_edges: bool,
            safe_input: bool,
            linear_tolerance: f64,
            angular_tolerance: f64,
            keep: &TopTools_ListOfShape,
        ) -> Result<UniquePtr<ShapeUpgrade_UnifySameDomain>>;
        pub fn ShapeUpgrade_UnifySameDomain_result(
            unify: &ShapeUpgrade_UnifySameDomain,
        ) -> UniquePtr<TopoDS_Shape>;
        pub fn ShapeUpgrade_UnifySameDomain_history(
            unify: &ShapeUpgrade_UnifySameDomain,
        ) -> UniquePtr<FcHistory>;
    }
}
