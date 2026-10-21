include!("../fundacad-engine/build_identity.rs");

fn main() {
    emit_engine_build();
    embed_segment_heap_manifest();
}

/// The Segment Heap (Windows 10 2004 and later, ignored before) meshes a big
/// document up to a third faster than the NT heap: BRepMesh's 1 MiB blocks
/// are each a fresh VirtualAlloc there, and the page faults serialize the
/// mesh threads. src-tauri/build.rs asks the same for the app executable.
fn embed_segment_heap_manifest() {
    println!("cargo:rerun-if-changed=engine.manifest");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !msvc {
        return;
    }
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("engine.manifest");
    for kind in ["bins", "examples", "tests"] {
        println!("cargo:rustc-link-arg-{kind}=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-{kind}=/MANIFESTINPUT:{}", manifest.display());
    }
}
