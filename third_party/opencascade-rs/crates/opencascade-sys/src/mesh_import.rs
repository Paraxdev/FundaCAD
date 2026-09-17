pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/mesh_import.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn mesh_import_sew(pos: &[f64], idx: &[u32]) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn mesh_import_unify(shape: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn mesh_import_explode(shape: &TopoDS_Shape) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn mesh_import_shapes_len(v: &CxxVector<TopoDS_Shape>) -> usize;
        pub fn mesh_import_shapes_get(v: &CxxVector<TopoDS_Shape>, i: usize) -> Result<UniquePtr<TopoDS_Shape>>;

        type FaceFacts;
        pub fn face_facts_new(shape: &TopoDS_Shape) -> Result<UniquePtr<FaceFacts>>;
        pub fn face_facts_count(f: &FaceFacts) -> i32;
        pub fn face_facts_all_planar(f: &FaceFacts) -> Result<bool>;
        pub fn face_facts_plane(f: &FaceFacts, i: i32) -> Result<Vec<f64>>;
        pub fn face_facts_vertices(f: &FaceFacts, i: i32) -> Result<Vec<f64>>;
        pub fn face_facts_neighbors(f: &FaceFacts, i: i32) -> Result<Vec<i32>>;

        type PlanarRebuild;
        pub fn planar_rebuild_new() -> UniquePtr<PlanarRebuild>;
        pub fn planar_rebuild_add(
            r: Pin<&mut PlanarRebuild>,
            plane: &[f64],
            points: &[f64],
            loop_lens: &[u32],
        ) -> Result<bool>;
        pub fn planar_rebuild_finish(r: &PlanarRebuild, sew_tol: f64) -> Result<UniquePtr<TopoDS_Shape>>;

    }
}
