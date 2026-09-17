pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/xcaf.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        type XcafStepWriter;
        pub fn xcaf_step_writer_new() -> Result<UniquePtr<XcafStepWriter>>;
        /// A negative `parent` adds a root. Returns the node index or -1.
        pub fn xcaf_step_writer_add(
            writer: Pin<&mut XcafStepWriter>,
            shape: &TopoDS_Shape,
            parent: i32,
            name: &str,
            has_color: bool,
            r: f64,
            g: f64,
            b: f64,
        ) -> Result<i32>;
        pub fn xcaf_step_writer_write(
            writer: Pin<&mut XcafStepWriter>,
            header_name: &str,
            path: &str,
        ) -> Result<()>;

        type StepAssembly;
        pub fn step_assembly_read(path: &str) -> Result<UniquePtr<StepAssembly>>;
        pub fn step_assembly_node_count(a: &StepAssembly) -> i32;
        pub fn step_assembly_node_names(a: &StepAssembly, i: i32) -> Result<Vec<u8>>;
        pub fn step_assembly_node_parent(a: &StepAssembly, i: i32) -> Result<i32>;
        pub fn step_assembly_node_color(a: &StepAssembly, i: i32) -> Result<i32>;
        pub fn step_assembly_leaf_count(a: &StepAssembly) -> i32;
        pub fn step_assembly_leaf_node(a: &StepAssembly, i: i32) -> Result<i32>;
        pub fn step_assembly_leaf_shape(a: &StepAssembly, i: i32) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn step_assembly_leaf_face_colors(a: &StepAssembly, i: i32) -> Result<Vec<i32>>;
        pub fn step_assembly_leaf_solid_color(a: &StepAssembly, i: i32) -> Result<i32>;
        pub fn step_assembly_root_count(a: &StepAssembly) -> i32;
        pub fn step_assembly_root_shape(a: &StepAssembly, i: i32) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn step_assembly_is_assembly(a: &StepAssembly) -> bool;
    }
}
