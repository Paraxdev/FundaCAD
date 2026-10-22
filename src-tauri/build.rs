include!("../crates/fundacad-engine/build_identity.rs");

fn main() {
    emit_engine_build();
    // Tauri's default manifest plus the Segment Heap, as this exe is also the engine it spawns with --engine.
    // crates/fundacad-cli/build.rs says why the heap matters.
    println!("cargo:rerun-if-changed=windows-app.manifest");
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app.manifest"));
    if let Err(error) = tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)) {
        println!("{error:#}");
        std::process::exit(1);
    }
}
