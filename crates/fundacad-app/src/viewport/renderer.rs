use std::sync::Arc;

use gpui::{DevicePixels, Size};
use gpui_wgpu::{wgpu, WgpuContext};
use wgpu::util::DeviceExt;

use super::camera::Camera;
use super::mesh::Mesh;

const SAMPLES: u32 = 4;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    view_proj: [[f32; 4]; 4],
    eye: [f32; 4],
    encode_srgb: [f32; 4],
}

struct Targets {
    size: Size<DevicePixels>,
    msaa: wgpu::TextureView,
    depth: wgpu::TextureView,
    resolve: wgpu::TextureView,
}

struct GpuMesh {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    index_count: u32,
}

/// What the last frame was drawn from, to skip frames where nothing changed.
#[derive(PartialEq)]
struct Drawn {
    camera: Camera,
    size: Size<DevicePixels>,
    mesh_revision: u64,
    clear: [u8; 3],
}

/// Draws the scene into a texture on GPUI's device, which GPUI then composites like any element.
pub struct Renderer {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    mesh: Option<GpuMesh>,
    mesh_revision: u64,
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
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("viewport"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("viewport"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("viewport"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("viewport"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<super::mesh::Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3],
                })],
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
        Self {
            device,
            queue: context.queue.clone(),
            format,
            pipeline,
            uniforms,
            bind_group,
            mesh: None,
            mesh_revision: 0,
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

    pub fn set_mesh(&mut self, mesh: &Mesh) {
        self.mesh_revision += 1;
        if mesh.indices.is_empty() {
            self.mesh = None;
            return;
        }
        let vertices = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("mesh vertices"),
            contents: bytemuck::cast_slice(&mesh.vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let indices = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("mesh indices"),
            contents: bytemuck::cast_slice(&mesh.indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        self.mesh = Some(GpuMesh { vertices, indices, index_count: mesh.indices.len() as u32 });
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
    pub fn render(&mut self, camera: &Camera, size: Size<DevicePixels>, clear: [u8; 3]) -> u32 {
        self.ensure_targets(size);
        let drawn = Drawn { camera: camera.clone(), size, mesh_revision: self.mesh_revision, clear };
        if self.drawn.as_ref() == Some(&drawn) {
            return self.texture_index;
        }
        let aspect = size.width.0.max(1) as f32 / size.height.0.max(1) as f32;
        let eye = camera.eye();
        let uniforms = Uniforms {
            view_proj: (camera.projection(aspect) * camera.view()).to_cols_array_2d(),
            eye: eye.extend(1.0).into(),
            encode_srgb: [if self.format.is_srgb() { 0.0 } else { 1.0 }; 4],
        };
        self.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&uniforms));

        let targets = self.targets.as_ref().expect("targets were just ensured");
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("viewport"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.msaa,
                    depth_slice: None,
                    resolve_target: Some(&targets.resolve),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear_color(clear)),
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            if let Some(mesh) = &self.mesh {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.set_vertex_buffer(0, mesh.vertices.slice(..));
                pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..mesh.index_count, 0, 0..1);
            }
        }
        self.queue.submit(Some(encoder.finish()));
        self.drawn = Some(drawn);
        self.texture_index
    }
}

/// The view texture is not sRGB, so the theme's hex values pass through as they are.
fn clear_color([r, g, b]: [u8; 3]) -> wgpu::Color {
    wgpu::Color { r: r as f64 / 255.0, g: g as f64 / 255.0, b: b as f64 / 255.0, a: 1.0 }
}
