//! The app's frame transport and the page's native tracer backend, measured in
//! a real webview. Its own identifier, so it shares no data directory, no
//! single instance lock and no session file with the app.
//!
//!   npx vite --port 5174 --strictPort
//!   cargo run --example frames_probe
//!
//! PROBE_PAGE=e2e/tracer_switch_page.html runs Path traced through the host
//! on each tracer backend instead.
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
            fundacad_lib::frames::tracer::pt_scene,
            fundacad_lib::frames::tracer::pt_mesh,
            fundacad_lib::frames::tracer::pt_colors,
            fundacad_lib::frames::tracer::pt_camera,
            fundacad_lib::frames::tracer::pt_look,
            fundacad_lib::frames::tracer::pt_cap,
            fundacad_lib::frames::tracer::pt_budget,
            fundacad_lib::frames::tracer::pt_denoise,
            fundacad_lib::frames::tracer::pt_status,
            fundacad_lib::frames::tracer::pt_probe,
            probe_report
        ])
        .setup(|app| {
            use tauri::Manager;
            if let (Ok(page), Some(w)) = (std::env::var("PROBE_PAGE"), app.get_webview_window("main")) {
                w.eval(format!("location.replace('/{page}')"))?;
            }
            Ok(())
        })
        .run(tauri::generate_context!("examples/frames_probe/tauri.conf.json"))
        .expect("the probe window");
}
