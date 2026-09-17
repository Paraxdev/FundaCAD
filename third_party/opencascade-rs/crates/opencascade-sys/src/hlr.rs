//! `HLRBRep_Algo`, `HLRAlgo_Projector` and `HLRBRep_HLRToShape`.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/hlr.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        /// A compound of [visible sharp edges, visible outlines], in the
        /// projector's 2D frame. `frame` is origin, normal, xdir.
        pub fn HLR_visible_outline(shape: &TopoDS_Shape, frame: &[f64]) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
