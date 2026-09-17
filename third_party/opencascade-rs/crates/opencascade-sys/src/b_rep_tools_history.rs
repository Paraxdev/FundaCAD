//! `BRepTools_History`, the modification record several algorithms hand back.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/b_rep_tools_history.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        type FcHistory;

        pub fn FcHistory_is_null(history: &FcHistory) -> bool;
        pub fn FcHistory_modified(
            history: &FcHistory,
            shape: &TopoDS_Shape,
        ) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn FcHistory_generated(
            history: &FcHistory,
            shape: &TopoDS_Shape,
        ) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn FcHistory_is_removed(history: &FcHistory, shape: &TopoDS_Shape) -> Result<bool>;
    }

    impl UniquePtr<FcHistory> {}
}
