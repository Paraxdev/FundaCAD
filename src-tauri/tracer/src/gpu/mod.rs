mod accel;
mod adapter;
mod bindings;
mod envmap;
mod frame;
mod picture;
mod pipelines;
mod upload;

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use crate::bloom::{Bloom, Chain};
use crate::denoise::{self, Denoiser, Quality};
use crate::scene::{BodyDesc, Commit, Mesh, Scene};

use accel::{make_tlas, GpuAccel};
pub use adapter::{adapter_label, choose, Candidate, Refusal};
use envmap::EnvMap;
pub use picture::{encode_png, picture_refusal, Picture};
pub(crate) use pipelines::pipeline_at;
use pipelines::Pipelines;
use upload::Shading;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Path {
    RayQuery,
    Software,
}

#[derive(Debug, Clone, Copy)]
pub struct TracerOptions {
    pub backends: wgpu::Backends,
    /// Never take ray queries even when the adapter has them.
    pub software: bool,
}

impl Default for TracerOptions {
    /// No GL: on Windows its WGL thread exits inside the NVIDIA driver under the
    /// loader lock and deadlocks a vkCreateDevice running on another thread.
    fn default() -> Self {
        TracerOptions {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::DX12 | wgpu::Backends::METAL,
            software: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Camera {
    pub eye: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    /// Vertical field of view in degrees, unused with `ortho`.
    pub fov: f32,
    #[serde(default)]
    pub ortho: Option<Ortho>,
    /// Ignored with `ortho`.
    #[serde(default)]
    pub lens: Option<Lens>,
}

impl Default for Camera {
    fn default() -> Self {
        Camera { eye: [4.0, -6.0, 3.0], target: [0.0; 3], up: [0.0, 0.0, 1.0], fov: 50.0, ortho: None, lens: None }
    }
}

/// Parallel rays, `half_height` world units from the view centre to the top.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ortho {
    pub half_height: f32,
}

/// A thin lens: sharp at `focus_distance` along the view direction, rays from
/// a disc of `aperture_radius`, both world units.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lens {
    pub focus_distance: f32,
    pub aperture_radius: f32,
}

/// A light at infinity, a disc of `angular_radius` degrees around `direction`.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LightDesc {
    /// Towards the light.
    pub direction: [f32; 3],
    /// Linear, the irradiance it gives a surface facing it.
    pub color: [f32; 3],
    /// Degrees, 0 for a delta light.
    pub angular_radius: f32,
}

pub const MAX_LIGHTS: usize = 4;

/// Windows resets a GPU that runs one dispatch past about 2 s, so a band that
/// has not finished by this is stuck behind another process or a lost device.
pub const WAIT_LIMIT: Duration = Duration::from_secs(10);

/// Up to MAX_LIGHTS lights, held inline so a Look stays Copy. A longer list
/// keeps its strongest; a dark light or one with no direction is left out,
/// since a light sample picks by power.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Lights {
    len: usize,
    list: [LightDesc; MAX_LIGHTS],
}

impl Lights {
    pub fn new(lights: &[LightDesc]) -> Lights {
        let lit = |l: &&LightDesc| crate::bloom::luma(l.color) > 0.0 && l.direction.iter().any(|x| *x != 0.0);
        let mut v: Vec<LightDesc> = lights.iter().filter(lit).copied().collect();
        v.sort_by(|a, b| crate::bloom::luma(b.color).total_cmp(&crate::bloom::luma(a.color)));
        let mut out = Lights::default();
        for l in v.into_iter().take(MAX_LIGHTS) {
            out.list[out.len] = l;
            out.len += 1;
        }
        out
    }

    pub fn as_slice(&self) -> &[LightDesc] {
        &self.list[..self.len]
    }
}

