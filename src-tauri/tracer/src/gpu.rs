use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::bvh::{self, Bvh};
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    pub eye: [f32; 3],
    pub target: [f32; 3],
    pub up: [f32; 3],
    /// Vertical field of view in degrees.
    pub fov: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
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

fn bytes<T: Copy>(v: &[T]) -> &[u8] {
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

fn storage(device: &wgpu::Device, size: u64, extra: wgpu::BufferUsages) -> wgpu::Buffer {
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
    w: u32,
    h: u32,
    sample: u32,
    row0: u32,
    rows: u32,
    cap: u32,
    camera: Camera,
    look: Look,
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
        let empty = |d: &wgpu::Device| storage(d, 16, wgpu::BufferUsages::empty());
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
            w: 0,
            h: 0,
            sample: 0,
            row0: 0,
            rows: 0,
            cap: 256,
            camera: Camera { eye: [4.0, -6.0, 3.0], target: [0.0; 3], up: [0.0, 0.0, 1.0], fov: 50.0 },
            look: Look::default(),
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
        self.accum = storage(&self.device, px * 16, wgpu::BufferUsages::empty());
        self.aov = storage(&self.device, px * 32, wgpu::BufferUsages::COPY_SRC);
        self.out = storage(&self.device, px * 4, wgpu::BufferUsages::COPY_SRC);
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
        while start.elapsed() < budget && self.step() {
            self.wait();
        }
        self.sample - before
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
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    })
}
