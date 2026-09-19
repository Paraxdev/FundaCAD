// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--engine") {
        fundacad_lib::run_engine_worker();
    }
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        std::process::exit(if fundacad_mcp::run_stdio().is_ok() { 0 } else { 1 });
    }
    fundacad_lib::run()
}
