//! Measures the frame transport and the native tracer in a real webview, under its own identifier so it shares no app
//! data.
//! Run `npx vite --port 5174 --strictPort`, then `cargo run --example frames_probe`. Prints one line, PROBE {json}.
//! PROBE_PAGE=e2e/tracer_switch_page.html tries each tracer backend, e2e/native_bloom_page.html the native bloom at the
//! cap.

#[tauri::command]
fn probe_report(app: tauri::AppHandle, json: String) {
    println!("PROBE {json}");
    app.exit(0);
}

fn main() {
    // Where the WebSocket transport serves (Linux, macOS), only the app's own origins pass the gate.
    if std::env::var_os("FUNDACAD_EXTRA_ORIGINS").is_none() {
        std::env::set_var("FUNDACAD_EXTRA_ORIGINS", "http://localhost:5174");
    }
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
            fundacad_lib::frames::tracer::pt_bloom,
            fundacad_lib::frames::tracer::pt_status,
            fundacad_lib::frames::tracer::pt_picture,
            fundacad_lib::frames::tracer::pt_picture_cancel,
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