impl<'de> serde::Deserialize<'de> for Lights {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Lights::new(&Vec::<LightDesc>::deserialize(d)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Look {
    pub sky_top: [f32; 3],
    pub sky_bottom: [f32; 3],
    pub env_intensity: f32,
    /// Towards the light; a zero vector turns the sun off. A delta light,
    /// used only when `lights` is absent.
    pub sun_dir: [f32; 3],
    pub sun_color: [f32; 3],
    pub exposure: f32,
    pub bounces: u32,
    pub lights: Option<Lights>,
    /// What camera rays that miss show, linear. Absent, they show the sky.
    pub background: Option<[f32; 3]>,
    /// Camera misses show the environment map over the background.
    pub environment_behind: bool,
    pub ground: Option<Ground>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroundMode {
    /// Camera rays show the background darkened by the light the scene
    /// blocks from the plane; bounce and shadow rays pass through it.
    Shadow,
    /// Also any mode a later page sends.
    #[default]
    #[serde(other)]
    None,
}

/// The rig's ground: a square of side `extent` around `centre` at height `z`,
/// seen from above only.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ground {
    pub mode: GroundMode,
    pub z: f32,
    pub centre: [f32; 2],
    pub extent: f32,
    /// Sent for a lit ground, unused by the shadow mode.
    pub albedo: f32,
}

impl Look {
    /// The lights traced: `lights`, or else the sun as one delta light.
    pub fn light_list(&self) -> Lights {
        if let Some(l) = self.lights {
            return l;
        }
        let on = self.sun_dir.iter().any(|x| *x != 0.0) && self.sun_color.iter().any(|x| *x > 0.0);
        let sun = [LightDesc { direction: self.sun_dir, color: self.sun_color, angular_radius: 0.0 }];
        Lights::new(if on { &sun } else { &[] })
    }
}

/// How the light at a surface is estimated. Tests compare them; the app
/// always traces with Mis and its firefly clamp.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Estimator {
    #[default]
    Default,
    /// Light samples only, bounce rays never see a light.
    Nee,
    /// Bounce rays only, no light samples.
    Bsdf,
    /// Both, weighted by the power heuristic, without the clamp.
    Mis,
}

impl Default for Look {
    fn default() -> Self {
        Look {
            sky_top: [0.5, 0.7, 1.0],
            sky_bottom: [1.0, 1.0, 1.0],
            env_intensity: 1.0,
            sun_dir: [0.0; 3],
            sun_color: [0.0; 3],
            exposure: 1.0,
            bounces: 6,
            lights: None,
            background: None,
            environment_behind: false,
            ground: None,
        }
    }
}

pub(crate) fn bytes<T: Copy>(v: &[T]) -> &[u8] {
    // Only ever f32, u32 and arrays of them, which have no padding.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

fn buffer(device: &wgpu::Device, queue: &wgpu::Queue, data: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    let b = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (data.len() as u64).max(16).next_multiple_of(16),
        usage,
        mapped_at_creation: false,
    });
    queue.write_buffer(&b, 0, data);
    b
}

pub(crate) fn storage(device: &wgpu::Device, size: u64, extra: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: size.max(16),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | extra,
        mapped_at_creation: false,
    })
}

pub struct Tracer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    path: Path,
    adapter: String,
    scene: Scene<GpuAccel>,
    pipes: Pipelines,
    uniform: wgpu::Buffer,
    resolve_uniform: wgpu::Buffer,
    accum: wgpu::Buffer,
    aov: wgpu::Buffer,
    out: wgpu::Buffer,
    shading: Shading,
    insts: wgpu::Buffer,
    mats: wgpu::Buffer,
    env: EnvMap,
    emitters: upload::Emitters,
    /// World box of the visible bodies, min and max.
    bounds: Option<[[f32; 3]; 2]>,
    instance_uploads: u64,
    n_inst: u32,
    bind: Option<wgpu::BindGroup>,
    resolve_bind: Option<wgpu::BindGroup>,
    glow_uniform: wgpu::Buffer,
    chain: Option<Chain>,
    bloom: Option<Bloom>,
    /// The denoised colour over the exposure, as accum's layout, for a bloom.
    hdr: wgpu::Buffer,
    w: u32,
    h: u32,
    sample: u32,
    row0: u32,
    rows: u32,
    cap: u32,
    camera: Camera,
    look: Look,
    estimator: Estimator,
    held: Option<Held>,
    quality: Quality,
    job: Option<Job>,
    denoise_error: Option<String>,
    fault: Arc<Mutex<Fault>>,
    buffer_limit: u64,
    stalled: bool,
}

