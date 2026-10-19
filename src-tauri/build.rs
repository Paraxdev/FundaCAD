include!("../crates/fundacad-engine/build_identity.rs");

fn main() {
    emit_engine_build();
    tauri_build::build()
}
