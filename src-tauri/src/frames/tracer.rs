//! The native tracer behind the frame transport, and the pt_* commands the
//! page feeds it the scene with. Commands only change the scene; the frame
//! loop applies the changes before it traces, so a burst of pt_mesh calls
//! builds the TLAS once.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use fundacad_frames::{FrameSource, Reopen};
use fundacad_tracer::{decode_colors, decode_mesh, denoise, encode_png, Bloom, BodyDesc, Camera, Denoiser, Look, Path, Picture, Quality, Refusal, Tracer, TracerOptions};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

/// GPU time per frame; the resolve and readback come on top.
const TRACE_BUDGET: Duration = Duration::from_millis(12);

/// GPU time a picture holds the tracer for at once, so pt_status and the
/// scene commands get in between.
const PICTURE_SLICE: Duration = Duration::from_millis(50);

struct State {
    tracer: Tracer,
    fault: Option<String>,
    /// A traced picture is running; the viewport's frames wait for it.
    picture: Option<PictureStatus>,
    cancel: bool,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct PictureStatus {
    samples: u32,
    total: u32,
    denoising: bool,
}

impl State {
    /// Takes up a loss or error the device reported, even one raised by a
    /// command with no frame since.
    fn take_fault(&mut self) {
        if self.fault.is_none() {
            if let Some(f) = self.tracer.fault() {
                eprintln!("[frames] tracer fault: {f}");
                self.fault = Some(f);
            }
        }
    }
}

pub struct TracerSource(Mutex<State>);

static TRACER: Reopen<TracerSource> = Reopen::new();

/// Why the last attempt made no tracer, for pt_probe's class. Reopen keeps
/// only the text.
static REFUSED: Mutex<Option<Refusal>> = Mutex::new(None);

/// FUNDACAD_TRACER=software keeps the BVH path on a ray query adapter, off
/// leaves the test pattern, both for measuring. A fresh tracer starts with no
/// fault, so a released one comes back clean.
pub fn tracer() -> Result<Arc<TracerSource>, String> {
    TRACER.get(|| {
        let mode = std::env::var("FUNDACAD_TRACER").unwrap_or_default();
        *REFUSED.lock().unwrap_or_else(|p| p.into_inner()) = None;
        if mode == "off" {
            return Err("the native tracer is off (FUNDACAD_TRACER=off)".into());
        }
        let opts = TracerOptions { software: mode == "software", ..Default::default() };
        Tracer::new(opts)
            .map(|tracer| TracerSource(Mutex::new(State { tracer, fault: None, picture: None, cancel: false })))
            .map_err(|e| {
                eprintln!("[frames] no native tracer: {e}");
                let text = e.to_string();
                *REFUSED.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
                text
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
        s.take_fault();
        if s.fault.is_some() {
            out.fill(0);
            return;
        }
        if s.picture.is_some() {
            return;
        }
        match catch_unwind(AssertUnwindSafe(|| s.tracer.frame(width, height, TRACE_BUDGET))) {
            Ok(px) if px.len() == out.len() => {
                out.copy_from_slice(&px);
                s.take_fault();
            }
            Ok(px) => {
                s.fault = Some(format!("a {} byte frame for a {} byte slot", px.len(), out.len()));
                out.fill(0);
            }
            Err(e) => {
                let why = panic_text(e);
                eprintln!("[frames] tracer fault: {why}");
                s.fault = Some(why);
                out.fill(0);
            }
        }
    }
}

fn panic_text(e: Box<dyn std::any::Any + Send>) -> String {
    e.downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "the tracer panicked".into())
}

fn with<T>(f: impl FnOnce(&mut Tracer) -> T) -> Result<T, String> {
    let t = open()?;
    let mut s = t.lock();
    s.take_fault();
    if let Some(f) = &s.fault {
        return Err(format!("the native tracer stopped: {f}"));
    }
    let r = f(&mut s.tracer);
    s.take_fault();
    Ok(r)
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

/// Bloom before tone mapping, null for none; keeps the samples.
#[tauri::command]
pub fn pt_bloom(bloom: Option<Bloom>) -> Result<(), String> {
    with(|t| t.set_bloom(bloom))
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
    /// What cleaned the frames at the cap.
    denoiser: Option<Denoiser>,
    denoise_error: Option<String>,
    /// A traced picture's progress while one runs.
    picture: Option<PictureStatus>,
}

#[tauri::command]
pub fn pt_status() -> Result<Status, String> {
    let t = open()?;
    let mut s = t.lock();
    s.tracer.poll_denoise();
    s.take_fault();
    Ok(Status {
        samples: s.tracer.samples(),
        generation: s.tracer.generation(),
        band: s.tracer.band(),
        path: path_id(s.tracer.path()),
        adapter: s.tracer.adapter().to_string(),
        fault: s.fault.clone(),
        denoised: s.tracer.denoised(),
        denoising: s.tracer.denoising(),
        denoiser: s.tracer.denoised_by(),
        denoise_error: s.tracer.denoise_error().map(str::to_string),
        picture: s.picture,
    })
}

/// A still of the current scene and camera at `width` x `height`, traced to
/// `samples` beside the viewport's accumulation, denoised once at the end and
/// bloomed like the viewport. Answers the PNG file's bytes.
#[tauri::command]
pub async fn pt_picture(width: u32, height: u32, samples: u32) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || picture(width, height, samples).map(tauri::ipc::Response::new))
        .await
        .map_err(|e| e.to_string())?
}

/// Stops a running picture; its pt_picture answers an error.
#[tauri::command]
pub fn pt_picture_cancel() -> Result<(), String> {
    let t = open()?;
    let mut s = t.lock();
    if s.picture.is_some() {
        s.cancel = true;
    }
    Ok(())
}

pub const PICTURE_CANCELLED: &str = "the picture was cancelled";

/// Clears the running picture however `picture` returns, panics included,
/// so the viewport's frames resume.
struct Running(Arc<TracerSource>);

impl Drop for Running {
    fn drop(&mut self) {
        let mut s = self.0.lock();
        s.picture = None;
        s.cancel = false;
    }
}

pub fn picture(width: u32, height: u32, samples: u32) -> Result<Vec<u8>, String> {
    let t = open()?;
    let mut p = {
        let mut s = t.lock();
        s.take_fault();
        if let Some(f) = &s.fault {
            return Err(format!("the native tracer stopped: {f}"));
        }
        if s.picture.is_some() {
            return Err("a picture is already being traced".into());
        }
        let p = s.tracer.begin_picture(width, height, samples, Quality::High)?;
        s.picture = Some(PictureStatus { samples: 0, total: p.total(), denoising: false });
        s.cancel = false;
        p
    };
    let _running = Running(t.clone());
    let step = |p: &mut Picture, s: &mut State| -> Result<bool, String> {
        if s.cancel {
            return Err(PICTURE_CANCELLED.into());
        }
        let done = catch_unwind(AssertUnwindSafe(|| s.tracer.trace_picture(p, PICTURE_SLICE))).map_err(|e| {
            // The picture's buffers may still be swapped in, so the viewport cannot trace on.
            let why = panic_text(e);
            s.fault = Some(why.clone());
            why
        })?;
        s.take_fault();
        if let Some(f) = &s.fault {
            return Err(format!("the native tracer stopped: {f}"));
        }
        s.picture = Some(PictureStatus { samples: p.samples(), total: p.total(), denoising: done });
        Ok(done)
    };
    while !step(&mut p, &mut t.lock())? {}
    catch_unwind(AssertUnwindSafe(|| p.denoise())).map_err(panic_text)?;
    let (w, h) = p.size();
    let px = {
        let mut s = t.lock();
        if s.cancel {
            return Err(PICTURE_CANCELLED.into());
        }
        let px = catch_unwind(AssertUnwindSafe(|| s.tracer.finish_picture(p))).map_err(|e| {
            let why = panic_text(e);
            s.fault = Some(why.clone());
            why
        })?;
        s.take_fault();
        if let Some(f) = &s.fault {
            return Err(format!("the native tracer stopped: {f}"));
        }
        px
    };
    encode_png(w, h, &px)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    available: bool,
    path: Option<&'static str>,
    adapter: Option<String>,
    /// Whether the native denoise can run at the cap.
    denoise: bool,
    /// Which one: Open Image Denoise when installed, else the filter.
    denoiser: Option<Denoiser>,
    reason: Option<String>,
    /// noadapter, cpu, limits or selfcheck: which greying reason the page shows.
    class: Option<&'static str>,
    /// What the refused adapter binds, for the limits class.
    storage_buffers: Option<u32>,
}

impl Probe {
    fn refused(reason: String, why: Option<&Refusal>) -> Probe {
        Probe {
            available: false,
            path: None,
            adapter: None,
            denoise: false,
            denoiser: None,
            reason: Some(reason),
            class: why.and_then(Refusal::class),
            storage_buffers: why.and_then(Refusal::storage_buffers),
        }
    }
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
                Probe {
                    available: true,
                    path: Some(path_id(s.tracer.path())),
                    adapter: Some(s.tracer.adapter().to_string()),
                    denoise: true,
                    denoiser: Some(denoise::active()),
                    reason: None,
                    class: None,
                    storage_buffers: None,
                }
            }
            Err(e) => Probe::refused(e, REFUSED.lock().unwrap_or_else(|p| p.into_inner()).as_ref()),
        };
        if !was_open {
            TRACER.release();
        }
        probe
    })
    .await
    .unwrap_or_else(|e| Probe::refused(e.to_string(), None))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(t: &TracerSource) -> u32 {
        let mut out = vec![0; 32 * 24 * 4];
        t.render(&mut out, 32, 24, 0);
        with(|t| t.samples()).unwrap()
    }

    #[test]
    fn a_cancelled_picture_leaves_the_viewport_tracing_and_the_next_one_saves() {
        let Ok(t) = tracer() else {
            eprintln!("skipped: no native tracer");
            return;
        };
        with(|t| t.set_cap(4096)).unwrap();
        let before = frame(&t);
        let run = std::thread::spawn(|| picture(1024, 1024, 1_000_000));
        while pt_status().unwrap().picture.is_none() {
            assert!(!run.is_finished(), "{:?}", run.join().unwrap());
            std::thread::yield_now();
        }
        assert_eq!(frame(&t), before, "the viewport traced while the picture held the tracer");
        pt_picture_cancel().unwrap();
        assert_eq!(run.join().unwrap(), Err(PICTURE_CANCELLED.to_string()));
        assert!(pt_status().unwrap().picture.is_none());
        assert!(frame(&t) > before, "the viewport stopped tracing after a cancelled picture");

        let png = picture(64, 48, 4).expect("the picture after a cancel failed");
        assert_eq!(&png[1..4], b"PNG");
        assert!(frame(&t) > before);
        assert_eq!(pt_status().unwrap().fault, None);
        drop(t);
        release();
    }
}
