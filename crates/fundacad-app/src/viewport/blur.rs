//! Frosted glass: whatever floats over the view blurs what is behind it, as the Vue app's
//! `backdrop-filter: blur(24px) saturate(1.08)` does. The blur runs in the viewport's own pass, after the scene is
//! resolved: the resolve texture is downsampled to a quarter, blurred there and drawn back inside each panel's rounded rect.

use std::sync::Arc;

use gpui::{Bounds, DevicePixels, Pixels, Size};
use gpui_wgpu::wgpu;

/// Std deviation of CSS `blur(24px)`, in device pixels at scale 1.
const SIGMA: f32 = 24.0;
const SATURATE: f32 = 1.08;
/// The working resolution is 1/QUARTER of the view.
const QUARTER: f32 = 4.0;
/// A Gaussian past three sigmas is below 1%.
const REACH: f32 = 3.0;
const MAX_PANELS: usize = 64;

/// A panel over the view in window space: its bounds and corner radius in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frost {
    pub bounds: Bounds<Pixels>,
    pub radius: f32,
}

/// A panel in device pixels from the view's origin.
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct Panel {
    /// x, y, width, height.
    pub rect: [f32; 4],
    pub radius: f32,
}

impl Panel {
    /// `origin` is the view's top left in the same window space as `frost`.
    pub fn new(frost: &Frost, origin: gpui::Point<Pixels>, scale: f32) -> Self {
        let p = frost.bounds.origin - origin;
        let s = frost.bounds.size;
        Self {
            rect: [p.x.as_f32() * scale, p.y.as_f32() * scale, s.width.as_f32() * scale, s.height.as_f32() * scale],
            radius: frost.radius * scale,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    kernel: [f32; 4],
    area: [f32; 4],
}

pub struct Blur {
    queue: Arc<wgpu::Queue>,
    sampler: wgpu::Sampler,
    layout: wgpu::BindGroupLayout,
    down: wgpu::RenderPipeline,
    gauss: wgpu::RenderPipeline,
    panel: wgpu::RenderPipeline,
    horizontal: wgpu::Buffer,
    vertical: wgpu::Buffer,
    area: wgpu::Buffer,
    panels: wgpu::Buffer,
}

/// The textures and bind groups of one view size.
pub struct Chain {
    half: wgpu::TextureView,
    quarter: wgpu::TextureView,
    ping: wgpu::TextureView,
    /// resolve to half, half to quarter, quarter to ping, ping to quarter, quarter to the panels.
    groups: [wgpu::BindGroup; 5],
    quarter_size: [f32; 2],
}

impl Blur {
    pub fn new(device: &wgpu::Device, queue: Arc<wgpu::Queue>, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("viewport blur"),
            source: wgpu::ShaderSource::Wgsl(include_str!("blur.wgsl").into()),
        });
        let entry = |binding, visibility, ty| wgpu::BindGroupLayoutEntry { binding, visibility, ty, count: None };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("viewport blur"),
            entries: &[
                entry(
                    0,
                    wgpu::ShaderStages::FRAGMENT,
                    wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                ),
                entry(1, wgpu::ShaderStages::FRAGMENT, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
                entry(
                    2,
                    wgpu::ShaderStages::VERTEX_FRAGMENT,
                    wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                ),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("viewport blur"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |label, vs, fs, buffers: &[Option<wgpu::VertexBufferLayout>], topology, blend| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vs),
                    compilation_options: Default::default(),
                    buffers,
                },
                primitive: wgpu::PrimitiveState { topology, ..Default::default() },
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let list = wgpu::PrimitiveTopology::TriangleList;
        let instances = [Some(wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Panel>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32],
        })];
        let uniform = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: std::mem::size_of::<Params>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        Self {
            queue,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            down: pipeline("blur down", "vs_full", "fs_down", &[], list, None),
            gauss: pipeline("blur gauss", "vs_full", "fs_gauss", &[], list, None),
            panel: pipeline(
                "blur panels",
                "vs_panel",
                "fs_panel",
                &instances,
                wgpu::PrimitiveTopology::TriangleStrip,
                Some(wgpu::BlendState::ALPHA_BLENDING),
            ),
            layout,
            horizontal: uniform("blur horizontal"),
            vertical: uniform("blur vertical"),
            area: uniform("blur area"),
            panels: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("blur panels"),
                size: (std::mem::size_of::<Panel>() * MAX_PANELS) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
        }
    }

    /// The textures for a view of `size`, to be remade with the rest of the targets on a resize.
    pub fn chain(
        &self,
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        size: Size<DevicePixels>,
        resolve: &wgpu::TextureView,
    ) -> Chain {
        let level = |label, divisor: u32| {
            let extent = wgpu::Extent3d {
                width: (size.width.0.max(1) as u32).div_ceil(divisor),
                height: (size.height.0.max(1) as u32).div_ceil(divisor),
                depth_or_array_layers: 1,
            };
            (
                device
                    .create_texture(&wgpu::TextureDescriptor {
                        label: Some(label),
                        size: extent,
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                        view_formats: &[],
                    })
                    .create_view(&Default::default()),
                [extent.width as f32, extent.height as f32],
            )
        };
        let (half, _) = level("blur half", 2);
        let (quarter, quarter_size) = level("blur quarter", 4);
        let (ping, _) = level("blur ping", 4);
        let group = |texture: &wgpu::TextureView, params: &wgpu::Buffer| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("viewport blur"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(texture) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    wgpu::BindGroupEntry { binding: 2, resource: params.as_entire_binding() },
                ],
            })
        };
        let groups = [
            group(resolve, &self.area),
            group(&half, &self.area),
            group(&quarter, &self.horizontal),
            group(&ping, &self.vertical),
            group(&quarter, &self.area),
        ];
        Chain { half, quarter, ping, groups, quarter_size }
    }

    /// Blurs the view behind each panel into `resolve`, in `encoder`. `size` is the view in device pixels.
    pub fn run(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        chain: &Chain,
        resolve: &wgpu::TextureView,
        size: Size<DevicePixels>,
        panels: &[Panel],
        scale: f32,
    ) {
        let panels = &panels[..panels.len().min(MAX_PANELS)];
        if panels.is_empty() {
            return;
        }
        let sigma = SIGMA * scale / QUARTER;
        let [qw, qh] = chain.quarter_size;
        let kernel = |dir: [f32; 2]| Params {
            kernel: [dir[0], dir[1], sigma, (sigma * REACH).ceil()],
            area: [size.width.0 as f32, size.height.0 as f32, SATURATE, 0.0],
        };
        self.queue.write_buffer(&self.horizontal, 0, bytemuck::bytes_of(&kernel([1.0 / qw, 0.0])));
        self.queue.write_buffer(&self.vertical, 0, bytemuck::bytes_of(&kernel([0.0, 1.0 / qh])));
        self.queue.write_buffer(&self.area, 0, bytemuck::bytes_of(&kernel([0.0, 0.0])));
        self.queue.write_buffer(&self.panels, 0, bytemuck::cast_slice(panels));

        let skip = wgpu::LoadOp::Clear(wgpu::Color::BLACK);
        let steps = [
            (&self.down, &chain.half, &chain.groups[0]),
            (&self.down, &chain.quarter, &chain.groups[1]),
            (&self.gauss, &chain.ping, &chain.groups[2]),
            (&self.gauss, &chain.quarter, &chain.groups[3]),
        ];
        for (pipeline, target, group) in steps {
            let mut p = begin(encoder, target, skip);
            p.set_pipeline(pipeline);
            p.set_bind_group(0, group, &[]);
            p.draw(0..3, 0..1);
        }
        let mut p = begin(encoder, resolve, wgpu::LoadOp::Load);
        p.set_pipeline(&self.panel);
        p.set_bind_group(0, &chain.groups[4], &[]);
        p.set_vertex_buffer(0, self.panels.slice(..));
        p.draw(0..4, 0..panels.len() as u32);
    }
}

fn begin<'a>(
    encoder: &'a mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    load: wgpu::LoadOp<wgpu::Color>,
) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("viewport blur"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
        })],
        ..Default::default()
    })
}
