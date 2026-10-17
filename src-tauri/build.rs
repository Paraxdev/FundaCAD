include!("../crates/fundacad-engine/build_identity.rs");

fn main() {
    emit_engine_build();
    // The import of OpenImageDenoise.dll would stop the app at launch when the
    // library is missing; delay loaded, the tracer checks for it first.
    if std::env::var_os("CARGO_FEATURE_OIDN").is_some() && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/DELAYLOAD:OpenImageDenoise.dll");
    }
    tauri_build::build()
}