/// The first loss and the first uncaptured error. Not behind the frames
/// State lock: wgpu runs both handlers inside the call that hit them, which
/// already holds that lock.
#[derive(Default)]
struct Fault {
    lost: Option<String>,
    error: Option<String>,
}

/// The last frame handed out, shown again while nothing can change it.
struct Held {
    key: FrameKey,
    pixels: Vec<u8>,
    denoised: bool,
    /// What `pixels` were resolved with.
    bloom: Option<Bloom>,
    denoise: Option<Denoised>,
}

/// The denoise result tone mapped as it is, and in linear for a bloom.
struct Denoised {
    plain: Vec<u8>,
    hdr: Vec<[f32; 4]>,
    by: Denoiser,
    /// Why Open Image Denoise gave way to the filter.
    note: Option<String>,
}

/// Generation, samples and size: what a frame was traced for.
type FrameKey = (u64, u32, (u32, u32));

/// A denoise running on its own thread; a result for an older key is dropped.
struct Job {
    key: FrameKey,
    rx: mpsc::Receiver<Result<Denoised, String>>,
}

impl Tracer {
    pub fn new(opts: TracerOptions) -> Result<Tracer, Refusal> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = opts.backends;
        let instance = wgpu::Instance::new(desc);
        let mut adapters = futures_executor::block_on(instance.enumerate_adapters(opts.backends));
        let allow_cpu = std::env::var_os("FUNDACAD_TRACER_ALLOW_CPU").is_some();
        let found: Vec<Candidate> = adapters.iter().map(Candidate::of).collect();
        let adapter = adapters.swap_remove(choose(&found, allow_cpu)?);
        let hw = !opts.software && adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
        let info = adapter.get_info();
        // Default limits leave every acceleration structure limit at 0 and
        // allow 8 storage buffers where the software path binds 11, so the
        // device takes the adapter's own.
        let (device, queue) = futures_executor::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("fundacad-tracer"),
            required_features: if hw { wgpu::Features::EXPERIMENTAL_RAY_QUERY } else { wgpu::Features::empty() },
            required_limits: adapter.limits(),
            experimental_features: if hw {
                unsafe { wgpu::ExperimentalFeatures::enabled() }
            } else {
                wgpu::ExperimentalFeatures::disabled()
            },
            ..Default::default()
        }))
        .map_err(|e| Refusal::Device(e.to_string()))?;
        let path = if hw { Path::RayQuery } else { Path::Software };
        let limits = device.limits();
        let buffer_limit = limits.max_buffer_size.min(limits.max_storage_buffer_binding_size as u64);
        let fault = Arc::new(Mutex::new(Fault::default()));
        let f = fault.clone();
        device.set_device_lost_callback(move |reason, msg| {
            let mut f = f.lock().unwrap_or_else(|p| p.into_inner());
            f.lost.get_or_insert_with(|| format!("the graphics device was lost ({reason:?}: {msg})"));
        });
        let f = fault.clone();
        device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
            let mut f = f.lock().unwrap_or_else(|p| p.into_inner());
            f.error.get_or_insert_with(|| e.to_string());
        }));

        let pipes = Pipelines::new(&device, path);

        let glow_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: frame::UNIFORM_SIZE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let resolve_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        // Room for one element of the largest bound struct (Inst, 160 bytes):
        // frames run before the first scene lands.
        let empty = |d: &wgpu::Device| storage(d, 256, wgpu::BufferUsages::empty());
        let shading = Shading {
            pos: empty(&device),
            nrm: empty(&device),
            idx: empty(&device),
            slots: empty(&device),
            cols: empty(&device),
            nodes: empty(&device),
            order: empty(&device),
            offsets: HashMap::new(),
        };
        let mut accel = GpuAccel { device: device.clone(), queue: queue.clone(), hw, tlas: None };
        if hw {
            accel.tlas = Some(make_tlas(&device, &queue, &[]));
        }
        let env = EnvMap::new(&device, &queue, None);
        let mut t = Tracer {
            env,
            insts: empty(&device),
            mats: empty(&device),
            accum: empty(&device),
            aov: empty(&device),
            out: empty(&device),
            hdr: empty(&device),
            device,
            queue,
            path,
            adapter: adapter_label(&info.name, info.backend, info.device_type),
            scene: Scene::new(accel),
            pipes,
            uniform,
            resolve_uniform,
            shading,
            emitters: Default::default(),
            bounds: None,
            instance_uploads: 0,
            n_inst: 0,
            bind: None,
            resolve_bind: None,
            glow_uniform,
            chain: None,
            bloom: None,
            w: 0,
            h: 0,
            sample: 0,
            row0: 0,
            rows: 0,
            cap: 256,
            camera: Camera::default(),
            look: Look::default(),
            estimator: Estimator::Default,
            held: None,
            quality: Quality::default(),
            job: None,
            denoise_error: None,
            fault,
            buffer_limit,
            stalled: false,
        };
        t.resize(64, 64);
        Ok(t)
    }

    pub fn path(&self) -> Path {
        self.path
    }
    /// Why the GPU stopped: a lost device, else the first error wgpu raised.
    /// Once set, frames are black and no GPU work follows.
    pub fn fault(&self) -> Option<String> {
        let f = self.fault.lock().unwrap_or_else(|p| p.into_inner());
        f.lost.clone().or_else(|| f.error.clone())
    }
    /// How many times the instance rows and the emitter table were uploaded.
    #[doc(hidden)]
    pub fn instance_uploads(&self) -> u64 {
        self.instance_uploads
    }

    /// Fakes a GPU that never finishes: every later wait times out without asking it.
    #[doc(hidden)]
    pub fn stall_gpu_for_test(&mut self) {
        self.stalled = true;
    }

    #[doc(hidden)]
    pub fn lose_device_for_test(&self) {
        self.device.destroy();
    }
    pub fn adapter(&self) -> &str {
        &self.adapter
    }
    pub fn samples(&self) -> u32 {
        self.sample
    }
    pub fn generation(&self) -> u64 {
        self.scene.generation()
    }
    /// The sample cap is reached; the picture will not change until the scene,
    /// camera, look or cap does.
    pub fn done(&self) -> bool {
        self.sample >= self.cap
    }
    pub fn size(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        let (w, h) = (w.max(1), h.max(1));
        if (w, h) == (self.w, self.h) {
            return;
        }
        (self.w, self.h) = (w, h);
        let px = w as u64 * h as u64;
        self.accum = storage(&self.device, px * 16, wgpu::BufferUsages::COPY_SRC);
        self.aov = storage(&self.device, px * 32, wgpu::BufferUsages::COPY_SRC);
        self.out = storage(&self.device, px * 4, wgpu::BufferUsages::COPY_SRC);
        self.hdr = storage(&self.device, px * 16, wgpu::BufferUsages::empty());
        if self.rows == 0 {
            self.rows = h;
        }
        self.resolve_bind = None;
        self.reset();
    }

    /// The first dispatch traces about this many paths, so one dispatch never
    /// holds the GPU long enough to stall the UI or trip the driver's timeout.
    /// Only the band size changes, the accumulation and the held frame stay.
    pub fn set_frame_budget(&mut self, paths: u32) {
        self.rows = (paths / self.w).clamp(8, self.h.next_multiple_of(8)).next_multiple_of(8);
    }

    pub fn set_cap(&mut self, cap: u32) {
        self.cap = cap.max(1);
    }

    pub fn set_camera(&mut self, c: Camera) {
        if c != self.camera {
            self.camera = c;
            self.reset();
        }
    }

    pub fn set_look(&mut self, l: Look) {
        if l != self.look {
            self.look = l;
            self.reset();
        }
    }

    #[doc(hidden)]
    pub fn set_estimator(&mut self, e: Estimator) {
        if e != self.estimator {
            self.estimator = e;
            self.reset();
        }
    }

    pub fn set_bodies(&mut self, bodies: Vec<BodyDesc>) -> Vec<String> {
        self.scene.set_bodies(bodies)
    }

    pub fn add_mesh(&mut self, key: &str, mesh: Mesh) {
        self.scene.add_mesh(key, mesh);
    }

    pub fn set_colors(&mut self, key: &str, colors: Option<Vec<[f32; 3]>>) -> bool {
        self.scene.set_colors(key, colors)
    }

    /// Builds what the changes since the last apply need and restarts the
    /// accumulation when anything changed.
    pub fn apply(&mut self) -> Commit {
        let c = self.scene.commit();
        if c.geometry || c.blas_built > 0 {
            self.upload_geometry();
        }
        if c.instances || c.geometry || c.blas_built > 0 || c.tlas_built {
            self.upload_instances();
        }
        if c.reset {
            self.reset();
        }
        c
    }

    fn reset(&mut self) {
        self.sample = 0;
        self.row0 = 0;
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.clear_buffer(&self.accum, 0, None);
        self.queue.submit([enc.finish()]);
        self.bind = None;
    }

    /// Bloom on the linear frame before tone mapping. Never restarts the
    /// samples: the held frame is resolved again on the next frame.
    pub fn set_bloom(&mut self, b: Option<Bloom>) {
        self.bloom = b;
    }

    /// Brings the held frame to the current bloom, from the accumulation or
    /// the denoised colour, only when the bloom changed since it was resolved.
    fn rebloom_held(&mut self) {
        let Some(h) = self.held.take() else { return };
        let mut h = h;
        if h.bloom != self.bloom {
            h.pixels = match (&h.denoise, self.bloom) {
                (Some(d), None) => d.plain.clone(),
                (Some(d), Some(_)) => {
                    self.queue.write_buffer(&self.hdr, 0, bytes(&d.hdr));
                    self.resolve_from(true)
                }
                (None, _) => self.resolve(),
            };
            h.bloom = self.bloom;
        }
        self.held = Some(h);
    }

    /// The weights the cap is denoised with; a change drops a held result and
    /// denoises again, keeping the samples.
    pub fn set_denoise(&mut self, q: Quality) {
        if q == self.quality {
            return;
        }
        self.quality = q;
        self.job = None;
        // Even a raw held frame goes: its denoise was just dropped, and the next frame at the cap starts a new one.
        self.held = None;
    }

    /// The frame handed out is the denoised one for the current scene.
    pub fn denoised(&self) -> bool {
        self.done() && self.held.as_ref().is_some_and(|h| h.denoised && h.key == self.key())
    }

    /// What cleaned the held frame at the cap.
    pub fn denoised_by(&self) -> Option<Denoiser> {
        self.held.as_ref().filter(|h| h.denoised && h.key == self.key()).and_then(|h| h.denoise.as_ref()).map(|d| d.by)
    }

    /// Why the last denoise gave no frame, or fell back to the filter.
    pub fn denoise_error(&self) -> Option<&str> {
        self.denoise_error.as_deref()
    }

    fn denoise_input(&self) -> denoise::Input {
        let aov = self.read_aovs();
        denoise::Input {
            width: self.w as usize,
            height: self.h as usize,
            color: self.read_hdr().into_iter().flatten().collect(),
            albedo: aov.iter().step_by(2).flat_map(|a| [a[0], a[1], a[2]]).collect(),
            normal: aov.iter().skip(1).step_by(2).flat_map(|n| [n[0], n[1], n[2]]).collect(),
            depth: aov.chunks_exact(2).map(|p| if p[1][3] > 0.0 { p[0][3] } else { 0.0 }).collect(),
            samples: self.sample,
        }
    }

    fn start_denoise(&mut self) {
        if self.quality == Quality::Off {
            return;
        }
        let input = self.denoise_input();
        let (tx, rx) = mpsc::channel();
        let quality = self.quality;
        let e = if self.look.exposure > 0.0 { self.look.exposure } else { 1.0 };
        let spawned = std::thread::Builder::new().name("denoise".into()).spawn(move || {
            let (c, by, note) = denoise::run(&input, quality);
            let rgb: Vec<[f32; 3]> = c.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
            let d = Denoised {
                plain: denoise::tone_map(&rgb),
                hdr: rgb.iter().map(|p| [p[0] / e, p[1] / e, p[2] / e, 1.0]).collect(),
                by,
                note,
            };
            let _ = tx.send(Ok(d));
        });
        match spawned {
            Ok(_) => self.job = Some(Job { key: self.key(), rx }),
            Err(e) => self.denoise_error = Some(e.to_string()),
        }
    }

    /// Takes a finished denoise into the held frame without tracing, for a
    /// page that stopped asking for frames at the cap.
    pub fn poll_denoise(&mut self) {
        if self.done() && self.held.as_ref().is_some_and(|h| h.key == self.key()) {
            self.collect_denoise();
            self.rebloom_held();
        }
    }

    pub fn denoising(&self) -> bool {
        self.job.as_ref().is_some_and(|j| j.key == self.key())
    }

    fn collect_denoise(&mut self) {
        let Some(job) = &self.job else { return };
        if job.key != self.key() {
            self.job = None;
            return;
        }
        let got = match job.rx.try_recv() {
            Err(mpsc::TryRecvError::Empty) => return,
            Err(mpsc::TryRecvError::Disconnected) => Err("the denoise thread ended".to_string()),
            Ok(r) => r,
        };
        self.job = None;
        match got {
            Ok(d) if d.plain.len() == (self.w * self.h * 4) as usize => {
                self.denoise_error = d.note.clone();
                if let Some(h) = &mut self.held {
                    h.pixels = d.plain.clone();
                    h.bloom = None;
                    h.denoise = Some(d);
                    h.denoised = true;
                }
            }
            Ok(d) => {
                self.denoise_error = Some(format!("a {} byte denoise for a {}x{} frame", d.plain.len(), self.w, self.h))
            }
            Err(e) => self.denoise_error = Some(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_poll_that_times_out_names_the_limit() {
        let e = super::frame::settle(Err(wgpu::PollError::Timeout), WAIT_LIMIT).unwrap_err();
        assert!(e.contains("did not finish a frame within 10 s"), "{e}");
        assert!(super::frame::settle(Ok(wgpu::PollStatus::QueueEmpty), WAIT_LIMIT).is_ok());
    }

    #[test]
    fn a_denoised_frame_blooms_as_the_accumulation_it_came_from() {
        let Ok(mut t) = Tracer::new(TracerOptions { software: true, ..Default::default() }) else {
            eprintln!("skipped: no adapter");
            return;
        };
        let lamp: Vec<BodyDesc> = serde_json::from_str(
            r#"[{"id":"body1","key":"lamp","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                 "materials":[{"color":[0,0,0],"emissive":[1,0.6,0.2],"emissiveIntensity":5}]}]"#,
        )
        .unwrap();
        t.set_bodies(lamp);
        t.add_mesh(
            "lamp",
            Mesh {
                positions: vec![[-1.0, -1.0, 0.0], [1.0, -1.0, 0.0], [1.0, 1.0, 0.0], [-1.0, 1.0, 0.0]],
                normals: vec![[0.0, 0.0, 1.0]; 4],
                indices: vec![0, 1, 2, 0, 2, 3],
                ..Default::default()
            },
        );
        t.set_camera(Camera {
            eye: [0.0, 0.0, 12.0],
            target: [0.0; 3],
            up: [0.0, 1.0, 0.0],
            fov: 50.0,
            ..Default::default()
        });
        t.set_look(Look { exposure: 1.7, sky_top: [0.1; 3], sky_bottom: [0.05; 3], ..Look::default() });
        t.set_denoise(Quality::Off);
        t.set_cap(1);
        let plain = t.frame(48, 32, Duration::from_millis(50));
        assert!(t.done());
        // A denoise that changed nothing: its colour is the exposed accumulation.
        let e = t.look.exposure;
        let hdr = t.read_hdr().iter().map(|c| [c[0] / e, c[1] / e, c[2] / e, 1.0]).collect();
        let h = t.held.as_mut().unwrap();
        h.denoise = Some(Denoised { plain: plain.clone(), hdr, by: Denoiser::Filter, note: None });
        h.denoised = true;
        let b = Bloom { strength: 0.8, radius: 0.5, threshold: 0.8, side: 0 };
        t.set_bloom(Some(b));
        let from_hdr = t.frame(48, 32, Duration::ZERO);
        let from_accum = t.resolve();
        assert_ne!(from_hdr, plain);
        let worst = from_hdr.iter().zip(&from_accum).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
        assert!(worst <= 1, "the denoised bloom is {worst} codes off the accumulation's");
        t.set_bloom(None);
        assert_eq!(t.frame(48, 32, Duration::ZERO), plain);
    }
}
