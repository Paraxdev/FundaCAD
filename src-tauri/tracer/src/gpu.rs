use std::collections::HashMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::bloom::{self, Bloom, Chain};
use crate::bvh::{self, Bvh};
use crate::denoise::{self, Denoiser, Quality};
use crate::material::{pack_material, tri_slots, GpuMaterial, FLAG_VERTEX_COLORS};
use crate::scene::{Accel, BodyDesc, Commit, Instance, Mesh, Scene};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    fn default() -> Self {
        TracerOptions {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::DX12 | wgpu::Backends::METAL | wgpu::Backends::GL,
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
    /// Vertical field of view in degrees.
    pub fov: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Look {
    pub sky_top: [f32; 3],
    pub sky_bottom: [f32; 3],
    pub env_intensity: f32,
    /// Towards the light; a zero vector turns the sun off.
    pub sun_dir: [f32; 3],
    pub sun_color: [f32; 3],
    pub exposure: f32,
    pub bounces: u32,
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
        }
    }
}

pub enum GpuBlas {
    Hw(wgpu::Blas),
    Sw(Bvh),
}

pub struct GpuAccel {
    device: wgpu::Device,
    queue: wgpu::Queue,
    hw: bool,
    tlas: Option<wgpu::Tlas>,
}

impl Accel for GpuAccel {
    type Blas = GpuBlas;

    fn build_blas(&mut self, mesh: &Mesh) -> GpuBlas {
        if !self.hw {
            return GpuBlas::Sw(bvh::build(&mesh.positions, &mesh.indices));
        }
        let verts: Vec<f32> = mesh.positions.iter().flat_map(|p| [p[0], p[1], p[2], 0.0]).collect();
        let usage = wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::COPY_DST;
        let vb = buffer(&self.device, &self.queue, bytes(&verts), usage);
        let ib = buffer(&self.device, &self.queue, bytes(&mesh.indices), usage);
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: mesh.positions.len() as u32,
            index_format: Some(wgpu::IndexFormat::Uint32),
            index_count: Some(mesh.indices.len() as u32),
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = self.device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("tracer-blas"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: vec![size.clone()] },
        );
        let entry = wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &size,
                vertex_buffer: &vb,
                first_vertex: 0,
                vertex_stride: 16,
                index_buffer: Some(&ib),
                first_index: Some(0),
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
        };
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.build_acceleration_structures(std::iter::once(&entry), std::iter::empty());
        self.queue.submit([enc.finish()]);
        GpuBlas::Hw(blas)
    }

    fn build_tlas(&mut self, instances: &[Instance<'_, GpuBlas>]) {
        if self.hw {
            self.tlas = Some(make_tlas(&self.device, &self.queue, instances));
        }
    }
}

