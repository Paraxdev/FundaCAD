//! The app's frame transport and the page's native tracer backend, measured in
//! a real webview. Its own identifier, so it shares no data directory, no
//! single instance lock and no session file with the app.
//!
//!   npx vite --port 5174 --strictPort
//!   cargo run --example frames_probe
//!
//! Prints one line, PROBE {json}, and exits.

#[tauri::command]
fn probe_report(app: tauri::AppHandle, json: String) {
    println!("PROBE {json}");
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fundacad_lib::frames::frames_open,
            fundacad_lib::frames::frames_next,
            fundacad_lib::frames::frames_resize,
            fundacad_lib::frames::frames_close,
            probe_report
        ])
        .run(tauri::generate_context!("examples/frames_probe/tauri.conf.json"))
        .expect("the probe window");
}
