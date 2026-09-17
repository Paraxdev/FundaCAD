pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/mass_props.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        /// `kind` 1 linear, 2 surface, 3 volume. `out` gets mass, centre of mass
        /// (3), the inertia matrix about the centre row by row (9) and the
        /// principal moments (3).
        pub fn BRepGProp_properties(
            shape: &TopoDS_Shape,
            kind: i32,
            skip_shared: bool,
            out: &mut [f64],
        ) -> Result<()>;
    }
}