fn make_tlas(device: &wgpu::Device, queue: &wgpu::Queue, instances: &[Instance<'_, GpuBlas>]) -> wgpu::Tlas {
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("tracer-tlas"),
        max_instances: instances.len().max(1) as u32,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    for (i, inst) in instances.iter().enumerate() {
        if let GpuBlas::Hw(b) = inst.blas {
            tlas[i] = Some(wgpu::TlasInstance::new(b, inst.xf, i as u32, 0xff));
        }
    }
    let mut enc = device.create_command_encoder(&Default::default());
    enc.build_acceleration_structures(std::iter::empty(), std::iter::once(&tlas));
    queue.submit([enc.finish()]);
    tlas
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

/// Row major 3x4 affine inverse.
fn inverse(m: &[f32; 12]) -> [f32; 12] {
    let (a, b, c) = (m[0], m[1], m[2]);
    let (d, e, f) = (m[4], m[5], m[6]);
    let (g, h, i) = (m[8], m[9], m[10]);
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    let k = if det.abs() > 1e-30 { 1.0 / det } else { 0.0 };
    let r = [
        (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
        (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
        (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k,
    ];
    let t = [m[3], m[7], m[11]];
    let mut out = [0.0; 12];
    for row in 0..3 {
        out[row * 4] = r[row * 3];
        out[row * 4 + 1] = r[row * 3 + 1];
        out[row * 4 + 2] = r[row * 3 + 2];
        out[row * 4 + 3] = -(r[row * 3] * t[0] + r[row * 3 + 1] * t[1] + r[row * 3 + 2] * t[2]);
    }
    out
}

struct Shading {
    pos: wgpu::Buffer,
    nrm: wgpu::Buffer,
    idx: wgpu::Buffer,
    slots: wgpu::Buffer,
    cols: wgpu::Buffer,
    nodes: wgpu::Buffer,
    order: wgpu::Buffer,
    /// vertex base, index base, triangle base, node base per mesh key
    offsets: HashMap<String, [u32; 4]>,
}

/// What one software dispatch aims for, short enough that the compositor and
/// the WebGPU viewport keep their frames, long enough to amortise a submit.
pub const BAND_TARGET: Duration = Duration::from_millis(10);

/// The next band after one of `rows` took `took`: scaled towards `target`,
/// at most doubling per step so one fast band over the sky cannot jump to a
/// full frame over the model, in multiples of the workgroup's 8 rows. Never
/// under MIN_BAND_PATHS: on a GPU shared with another app a band's time is
/// mostly waiting for its turn, and smaller bands only add submits.
pub fn adapt_rows(rows: u32, width: u32, height: u32, took: Duration, target: Duration) -> u32 {
    let ratio = (target.as_secs_f64() / took.as_secs_f64().max(1e-6)).clamp(0.25, 2.0);
    let want = (rows as f64 * ratio).round() as u32;
    let top = height.next_multiple_of(8).max(8);
    let floor = (MIN_BAND_PATHS / width.max(1)).clamp(8, top);
    want.clamp(floor, top).next_multiple_of(8)
}

pub const MIN_BAND_PATHS: u32 = 65_536;

pub struct Tracer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    path: Path,
    adapter: String,
    scene: Scene<GpuAccel>,
    trace_pipe: wgpu::ComputePipeline,
    trace_bgl: wgpu::BindGroupLayout,
    resolve_pipe: wgpu::ComputePipeline,
    resolve_bgl: wgpu::BindGroupLayout,
    uniform: wgpu::Buffer,
    resolve_uniform: wgpu::Buffer,
    accum: wgpu::Buffer,
    aov: wgpu::Buffer,
    out: wgpu::Buffer,
    shading: Shading,
    insts: wgpu::Buffer,
    mats: wgpu::Buffer,
    n_inst: u32,
    bind: Option<wgpu::BindGroup>,
    resolve_bind: Option<wgpu::BindGroup>,
    glow_pipe: wgpu::ComputePipeline,
    glow_bgl: wgpu::BindGroupLayout,
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
    held: Option<Held>,
    quality: Quality,
    job: Option<Job>,
    denoise_error: Option<String>,
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
    pub fn new(opts: TracerOptions) -> Result<Tracer, String> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = opts.backends;
        let instance = wgpu::Instance::new(desc);
        let adapters = futures_executor::block_on(instance.enumerate_adapters(opts.backends));
        let rank = |b: wgpu::Backend| match b {
            wgpu::Backend::Vulkan => 0u8,
            wgpu::Backend::Dx12 => 1,
            wgpu::Backend::Metal => 2,
            _ => 3,
        };
        let adapter = adapters
            .into_iter()
            .min_by_key(|a| {
                let i = a.get_info();
                (rank(i.backend), u8::from(i.device_type != wgpu::DeviceType::DiscreteGpu))
            })
            .ok_or("no adapter")?;
        if adapter.limits().max_storage_buffers_per_shader_stage < 12 {
            return Err(format!("{} binds too few storage buffers", adapter.get_info().name));
        }
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
        .map_err(|e| e.to_string())?;
        let path = if hw { Path::RayQuery } else { Path::Software };

        let ro = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let rw = |binding| wgpu::BindGroupLayoutEntry {
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: false },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            ..ro(binding)
        };
        let uni = wgpu::BindGroupLayoutEntry {
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            ..ro(0)
        };
        let mut entries = vec![uni, rw(1), rw(2), ro(3), ro(4), ro(5), ro(6), ro(7), ro(8), ro(9)];
        if hw {
            entries.push(wgpu::BindGroupLayoutEntry {
                ty: wgpu::BindingType::AccelerationStructure { vertex_return: false },
                ..ro(10)
            });
        } else {
            entries.extend([ro(10), ro(11)]);
        }
        let trace_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &entries });
        let src = format!(
            "{}\n{}",
            if hw { include_str!("rq.wgsl") } else { include_str!("sw.wgsl") },
            include_str!("trace.wgsl")
        );
        let trace_pipe = pipeline(&device, &trace_bgl, &src, "tracer-trace");
        let resolve_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[uni, ro(1), rw(2)],
        });
        let resolve_pipe = pipeline(&device, &resolve_bgl, include_str!("resolve.wgsl"), "tracer-resolve");
        let glow_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[uni, ro(1), rw(2), ro(3), wgpu::BindGroupLayoutEntry { binding: 4, ..uni }],
        });
        let glow_src = format!("{}
{}", include_str!("resolve.wgsl"), include_str!("resolve_bloom.wgsl"));
        let glow_pipe = pipeline_at(&device, &glow_bgl, &glow_src, "tracer-resolve-bloom", "main_bloom");
        let glow_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 176,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let resolve_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        // Room for one element of the largest bound struct (Inst, 128 bytes):
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
        let mut t = Tracer {
            insts: empty(&device),
            mats: empty(&device),
            accum: empty(&device),
            aov: empty(&device),
            out: empty(&device),
            hdr: empty(&device),
            device,
            queue,
            path,
            adapter: format!("{} ({:?})", info.name, info.backend),
            scene: Scene::new(accel),
            trace_pipe,
            trace_bgl,
            resolve_pipe,
            resolve_bgl,
            uniform,
            resolve_uniform,
            shading,
            n_inst: 0,
            bind: None,
            resolve_bind: None,
            glow_pipe,
            glow_bgl,
            glow_uniform,
            chain: None,
            bloom: None,
            w: 0,
            h: 0,
            sample: 0,
            row0: 0,
            rows: 0,
            cap: 256,
            camera: Camera { eye: [4.0, -6.0, 3.0], target: [0.0; 3], up: [0.0, 0.0, 1.0], fov: 50.0 },
            look: Look::default(),
            held: None,
            quality: Quality::default(),
            job: None,
            denoise_error: None,
        };
        t.resize(64, 64);
        Ok(t)
    }

    pub fn path(&self) -> Path {
        self.path
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
        if self.path == Path::RayQuery || self.rows == 0 {
            self.rows = h;
        }
        self.resolve_bind = None;
        self.reset();
    }

    /// The software path traces about this many paths per dispatch, so one
    /// dispatch never holds the GPU long enough to stall the UI.
    pub fn set_frame_budget(&mut self, paths: u32) {
        if self.path == Path::Software {
            self.rows = (paths / self.w).clamp(8, self.h.next_multiple_of(8)).next_multiple_of(8);
            self.reset();
        }
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

    fn upload_geometry(&mut self) {
        let (mut pos, mut nrm, mut idx, mut slots, mut cols, mut nodes, mut order) =
            (vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
        let mut offsets = HashMap::new();
        for (key, m, blas) in self.scene.meshes() {
            let vb = (pos.len() / 4) as u32;
            let ib = idx.len() as u32;
            let tb = slots.len() as u32;
            let nb = (nodes.len() / 2) as u32;
            offsets.insert(key.to_string(), [vb, ib, tb, nb]);
            pos.extend(m.positions.iter().flat_map(|p| [p[0], p[1], p[2], 0.0f32]));
            for i in 0..m.positions.len() {
                let n = m.normals.get(i).copied().unwrap_or([0.0; 3]);
                nrm.extend([n[0], n[1], n[2], 0.0f32]);
            }
            idx.extend_from_slice(&m.indices);
            slots.extend(tri_slots(&m.groups, m.tri_count()));
            match &m.colors {
                Some(c) if c.len() == m.positions.len() => cols.extend(c.iter().map(|c| {
                    let q = |x: f32| (x.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
                    q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (255 << 24)
                })),
                _ => cols.extend(std::iter::repeat_n(u32::MAX, m.positions.len())),
            }
            if let Some(GpuBlas::Sw(t)) = blas {
                for pair in t.nodes.chunks(2) {
                    let (mut a, b) = (pair[0], pair[1]);
                    let first = a[3].to_bits();
                    let leaf = b[3].to_bits() != 0;
                    a[3] = f32::from_bits(if leaf { first + order.len() as u32 } else { first + nb });
                    nodes.push(a);
                    nodes.push(b);
                }
                order.extend_from_slice(&t.order);
            }
        }
        let d = &self.device;
        let q = &self.queue;
        let u = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
        self.shading = Shading {
            pos: buffer(d, q, bytes(&pos), u),
            nrm: buffer(d, q, bytes(&nrm), u),
            idx: buffer(d, q, bytes(&idx), u),
            slots: buffer(d, q, bytes(&slots), u),
            cols: buffer(d, q, bytes(&cols), u),
            nodes: buffer(d, q, bytes(&nodes), u),
            order: buffer(d, q, bytes(&order), u),
            offsets,
        };
        self.bind = None;
    }

    fn upload_instances(&mut self) {
        let mut rows: Vec<f32> = vec![];
        let mut mats: Vec<GpuMaterial> = vec![];
        let insts = self.scene.instances();
        for inst in &insts {
            let off = self.shading.offsets.get(&inst.body.key).copied().unwrap_or_default();
            rows.extend_from_slice(&inst.xf);
            rows.extend_from_slice(&inverse(&inst.xf));
            let base = mats.len() as u32;
            let mut body: Vec<GpuMaterial> = inst.body.materials.iter().map(pack_material).collect();
            if body.is_empty() {
                body.push(pack_material(&Default::default()));
            }
            let colors = body.iter().any(|m| m.flags() & FLAG_VERTEX_COLORS != 0) as u32;
            let n = body.len() as u32;
            mats.extend(body);
            rows.extend([off[0], off[1], base, off[2], off[3], n, colors, 0].map(f32::from_bits));
        }
        self.n_inst = insts.len() as u32;
        // A runtime array binding needs room for one element even when the
        // loop traces before the first mesh lands; n_inst keeps it unread.
        if rows.is_empty() {
            rows.resize(32, 0.0);
        }
        if mats.is_empty() {
            mats.push(pack_material(&Default::default()));
        }
        let u = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
        self.insts = buffer(&self.device, &self.queue, bytes(&rows), u);
        self.mats = buffer(&self.device, &self.queue, bytes(&mats), u);
        self.bind = None;
    }

    fn bind_group(&mut self) -> wgpu::BindGroup {
        if let Some(b) = &self.bind {
            return b.clone();
        }
        let s = &self.shading;
        let mut e = vec![
            wgpu::BindGroupEntry { binding: 0, resource: self.uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: self.accum.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: self.aov.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: s.pos.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: s.nrm.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: s.idx.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: s.slots.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 7, resource: s.cols.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 8, resource: self.insts.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 9, resource: self.mats.as_entire_binding() },
        ];
        match &self.scene.accel.tlas {
            Some(t) if self.path == Path::RayQuery => {
                e.push(wgpu::BindGroupEntry { binding: 10, resource: t.as_binding() });
            }
            _ => {
                e.push(wgpu::BindGroupEntry { binding: 10, resource: s.nodes.as_entire_binding() });
                e.push(wgpu::BindGroupEntry { binding: 11, resource: s.order.as_entire_binding() });
            }
        }
        let b = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.trace_bgl, entries: &e });
        self.bind = Some(b.clone());
        b
    }

    fn write_uniform(&self, rows: u32) {
        let c = &self.camera;
        let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        let norm = |a: [f32; 3]| {
            let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-20);
            [a[0] / l, a[1] / l, a[2] / l]
        };
        let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        let fwd = norm(sub(c.target, c.eye));
        let right = norm(cross(fwd, c.up));
        let up = cross(right, fwd);
        let th = (c.fov.to_radians() * 0.5).tan();
        let aspect = self.w as f32 / self.h as f32;
        let l = &self.look;
        let sun_on = (l.sun_dir.iter().any(|x| *x != 0.0) && l.sun_color.iter().any(|x| *x > 0.0)) as u32 as f32;
        let ints = [self.w, self.h, self.sample, self.row0, rows, self.n_inst, l.bounces.max(1), (self.sample == 0) as u32];
        let mut data: Vec<f32> = ints.map(f32::from_bits).to_vec();
        let v4 = |v: [f32; 3], w: f32| [v[0], v[1], v[2], w];
        for v in [
            v4(c.eye, 0.0),
            v4(fwd, 0.0),
            v4(right.map(|x| x * th * aspect), 0.0),
            v4(up.map(|x| x * th), 0.0),
            v4(l.sky_top, l.env_intensity),
            v4(l.sky_bottom, 0.0),
            v4(norm(l.sun_dir), sun_on),
            v4(l.sun_color, 0.0),
            [l.exposure, 0.0, 0.0, 0.0],
        ] {
            data.extend(v);
        }
        self.queue.write_buffer(&self.uniform, 0, bytes(&data));
    }

    /// One dispatch: the whole frame on the hardware path, a band of rows on
    /// the software path. False once the sample cap is reached.
    pub fn step(&mut self) -> bool {
        if self.sample >= self.cap {
            return false;
        }
        let rows = self.rows.min(self.h - self.row0);
        self.write_uniform(rows);
        let bind = self.bind_group();
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.trace_pipe);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(self.w.div_ceil(8), rows.div_ceil(8), 1);
        }
        self.queue.submit([enc.finish()]);
        self.row0 += rows;
        if self.row0 >= self.h {
            self.row0 = 0;
            self.sample += 1;
        }
        true
    }

    /// Dispatches until `budget` has passed or the cap is reached; answers the
    /// samples completed.
    pub fn trace_for(&mut self, budget: Duration) -> u32 {
        let start = Instant::now();
        let before = self.sample;
        loop {
            let t = Instant::now();
            if start.elapsed() >= budget || !self.step() {
                break;
            }
            self.wait();
            if self.path == Path::Software {
                self.rows = adapt_rows(self.rows, self.w, self.h, t.elapsed(), BAND_TARGET);
            }
        }
        self.sample - before
    }

    /// One frame for the transport: applies pending scene changes, traces for
    /// `budget` and resolves. At the cap it hands out the held frame without
    /// touching the GPU, and the denoised one once it lands; below it a
    /// software band that ends mid sample still traces on, so the sample count
    /// is no sign of a finished picture.
    pub fn frame(&mut self, w: u32, h: u32, budget: Duration) -> Vec<u8> {
        self.resize(w, h);
        self.apply();
        if self.done() && self.held.as_ref().is_some_and(|h| h.key == self.key()) {
            self.collect_denoise();
            self.rebloom_held();
            return self.held.as_ref().map(|h| h.pixels.clone()).unwrap_or_default();
        }
        self.trace_for(budget);
        let pixels = self.resolve();
        self.held = Some(Held { key: self.key(), pixels: pixels.clone(), denoised: false, bloom: self.bloom, denoise: None });
        if self.done() {
            self.start_denoise();
        }
        pixels
    }

    fn key(&self) -> FrameKey {
        (self.generation(), self.sample, (self.w, self.h))
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
        if self.held.as_ref().is_some_and(|h| h.denoised) {
            self.held = None;
        }
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

    fn start_denoise(&mut self) {
        if self.quality == Quality::Off {
            return;
        }
        let aov = self.read_aovs();
        let input = denoise::Input {
            width: self.w as usize,
            height: self.h as usize,
            color: self.read_hdr().into_iter().flatten().collect(),
            albedo: aov.iter().step_by(2).flat_map(|a| [a[0], a[1], a[2]]).collect(),
            normal: aov.iter().skip(1).step_by(2).flat_map(|n| [n[0], n[1], n[2]]).collect(),
            depth: aov.chunks_exact(2).map(|p| if p[1][3] > 0.0 { p[0][3] } else { 0.0 }).collect(),
            samples: self.sample,
        };
        let (tx, rx) = mpsc::channel();
        let quality = self.quality;
        let e = if self.look.exposure > 0.0 { self.look.exposure } else { 1.0 };
        let spawned = std::thread::Builder::new().name("denoise".into()).spawn(move || {
            let (c, by, note) = denoise::run(&input, quality);
            let rgb: Vec<[f32; 3]> = c.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
            let d = Denoised { plain: denoise::tone_map(&rgb), hdr: rgb.iter().map(|p| [p[0] / e, p[1] / e, p[2] / e, 1.0]).collect(), by, note };
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

    /// Rows per software dispatch.
    pub fn band(&self) -> u32 {
        self.rows
    }

    pub fn render_samples(&mut self, n: u32) {
        while self.sample < n.min(self.cap) && self.step() {
            self.wait();
        }
    }

    pub fn wait(&self) {
        let _ = self.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None });
    }

    fn read(&self, src: &wgpu::Buffer, size: u64) -> Vec<u8> {
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(src, 0, &staging, 0, size);
        self.queue.submit([enc.finish()]);
        staging.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        self.wait();
        let v = staging.slice(..).get_mapped_range().expect("mapped").to_vec();
        staging.unmap();
        v
    }

    /// The accumulated image tone mapped to sRGB RGBA8, rows top first.
    pub fn resolve(&mut self) -> Vec<u8> {
        self.resolve_from(false)
    }

    /// The threshold kept above the sky as the trace draws it, the background
    /// times the brightness: the page raised it above the background alone,
    /// so a brightness above 1 could bloom the whole sky.
    fn bloom_threshold(&self, b: &Bloom) -> f32 {
        let l = &self.look;
        let sky = bloom::luma(l.sky_top).max(bloom::luma(l.sky_bottom)) * l.env_intensity;
        b.threshold.max(sky + 0.05)
    }

    fn resolve_from(&mut self, denoised: bool) -> Vec<u8> {
        let Some(b) = self.bloom else { return self.resolve_plain() };
        let r = [self.w, self.h, self.look.exposure.to_bits(), 0];
        self.queue.write_buffer(&self.resolve_uniform, 0, bytes(&r));
        let threshold = self.bloom_threshold(&b);
        let src = if denoised { &self.hdr } else { &self.accum };
        let chain = self.chain.get_or_insert_with(|| Chain::new(&self.device));
        let mut enc = self.device.create_command_encoder(&Default::default());
        let (glow, size) = chain.encode(&self.device, &self.queue, &mut enc, src, (self.w, self.h), &b, threshold);
        self.queue.write_buffer(&self.glow_uniform, 0, bytes(&[size.0, size.1, 0, 0]));
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.glow_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.resolve_uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: src.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: glow.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: self.glow_uniform.as_entire_binding() },
            ],
        });
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.glow_pipe);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(self.w.div_ceil(8), self.h.div_ceil(8), 1);
        }
        self.queue.submit([enc.finish()]);
        self.read(&self.out, self.w as u64 * self.h as u64 * 4)
    }

    fn resolve_plain(&mut self) -> Vec<u8> {
        let r = [self.w, self.h, self.look.exposure.to_bits(), 0];
        self.queue.write_buffer(&self.resolve_uniform, 0, bytes(&r));
        let bind = match &self.resolve_bind {
            Some(b) => b.clone(),
            None => {
                let b = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.resolve_bgl,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: self.resolve_uniform.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: self.accum.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 2, resource: self.out.as_entire_binding() },
                    ],
                });
                self.resolve_bind = Some(b.clone());
                b
            }
        };
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.resolve_pipe);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(self.w.div_ceil(8), self.h.div_ceil(8), 1);
        }
        self.queue.submit([enc.finish()]);
        self.read(&self.out, self.w as u64 * self.h as u64 * 4)
    }

    /// The accumulation as exposed linear rgb, rows top first: what resolve.wgsl
    /// tone maps.
    pub fn read_hdr(&self) -> Vec<[f32; 3]> {
        let raw = self.read(&self.accum, self.w as u64 * self.h as u64 * 16);
        let e = self.look.exposure;
        raw.chunks_exact(16)
            .map(|c| {
                let f = |k: usize| f32::from_le_bytes(c[k * 4..k * 4 + 4].try_into().unwrap());
                let n = f(3).max(1.0);
                [f(0) / n * e, f(1) / n * e, f(2) / n * e]
            })
            .collect()
    }

    /// Two vec4 per pixel from the first sample after a reset: albedo and view
    /// depth, then world normal and coverage. What the denoiser reads.
    pub fn read_aovs(&self) -> Vec<[f32; 4]> {
        let raw = self.read(&self.aov, self.w as u64 * self.h as u64 * 32);
        raw.chunks_exact(16)
            .map(|c| [0, 1, 2, 3].map(|k| f32::from_le_bytes(c[k * 4..k * 4 + 4].try_into().unwrap())))
            .collect()
    }
}

