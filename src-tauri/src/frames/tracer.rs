//! The native tracer behind the frame transport, and the pt_* commands the
//! page feeds it the scene with. Commands only change the scene; the frame
//! loop applies the changes before it traces, so a burst of pt_mesh calls
//! builds the TLAS once.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use fundacad_frames::{FrameSource, Reopen};
use fundacad_tracer::{decode_colors, decode_mesh, denoise, BodyDesc, Camera, Look, Path, Quality, Tracer, TracerOptions};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

/// GPU time per frame; the resolve and readback come on top.
const TRACE_BUDGET: Duration = Duration::from_millis(12);

struct State {
    tracer: Tracer,
    fault: Option<String>,
}

pub struct TracerSource(Mutex<State>);

static TRACER: Reopen<TracerSource> = Reopen::new();

/// FUNDACAD_TRACER=software keeps the BVH path on a ray query adapter, off
/// leaves the test pattern, both for measuring. A fresh tracer starts with no
/// fault, so a released one comes back clean.
pub fn tracer() -> Result<Arc<TracerSource>, String> {
    TRACER.get(|| {
        let mode = std::env::var("FUNDACAD_TRACER").unwrap_or_default();
        if mode == "off" {
            return Err("the native tracer is off (FUNDACAD_TRACER=off)".into());
        }
        let opts = TracerOptions { software: mode == "software", ..Default::default() };
        Tracer::new(opts)
            .map(|tracer| TracerSource(Mutex::new(State { tracer, fault: None })))
            .map_err(|e| {
                eprintln!("[frames] no native tracer: {e}");
                e.to_string()
            })
    })
}

/// Only frames_open and pt_probe make a tracer, so a late scene call after a
/// release cannot bring the device back with nothing drawing it.
fn open() -> Result<Arc<TracerSource>, String> {
    TRACER.current().ok_or_else(|| "the native tracer is not open".into())
}

/// The device, pipelines and scene buffers go once the closed transport drops
/// its handle too; the next use makes a fresh tracer.
pub fn release() -> Option<Arc<TracerSource>> {
    TRACER.release()
}

pub fn pattern_allowed() -> bool {
    std::env::var("FUNDACAD_TRACER").is_ok_and(|m| m == "off")
}

impl TracerSource {
    pub fn name(&self) -> String {
        let s = self.lock();
        let path = match s.tracer.path() {
            Path::RayQuery => "ray query",
            Path::Software => "software",
        };
        format!("tracer, {path}, {}", s.tracer.adapter())
    }

    /// A panic in wgpu poisons nothing for the next caller; the fault is
    /// reported through pt_status instead.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl FrameSource for TracerSource {
    fn render(&self, out: &mut [u8], width: u32, height: u32, _seq: u32) {
        let mut s = self.lock();
        if s.fault.is_some() {
            out.fill(0);
            return;
        }
        match catch_unwind(AssertUnwindSafe(|| s.tracer.frame(width, height, TRACE_BUDGET))) {
            Ok(px) if px.len() == out.len() => out.copy_from_slice(&px),
            Ok(px) => {
                s.fault = Some(format!("a {} byte frame for a {} byte slot", px.len(), out.len()));
                out.fill(0);
            }
            Err(e) => {
                let why = e
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "the tracer panicked".into());
                eprintln!("[frames] tracer fault: {why}");
                s.fault = Some(why);
                out.fill(0);
            }
        }
    }
}

fn with<T>(f: impl FnOnce(&mut Tracer) -> T) -> Result<T, String> {
    let t = open()?;
    let mut s = t.lock();
    if let Some(f) = &s.fault {
        return Err(format!("the native tracer stopped: {f}"));
    }
    Ok(f(&mut s.tracer))
}

fn raw(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("this command takes raw bytes".into()),
    }
}

/// Replaces the body list; answers the mesh keys to send with pt_mesh.
#[tauri::command]
pub async fn pt_scene(bodies: Vec<BodyDesc>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || with(|t| t.set_bodies(bodies)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pt_mesh(request: Request<'_>) -> Result<(), String> {
    let bytes = raw(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (key, mesh) = decode_mesh(&bytes)?;
        with(|t| t.add_mesh(&key, mesh))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// False when the key has no mesh yet.
#[tauri::command]
pub fn pt_colors(request: Request<'_>) -> Result<bool, String> {
    let (key, colors) = decode_colors(&raw(&request)?)?;
    with(|t| t.set_colors(&key, colors))
}

#[tauri::command]
pub fn pt_camera(camera: Camera) -> Result<(), String> {
    with(|t| t.set_camera(camera))
}

#[tauri::command]
pub fn pt_look(look: Look) -> Result<(), String> {
    with(|t| t.set_look(look))
}

#[tauri::command]
pub fn pt_cap(cap: u32) -> Result<(), String> {
    with(|t| t.set_cap(cap))
}

/// The weights the cap is denoised with: off, standard or high.
#[tauri::command]
pub fn pt_denoise(level: Quality) -> Result<(), String> {
    with(|t| t.set_denoise(level))
}

#[tauri::command]
pub fn pt_budget(paths: u32) -> Result<(), String> {
    with(|t| t.set_frame_budget(paths))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    samples: u32,
    generation: u64,
    band: u32,
    path: &'static str,
    adapter: String,
    fault: Option<String>,
    /// The frames at the cap carry the denoised image.
    denoised: bool,
    /// A denoise of the current cap is still running.
    denoising: bool,
    denoise_error: Option<String>,
}

#[tauri::command]
pub fn pt_status() -> Result<Status, String> {
    let t = open()?;
    let mut s = t.lock();
    s.tracer.poll_denoise();
    Ok(Status {
        samples: s.tracer.samples(),
        generation: s.tracer.generation(),
        band: s.tracer.band(),
        path: path_id(s.tracer.path()),
        adapter: s.tracer.adapter().to_string(),
        fault: s.fault.clone(),
        denoised: s.tracer.denoised(),
        denoising: s.tracer.denoising(),
        denoise_error: s.tracer.denoise_error().map(str::to_string),
    })
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    available: bool,
    path: Option<&'static str>,
    adapter: Option<String>,
    /// Whether the native denoise can run at the cap.
    denoise: bool,
    reason: Option<String>,
}

fn path_id(p: Path) -> &'static str {
    match p {
        Path::RayQuery => "rayquery",
        Path::Software => "software",
    }
}

/// Whether this machine has a native tracer and which path it runs, without
/// opening frames. A tracer made only to answer is released again.
#[tauri::command]
pub async fn pt_probe() -> Probe {
    tauri::async_runtime::spawn_blocking(|| {
        let _life = super::lifecycle();
        let was_open = TRACER.current().is_some();
        let probe = match tracer() {
            Ok(t) => {
                let s = t.lock();
                Probe { available: true, path: Some(path_id(s.tracer.path())), adapter: Some(s.tracer.adapter().to_string()), denoise: denoise::available().is_ok(), reason: None }
            }
            Err(e) => Probe { available: false, path: None, adapter: None, denoise: false, reason: Some(e) },
        };
        if !was_open {
            TRACER.release();
        }
        probe
    })
    .await
    .unwrap_or_else(|e| Probe { available: false, path: None, adapter: None, denoise: false, reason: Some(e.to_string()) })
}
