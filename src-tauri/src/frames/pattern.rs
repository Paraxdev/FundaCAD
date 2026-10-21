//! The frames' content until the native tracer lands: a moving pattern drawn
//! by a wgpu compute pass and read back, so the GPU readback is in the measured
//! path the way the tracer's will be.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use fundacad_frames::FrameSource;

const SHADER: &str = r#"
@group(0) @binding(0) var<storage, read_write> dst: array<u32>;
struct P { seq: u32, w: u32, h: u32, pad: u32 }
@group(0) @binding(1) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let t = f32(p.seq) * 0.05;
  let uv = vec2<f32>(f32(id.x) / f32(p.w), f32(id.y) / f32(p.h));
  let c = vec4<f32>(0.5 + 0.5 * sin(uv.x * 12.0 + t), 0.5 + 0.5 * sin(uv.y * 9.0 - t),
                    0.5 + 0.5 * sin((uv.x + uv.y) * 7.0 + t * 1.3), 1.0);
  dst[id.y * p.w + id.x] = pack4x8unorm(c);
}
"#;

struct Target {
    width: u32,
    height: u32,
    out: wgpu::Buffer,
    staging: wgpu::Buffer,
    bind: wgpu::BindGroup,
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipe: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    uniform: wgpu::Buffer,
    target: Option<Target>,
}

/// The flag: the failure was logged.
struct GpuPattern(Mutex<Gpu>, AtomicBool);

/// The source and a line naming it for the log.
pub fn create() -> (Arc<dyn FrameSource>, String) {
    match Gpu::new() {
        Ok((gpu, name)) => (Arc::new(GpuPattern(Mutex::new(gpu), AtomicBool::new(false))), name),
        Err(e) => {
            eprintln!("[frames] no GPU for the test pattern, drawing it on the CPU: {e}");
            (Arc::new(CpuPattern), "cpu".into())
        }
    }
}

fn rank(b: wgpu::Backend) -> u8 {
    match b {
        wgpu::Backend::Vulkan => 0,
        wgpu::Backend::Dx12 => 1,
        wgpu::Backend::Metal => 2,
        _ => 3,
    }
}

impl Gpu {
    fn new() -> Result<(Gpu, String), String> {
        let backends = fundacad_tracer::TracerOptions::default().backends;
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = backends;
        let instance = wgpu::Instance::new(desc);
        let adapters = futures_executor::block_on(instance.enumerate_adapters(backends));
        let adapter = adapters
            .into_iter()
            .min_by_key(|a| {
                let i = a.get_info();
                (rank(i.backend), u8::from(i.device_type != wgpu::DeviceType::DiscreteGpu))
            })
            .ok_or("no adapter")?;
        let info = adapter.get_info();
        let (device, queue) = futures_executor::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .map_err(|e| e.to_string())?;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("frames-pattern"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("frames-pattern"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let layout = pipe.get_bind_group_layout(0);
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let name = format!("{:?} {}", info.backend, info.name);
        Ok((Gpu { device, queue, pipe, layout, uniform, target: None }, name))
    }

    fn target(&mut self, width: u32, height: u32) -> &Target {
        let stale = self.target.as_ref().is_none_or(|t| t.width != width || t.height != height);
        if stale {
            let size = width as u64 * height as u64 * 4;
            let out = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.uniform.as_entire_binding() },
                ],
            });
            self.target = Some(Target { width, height, out, staging, bind });
        }
        self.target.as_ref().unwrap()
    }

    fn render(&mut self, out: &mut [u8], width: u32, height: u32, seq: u32) -> Result<(), String> {
        self.target(width, height);
        let t = self.target.as_ref().unwrap();
        let p = [seq, width, height, 0].map(u32::to_le_bytes).concat();
        self.queue.write_buffer(&self.uniform, 0, &p);
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipe);
            pass.set_bind_group(0, &t.bind, &[]);
            pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }
        enc.copy_buffer_to_buffer(&t.out, 0, &t.staging, 0, out.len() as u64);
        self.queue.submit([enc.finish()]);
        let slice = t.staging.slice(..out.len() as u64);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
            .map_err(|e| e.to_string())?;
        out.copy_from_slice(&slice.get_mapped_range().map_err(|e| e.to_string())?);
        t.staging.unmap();
        Ok(())
    }
}

impl FrameSource for GpuPattern {
    fn render(&self, out: &mut [u8], width: u32, height: u32, seq: u32) {
        let done = match self.0.lock() {
            Ok(mut gpu) => gpu.render(out, width, height, seq),
            Err(_) => Err("an earlier frame panicked".into()),
        };
        if let Err(e) = done {
            if !self.1.swap(true, Ordering::Relaxed) {
                eprintln!("[frames] GPU pattern failed, drawing it on the CPU from now: {e}");
            }
            CpuPattern.render(out, width, height, seq);
        }
    }
}

struct CpuPattern;

impl FrameSource for CpuPattern {
    fn render(&self, out: &mut [u8], width: u32, _height: u32, seq: u32) {
        let w = width.max(1) as usize;
        for (i, px) in out.chunks_exact_mut(4).enumerate() {
            let (x, y) = (i % w, i / w);
            px.copy_from_slice(&[(x as u32 + seq) as u8, (y as u32 + seq) as u8, (x ^ y) as u8, 255]);
        }
    }
}
