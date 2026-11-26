use std::sync::Arc;

use glam::Vec3;
use gpui::{DevicePixels, Size};
use gpui_wgpu::{wgpu, WgpuContext};
use wgpu::util::DeviceExt;

use super::camera::Camera;
use super::scene::{Body, Scene, Vertex};

const SAMPLES: u32 = 4;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const CLEAR: wgpu::Color = wgpu::Color { r: 0.09, g: 0.1, b: 0.12, a: 1.0 };

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    view_proj: [[f32; 4]; 4],
    eye: [f32; 4],
    encode_srgb: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BodyUniforms {
    /// xyz: how far the masked vertices move.
    offset: [f32; 4],
    /// x: the hovered face or -1, y: 1 when that face can be pushed.
    hover: [i32; 4],
}

/// What one frame shows beyond the scene.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Overlay {
    pub hover: Option<(usize, u32, bool)>,
    /// The body whose masked vertices move, and by how much.
    pub stretch: Option<(usize, Vec3)>,
    /// Bumped whenever the mask changes.
    pub mask_revision: u64,
}

struct Targets {
    size: Size<DevicePixels>,
    msaa: wgpu::TextureView,
    depth: wgpu::TextureView,
    resolve: wgpu::TextureView,
}

struct GpuBody {
    source: Arc<Body>,
    vertices: wgpu::Buffer,
    mask: wgpu::Buffer,
    vertex_count: usize,
    indices: wgpu::Buffer,
    index_count: u32,
}

/// What the last frame was drawn from, to skip frames where nothing changed.
#[derive(PartialEq)]
struct Drawn {
    camera: Camera,
    size: Size<DevicePixels>,
    scene_revision: u64,
    overlay: Overlay,
}

/// Draws the scene into a texture on GPUI's device, which GPUI then composites like any element.
pub struct Renderer {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    body_layout: wgpu::BindGroupLayout,
    body_stride: u64,
    body_uniforms: Option<(wgpu::Buffer, wgpu::BindGroup, usize)>,
    bodies: Vec<GpuBody>,
    scene_revision: u64,
    masked: Option<(usize, u64)>,
    targets: Option<Targets>,
    texture_generation: u64,
    drawn: Option<Drawn>,
    context_generation: u64,
    texture_index: u32,
}

