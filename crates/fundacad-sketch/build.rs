//! Compiles the vendored planegcs (third_party/planegcs, FreeCAD's Sketcher solver) against the vendored Eigen.

fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let gcs = root.join("../../third_party/planegcs/src");
    let eigen = root.join("../../third_party/eigen");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=cpp");
    println!("cargo:rerun-if-changed={}", gcs.display());
    let mut b = cc::Build::new();
    b.cpp(true)
        .std("c++20")
        .files(["GCS.cpp", "Geo.cpp", "Constraints.cpp", "SubSystem.cpp", "qp_eq.cpp"].map(|f| gcs.join(f)))
        .file(root.join("cpp/gcs_shim.cpp"))
        .include(&gcs)
        .include(&eigen)
        // Eigen's few LGPL parts stay out, the rest is MPL 2.0
        .define("EIGEN_MPL2_ONLY", None)
        .warnings(false);
    if b.get_compiler().is_like_msvc() {
        b.flag("/EHsc").flag("/bigobj").flag("/utf-8");
    }
    b.compile("fc_planegcs");
}
