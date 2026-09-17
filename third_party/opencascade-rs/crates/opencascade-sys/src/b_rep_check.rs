pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/b_rep_check.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn BRepCheck_Analyzer_is_valid(
            shape: &TopoDS_Shape,
            geometry_checks: bool,
            parallel: bool,
            exact: bool,
        ) -> Result<bool>;
    }
}
