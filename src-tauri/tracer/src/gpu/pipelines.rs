use super::bindings::{self, Kind};
use super::Path;

pub(super) struct Pipelines {
    pub trace: wgpu::ComputePipeline,
    pub trace_bgl: wgpu::BindGroupLayout,
    pub resolve: wgpu::ComputePipeline,
    pub resolve_bgl: wgpu::BindGroupLayout,
    pub glow: wgpu::ComputePipeline,
    pub glow_bgl: wgpu::BindGroupLayout,
}

/// The trace kernel for a path: its `trace` function, then the shared body.
/// The software walk sizes its stack by the depth the BVH build allows.
pub(super) fn trace_source(path: Path) -> String {
    let walk = match path {
        Path::RayQuery => include_str!("../rq.wgsl").to_string(),
        Path::Software => format!("const STACK: u32 = {}u;\n{}", crate::bvh::STACK, include_str!("../sw.wgsl")),
    };
    format!("{walk}\n{}", include_str!("../trace.wgsl"))
}

impl Pipelines {
    pub(super) fn new(device: &wgpu::Device, path: Path) -> Pipelines {
        let (uni, ro, rw) = (Kind::Uniform, Kind::Storage { write: false }, Kind::Storage { write: true });
        let e = bindings::entry;
        let trace_bgl = bindings::trace_layout(device, path);
        let trace = pipeline(device, &trace_bgl, &trace_source(path), "tracer-trace");
        let resolve_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[e(0, uni), e(1, ro), e(2, rw)],
        });
        let resolve = pipeline(device, &resolve_bgl, include_str!("../resolve.wgsl"), "tracer-resolve");
        let glow_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[e(0, uni), e(1, ro), e(2, rw), e(3, ro), e(4, uni)],
        });
        let glow_src = format!("{}\n{}", include_str!("../resolve.wgsl"), include_str!("../resolve_bloom.wgsl"));
        let glow = pipeline_at(device, &glow_bgl, &glow_src, "tracer-resolve-bloom", "main_bloom");
        Pipelines { trace, trace_bgl, resolve, resolve_bgl, glow, glow_bgl }
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
