//! Booleans and the splitters with their General Fuse options (fuzzy value,
//! glue, non-destructive, parallel, OBB), history and alert reports.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/boolean_algo.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopTools_ListOfShape = crate::top_tools::TopTools_ListOfShape;
        type Message_ProgressRange = crate::message::Message_ProgressRange;

        type FcBooleanRun;

        /// `kind` 0 fuse, 1 cut, 2 common, 3 section, 4 BRepAlgoAPI_Splitter,
        /// 5 general fuse (arguments only). `glue` 0 off, 1 shift, 2 full.
        /// A zero fuzzy value keeps the exact default.
        #[allow(clippy::too_many_arguments)]
        pub fn FcBooleanRun_perform(
            kind: i32,
            arguments: &TopTools_ListOfShape,
            tools: &TopTools_ListOfShape,
            fuzzy: f64,
            glue: i32,
            non_destructive: bool,
            parallel: bool,
            use_obb: bool,
            progress: &Message_ProgressRange,
        ) -> Result<UniquePtr<FcBooleanRun>>;
        pub fn FcBooleanRun_is_done(run: &FcBooleanRun) -> bool;
        pub fn FcBooleanRun_has_errors(run: &FcBooleanRun) -> bool;
        pub fn FcBooleanRun_has_warnings(run: &FcBooleanRun) -> bool;
        /// Alert keys, one per line, each prefixed by its gravity (W, A, F).
        pub fn FcBooleanRun_alerts(run: &FcBooleanRun) -> String;
        pub fn FcBooleanRun_shape(run: &FcBooleanRun) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn FcBooleanRun_modified(
            run: Pin<&mut FcBooleanRun>,
            shape: &TopoDS_Shape,
        ) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn FcBooleanRun_generated(
            run: Pin<&mut FcBooleanRun>,
            shape: &TopoDS_Shape,
        ) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn FcBooleanRun_is_deleted(run: Pin<&mut FcBooleanRun>, shape: &TopoDS_Shape) -> Result<bool>;
        pub fn FcBooleanRun_section_edges(
            run: Pin<&mut FcBooleanRun>,
        ) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn FcBooleanRun_simplify(
            run: Pin<&mut FcBooleanRun>,
            unify_edges: bool,
            unify_faces: bool,
            angular_tolerance: f64,
        ) -> Result<()>;

        /// `BOPAlgo_Splitter` directly, the class sketch_build.py region detection uses.
        pub fn BOPAlgo_Splitter_perform(
            arguments: &TopTools_ListOfShape,
            tools: &TopTools_ListOfShape,
            fuzzy: f64,
            non_destructive: bool,
            parallel: bool,
            progress: &Message_ProgressRange,
            has_errors: &mut bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