impl Renderer {
    pub fn new(context: &WgpuContext, context_generation: u64, texture_index: u32) -> Self {
        let device = context.device.clone();
        let format = context.color_texture_format();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("viewport"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("viewport uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform_entry = |dynamic: bool| wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: dynamic,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("viewport"),
            entries: &[uniform_entry(false)],
        });
        let body_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("viewport body"),
            entries: &[uniform_entry(true)],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("viewport"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("viewport"),
            bind_group_layouts: &[Some(&layout), Some(&body_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("viewport"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[
                    Some(wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Vertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Uint32],
                    }),
                    Some(wgpu::VertexBufferLayout {
                        array_stride: 4,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![3 => Float32],
                    }),
                ],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState { count: SAMPLES, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(format.into())],
            }),
            multiview_mask: None,
            cache: None,
        });
        let align = device.limits().min_uniform_buffer_offset_alignment as u64;
        let body_stride = (std::mem::size_of::<BodyUniforms>() as u64).div_ceil(align) * align;
        Self {
            device,
            queue: context.queue.clone(),
            format,
            pipeline,
            uniforms,
            bind_group,
            body_layout,
            body_stride,
            body_uniforms: None,
            bodies: Vec::new(),
            scene_revision: u64::MAX,
            masked: None,
            targets: None,
            texture_generation: 0,
            drawn: None,
            context_generation,
            texture_index,
        }
    }

    pub fn context_generation(&self) -> u64 {
        self.context_generation
    }

    fn sync(&mut self, scene: &Scene) {
        if self.scene_revision == scene.revision {
            return;
        }
        self.scene_revision = scene.revision;
        self.masked = None;
        let mut old: Vec<Option<GpuBody>> = std::mem::take(&mut self.bodies).into_iter().map(Some).collect();
        for body in &scene.bodies {
            let kept = old.iter_mut().find(|o| o.as_ref().is_some_and(|o| Arc::ptr_eq(&o.source, &body.source)));
            let gpu = match kept.and_then(Option::take) {
                Some(gpu) => {
                    self.queue.write_buffer(&gpu.mask, 0, bytemuck::cast_slice(&vec![0f32; gpu.vertex_count]));
                    gpu
                }
                None => self.upload(body),
            };
            self.bodies.push(gpu);
        }
        if self.body_uniforms.as_ref().is_none_or(|(_, _, n)| *n < self.bodies.len()) {
            let n = self.bodies.len().max(1).next_power_of_two();
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("viewport bodies"),
                size: self.body_stride * n as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("viewport bodies"),
                layout: &self.body_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &buffer,
                        offset: 0,
                        size: wgpu::BufferSize::new(std::mem::size_of::<BodyUniforms>() as u64),
                    }),
                }],
            });
            self.body_uniforms = Some((buffer, group, n));
        }
    }

    fn upload(&self, body: &super::scene::SceneBody) -> GpuBody {
        let init = |label, contents: &[u8], usage| {
            self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents, usage })
        };
        GpuBody {
            source: body.source.clone(),
            vertices: init("body vertices", bytemuck::cast_slice(&body.vertices), wgpu::BufferUsages::VERTEX),
            mask: init(
                "body mask",
                bytemuck::cast_slice(&vec![0f32; body.vertices.len().max(1)]),
                wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            ),
            vertex_count: body.vertices.len().max(1),
            indices: init("body indices", bytemuck::cast_slice(&body.indices), wgpu::BufferUsages::INDEX),
            index_count: body.indices.len() as u32,
        }
    }

    /// Uploads the stretch mask of one body, clearing the one before.
    fn set_mask(&mut self, body: usize, mask: &[f32], revision: u64) {
        if self.masked == Some((body, revision)) {
            return;
        }
        if let Some(gpu) = self.masked.and_then(|(b, _)| self.bodies.get(b)) {
            self.queue.write_buffer(&gpu.mask, 0, bytemuck::cast_slice(&vec![0f32; gpu.vertex_count]));
        }
        if let Some(gpu) = self.bodies.get(body).filter(|g| g.vertex_count == mask.len()) {
            self.queue.write_buffer(&gpu.mask, 0, bytemuck::cast_slice(mask));
            self.masked = Some((body, revision));
        }
    }

    fn ensure_targets(&mut self, size: Size<DevicePixels>) {
        if self.targets.as_ref().is_some_and(|t| t.size == size) {
            return;
        }
        let extent = wgpu::Extent3d {
            width: size.width.0.max(1) as u32,
            height: size.height.0.max(1) as u32,
            depth_or_array_layers: 1,
        };
        let make = |label, format, samples, usage| {
            self.device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: extent,
                    mip_level_count: 1,
                    sample_count: samples,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                })
                .create_view(&Default::default())
        };
        let targets = Targets {
            size,
            msaa: make("viewport msaa", self.format, SAMPLES, wgpu::TextureUsages::RENDER_ATTACHMENT),
            depth: make("viewport depth", DEPTH, SAMPLES, wgpu::TextureUsages::RENDER_ATTACHMENT),
            resolve: make(
                "viewport resolve",
                self.format,
                1,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            ),
        };
        self.texture_generation += 1;
        gpui_wgpu::register_external_texture(self.texture_index, targets.resolve.clone(), self.texture_generation);
        self.targets = Some(targets);
    }

    /// Draws a frame if anything changed since the last one and returns the texture index to paint.
    /// The submit lands on the shared queue before GPUI's own, so GPUI samples the finished frame.
    pub fn render(
        &mut self,
        scene: &Scene,
        camera: &Camera,
        overlay: &Overlay,
        mask: Option<&[f32]>,
        size: Size<DevicePixels>,
    ) -> u32 {
        self.ensure_targets(size);
        self.sync(scene);
        if let (Some((body, _)), Some(mask)) = (overlay.stretch, mask) {
            self.set_mask(body, mask, overlay.mask_revision);
        }
        let drawn = Drawn { camera: camera.clone(), size, scene_revision: scene.revision, overlay: overlay.clone() };
        if self.drawn.as_ref() == Some(&drawn) {
            return self.texture_index;
        }
        let aspect = size.width.0.max(1) as f32 / size.height.0.max(1) as f32;
        let uniforms = Uniforms {
            view_proj: (camera.projection(aspect) * camera.view()).to_cols_array_2d(),
            eye: camera.eye().extend(1.0).into(),
            encode_srgb: [if self.format.is_srgb() { 0.0 } else { 1.0 }; 4],
        };
        self.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&uniforms));
        if let Some((buffer, _, _)) = &self.body_uniforms {
            for i in 0..self.bodies.len() {
                let hover = match overlay.hover {
                    Some((b, face, pushable)) if b == i => [face as i32, pushable as i32, 0, 0],
                    _ => [-1, 0, 0, 0],
                };
                let offset = match overlay.stretch {
                    Some((b, offset)) if b == i => offset.extend(0.0).into(),
                    _ => [0.0; 4],
                };
                let u = BodyUniforms { offset, hover };
                self.queue.write_buffer(buffer, self.body_stride * i as u64, bytemuck::bytes_of(&u));
            }
        }

        let targets = self.targets.as_ref().expect("targets were just ensured");
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("viewport"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.msaa,
                    depth_slice: None,
                    resolve_target: Some(&targets.resolve),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(CLEAR), store: wgpu::StoreOp::Discard },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            if let Some((_, group, _)) = &self.body_uniforms {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                for (i, body) in self.bodies.iter().enumerate().filter(|(_, b)| b.index_count > 0) {
                    pass.set_bind_group(1, group, &[(self.body_stride * i as u64) as u32]);
                    pass.set_vertex_buffer(0, body.vertices.slice(..));
                    pass.set_vertex_buffer(1, body.mask.slice(..));
                    pass.set_index_buffer(body.indices.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..body.index_count, 0, 0..1);
                }
            }
        }
        self.queue.submit(Some(encoder.finish()));
        self.drawn = Some(drawn);
        self.texture_index
    }
}
