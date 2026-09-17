// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "rust-engine")]
    if std::env::args().nth(1).as_deref() == Some("--engine") {
        fundacad_lib::run_engine_worker();
    }
    fundacad_lib::run()
}
