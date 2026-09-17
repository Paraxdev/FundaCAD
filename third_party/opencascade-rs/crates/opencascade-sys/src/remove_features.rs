pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/remove_features.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopTools_ListOfShape = crate::top_tools::TopTools_ListOfShape;
        type Message_ProgressRange = crate::message::Message_ProgressRange;
        type FcHistory = crate::b_rep_tools_history::FcHistory;

        type BOPAlgo_RemoveFeatures;

        pub fn BOPAlgo_RemoveFeatures_run(
            shape: &TopoDS_Shape,
            faces: &TopTools_ListOfShape,
            parallel: bool,
            progress: &Message_ProgressRange,
        ) -> Result<UniquePtr<BOPAlgo_RemoveFeatures>>;
        pub fn HasErrors(self: &BOPAlgo_RemoveFeatures) -> bool;
        pub fn HasWarnings(self: &BOPAlgo_RemoveFeatures) -> bool;
        pub fn BOPAlgo_RemoveFeatures_shape(algo: &BOPAlgo_RemoveFeatures) -> UniquePtr<TopoDS_Shape>;
        /// Alert keys, one per line, prefixed by gravity (W, A, F).
        pub fn BOPAlgo_RemoveFeatures_alerts(algo: &BOPAlgo_RemoveFeatures) -> String;
        pub fn BOPAlgo_RemoveFeatures_history(algo: Pin<&mut BOPAlgo_RemoveFeatures>) -> UniquePtr<FcHistory>;
    }
}
