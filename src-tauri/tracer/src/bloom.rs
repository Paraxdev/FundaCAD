//! Bloom before tone mapping, the chain the page's TraceBloom runs for the
//! WebGPU tracer, so both backends glow alike.

use crate::gpu::{bytes, pipeline_at, storage};

/// What the page's `traceBloom` sends; `side` is the long side of the bloom's
/// input in pixels (the page's `bloomSide` of its drawing buffer), 0 for half
/// the frame.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bloom {
    pub strength: f32,
    pub radius: f32,
    pub threshold: f32,
    #[serde(default)]
    pub side: u32,
}

pub const MAX_SIDE: u32 = 1920;
const MIPS: usize = 5;
const KERNELS: [u32; MIPS] = [6, 10, 14, 18, 22];
const FACTORS: [f32; MIPS] = [1.0, 0.8, 0.6, 0.4, 0.2];
/// One per pass: a high pass, two blurs per mip and a gather per mip.
const PASSES: u64 = 1 + 3 * MIPS as u64;
const SLOT: u64 = 256;

/// Rec. 709 luminance, the high pass's weights.
pub fn luma(c: [f32; 3]) -> f32 {
    0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2]
}

/// The bloom's input size for a `w` x `h` frame, as BloomNode sizes its first
/// mip from the resolution scale.
pub fn input_size(w: u32, h: u32, side: u32) -> (u32, u32) {
    let long = w.max(h).max(1);
    let side = if side == 0 { long.div_ceil(2).min(MAX_SIDE) } else { side.min(MAX_SIDE) };
    let s = side as f64 / long as f64;
    (((w as f64 * s).floor() as u32).max(1), ((h as f64 * s).floor() as u32).max(1))
}

struct Target {
    size: (u32, u32),
    bright: wgpu::Buffer,
    horiz: Vec<wgpu::Buffer>,
    vert: Vec<wgpu::Buffer>,
    mips: Vec<(u32, u32)>,
}

pub(crate) struct Chain {
    bgl: wgpu::BindGroupLayout,
    high: wgpu::ComputePipeline,
    blur: wgpu::ComputePipeline,
    gather: wgpu::ComputePipeline,
    params: wgpu::Buffer,
    target: Option<Target>,
}

impl Chain {
    pub fn new(device: &wgpu::Device) -> Chain {
        let buf = |binding, ty, dynamic| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: dynamic, min_binding_size: None },
            count: None,
        };
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tracer-bloom"),
            entries: &[
                buf(0, wgpu::BufferBindingType::Uniform, true),
                buf(1, wgpu::BufferBindingType::Storage { read_only: true }, false),
                buf(2, wgpu::BufferBindingType::Storage { read_only: false }, false),
            ],
        });
        let src = include_str!("bloom.wgsl");
        Chain {
            high: pipeline_at(device, &bgl, src, "tracer-bloom-high", "high"),
            blur: pipeline_at(device, &bgl, src, "tracer-bloom-blur", "blur"),
            gather: pipeline_at(device, &bgl, src, "tracer-bloom-gather", "gather"),
            params: device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: PASSES * SLOT,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            bgl,
            target: None,
        }
    }

    fn target(&mut self, device: &wgpu::Device, size: (u32, u32)) -> &Target {
        if self.target.as_ref().is_none_or(|t| t.size != size) {
            let px = |s: (u32, u32)| s.0 as u64 * s.1 as u64 * 16;
            let mut mips = Vec::with_capacity(MIPS);
            let mut m = size;
            for _ in 0..MIPS {
                mips.push(m);
                m = ((m.0 / 2).max(1), (m.1 / 2).max(1));
            }
            let none = wgpu::BufferUsages::empty();
            self.target = Some(Target {
                size,
                bright: storage(device, px(size), none),
                horiz: mips.iter().map(|&m| storage(device, px(m), none)).collect(),
                vert: mips.iter().map(|&m| storage(device, px(m), none)).collect(),
                mips,
            });
        }
        self.target.as_ref().unwrap()
    }

    /// Encodes the glow of `src`, a `w` x `h` buffer of rgb over a sample
    /// count as resolve.wgsl reads it, and answers the glow and its size.
    pub fn encode<'a>(
        &'a mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        enc: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        (w, h): (u32, u32),
        b: &Bloom,
        threshold: f32,
    ) -> (&'a wgpu::Buffer, (u32, u32)) {
        let size = input_size(w, h, b.side);
        self.target(device, size);
        let t = self.target.as_ref().unwrap();
        let mut params = vec![0u8; (PASSES * SLOT) as usize];
        let mut passes: Vec<(&wgpu::ComputePipeline, &wgpu::Buffer, &wgpu::Buffer, (u32, u32))> = Vec::new();
        let mut put =
            |slot: usize, s: (u32, u32), d: (u32, u32), dir: [f32; 2], kernel: u32, factor: f32, first: u32| {
                let p: [u32; 12] = [
                    s.0,
                    s.1,
                    d.0,
                    d.1,
                    dir[0].to_bits(),
                    dir[1].to_bits(),
                    threshold.to_bits(),
                    b.strength.to_bits(),
                    b.radius.to_bits(),
                    kernel,
                    factor.to_bits(),
                    first,
                ];
                let o = slot * SLOT as usize;
                params[o..o + 48].copy_from_slice(bytes(&p));
            };
        put(0, (w, h), size, [0.0; 2], 0, 0.0, 0);
        passes.push((&self.high, src, &t.bright, size));
        let mut prev = (&t.bright, size);
        for i in 0..MIPS {
            let m = t.mips[i];
            put(1 + 2 * i, prev.1, m, [1.0, 0.0], KERNELS[i], 0.0, 0);
            passes.push((&self.blur, prev.0, &t.horiz[i], m));
            put(2 + 2 * i, m, m, [0.0, 1.0], KERNELS[i], 0.0, 0);
            passes.push((&self.blur, &t.horiz[i], &t.vert[i], m));
            prev = (&t.vert[i], m);
        }
        // The blurs no longer need the first horizontal mip, so it takes the sum.
        for i in 0..MIPS {
            put(1 + 2 * MIPS + i, t.mips[i], size, [0.0; 2], 0, FACTORS[i], u32::from(i == 0));
            passes.push((&self.gather, &t.vert[i], &t.horiz[0], size));
        }
        queue.write_buffer(&self.params, 0, &params);
        let binds: Vec<wgpu::BindGroup> = passes
            .iter()
            .map(|(_, s, d, _)| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &self.params,
                                offset: 0,
                                size: wgpu::BufferSize::new(48),
                            }),
                        },
                        wgpu::BindGroupEntry { binding: 1, resource: s.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 2, resource: d.as_entire_binding() },
                    ],
                })
            })
            .collect();
        // One pass per dispatch: wgpu orders storage writes between passes.
        for (i, ((pipe, _, _, d), bind)) in passes.iter().zip(&binds).enumerate() {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipe);
            pass.set_bind_group(0, bind, &[(i as u64 * SLOT) as u32]);
            pass.dispatch_workgroups(d.0.div_ceil(8), d.1.div_ceil(8), 1);
        }
        (&t.horiz[0], size)
    }
}
