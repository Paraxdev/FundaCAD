//! With the plugin host on, compile the vendored Qhull 2020.2 behind the
//! kernel's `delaunay-2d` (third_party/qhull, the version scipy bundles).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var_os("CARGO_FEATURE_PLUGINS").is_none() {
        return;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../third_party/qhull");
    let lib = root.join("src/libqhull_r");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut b = cc::Build::new();
    for f in [
        "geom2_r.c",
        "geom_r.c",
        "global_r.c",
        "io_r.c",
        "libqhull_r.c",
        "mem_r.c",
        "merge_r.c",
        "poly2_r.c",
        "poly_r.c",
        "qset_r.c",
        "random_r.c",
        "stat_r.c",
        "user_r.c",
        "usermem_r.c",
        "userprintf_r.c",
    ] {
        b.file(lib.join(f));
    }
    b.file(root.join("fc_delaunay.c"))
        .include(root.join("src"))
        .include(&lib)
        .warnings(false)
        .define("_CRT_SECURE_NO_WARNINGS", None);
    if b.get_compiler().is_like_msvc() {
        // no contraction into fused multiply adds: the arithmetic must be the
        // one scipy's Qhull does, operation for operation
        b.flag("/fp:precise");
    } else {
        b.flag("-ffp-contract=off");
    }
    b.compile("fc_qhull");
}
