pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/geom_cache.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        /// Face, edge and vertex counts then the poles box (xmin..zmax) into
        /// `out`, false for a null shape. The box ignores triangulation.
        pub fn geom_cache_fingerprint(shape: &TopoDS_Shape, out: &mut [f64]) -> bool;
    }
}