fn pipeline(device: &wgpu::Device, bgl: &wgpu::BindGroupLayout, src: &str, label: &str) -> wgpu::ComputePipeline {
    pipeline_at(device, bgl, src, label, "main")
}

pub(crate) fn pipeline_at(
    device: &wgpu::Device,
    bgl: &wgpu::BindGroupLayout,
    src: &str,
    label: &str,
    entry: &str,
) -> wgpu::ComputePipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(src.into()),
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[Some(bgl)],
        immediate_size: 0,
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&layout),
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        t.set_camera(Camera { eye: [0.0, 0.0, 12.0], target: [0.0; 3], up: [0.0, 1.0, 0.0], fov: 50.0 });
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

    #[test]
    fn a_software_band_follows_the_dispatch_time() {
        let ms = Duration::from_millis;
        assert_eq!(adapt_rows(272, 1920, 1080, ms(30), ms(10)), 96);
        assert_eq!(adapt_rows(96, 1920, 1080, ms(10), ms(10)), 96);
        assert_eq!(adapt_rows(96, 1920, 1080, ms(1), ms(10)), 192);
        assert_eq!(adapt_rows(1080, 1920, 1080, ms(1), ms(10)), 1080);
        assert_eq!(adapt_rows(100, 1920, 1080, Duration::ZERO, ms(10)), 200);
        // 65536 paths at 1920 wide is 34 rows, 40 on the workgroup grid.
        assert_eq!(adapt_rows(48, 1920, 1080, ms(400), ms(10)), 40);
        assert_eq!(adapt_rows(8, 64, 48, ms(400), ms(10)), 48);
    }
}
