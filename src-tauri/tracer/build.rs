fn main() {
    // A missing OpenImageDenoise.dll then skips the denoise tests instead of
    // stopping the test binary at load; the app does the same in its build.rs.
    if std::env::var_os("CARGO_FEATURE_OIDN").is_some() && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/DELAYLOAD:OpenImageDenoise.dll");
        println!("cargo:rustc-link-lib=delayimp");
    }
}
