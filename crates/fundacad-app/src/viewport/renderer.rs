use std::sync::Arc;

#[cfg(test)]
#[path = "renderer_tests.rs"]
mod tests;

use glam::Vec3;
use gpui::{DevicePixels, Size};
use gpui_wgpu::{wgpu, WgpuContext};
use wgpu::util::DeviceExt;

use super::blur::{Blur, Chain, Panel};
use super::camera::Camera;
use super::scene::{Body, Scene, Vertex};

const SAMPLES: u32 = 4;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth24PlusStencil8;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    view_proj: [[f32; 4]; 4],
    eye: [f32; 4],
    encode_srgb: [f32; 4],
    /// xyz and w: the points p with xyz.p <= w are drawn. Off when xyz is zero.
    clip: [f32; 4],
    /// xyz: the build direction, w: the overhang threshold in degrees. Off when xyz is zero.
    shade: [f32; 4],
    /// x: the hatch pitch, y: the stripe width, both in device pixels.
    hatch: [f32; 4],
}

/// The cap quad on the plane `clip` over the box `min` to `max`, as its middle and half side.
pub(crate) fn cap_quad(clip: [f32; 4], min: Vec3, max: Vec3) -> [f32; 4] {
    let n = Vec3::new(clip[0], clip[1], clip[2]);
    if n.length_squared() == 0.0 || min.cmpgt(max).any() {
        return [0.0; 4];
    }
    let centre = (min + max) * 0.5;
    let on = centre - n * (n.dot(centre) - clip[3]) / n.length_squared();
    let half = (max - min).length() * 0.525 + 0.5 + (on - centre).length();
    [on.x, on.y, on.z, half]
}

/// Whether the plane `clip` runs through the box `min` to `max` or touches it.
pub(crate) fn straddles(clip: [f32; 4], min: Vec3, max: Vec3) -> bool {
    let n = Vec3::new(clip[0], clip[1], clip[2]);
    if n.length_squared() == 0.0 || min.cmpgt(max).any() {
        return false;
    }
    let reach = n.abs().dot((max - min) * 0.5);
    (n.dot((min + max) * 0.5) - clip[3]).abs() <= reach + 1e-4 * n.length() * clip[3].abs().max(1.0)
}

/// A body's box widened by the stretch that moves some of its vertices by `offset`.
pub(crate) fn stretched(bounds: (Vec3, Vec3), offset: Vec3) -> (Vec3, Vec3) {
    (bounds.0.min(bounds.0 + offset), bounds.1.max(bounds.1 + offset))
}

/// The cap of one body, off when the plane misses it.
pub(crate) fn body_cap(clip: Option<[f32; 4]>, bounds: (Vec3, Vec3)) -> [f32; 4] {
    match clip {
        Some(clip) if straddles(clip, bounds.0, bounds.1) => cap_quad(clip, bounds.0, bounds.1),
        _ => [0.0; 4],
    }
}

/// FundaCAD 1's hatch, a 9 px pitch and 2 px stripes at the given scale.
pub(crate) fn hatch(scale: f32) -> [f32; 4] {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    [9.0 * scale, 2.0 * scale, 0.0, 0.0]
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BodyUniforms {
    /// xyz: how far the masked vertices move.
    offset: [f32; 4],
    /// x: the hovered face or -1, y: 1 when that face can be pushed, z and w: the same for the face it fades out of.
    hover: [i32; 4],
    /// x: how far the hover has faded in, y: how much is left of the one fading out, z: how far the selection has
    /// gone from what was selected before to what is now.
    fade: [f32; 4],
    /// xyz: the middle of this body's section cap on the plane, w: half its side. Off when w is zero.
    cap: [f32; 4],
    /// x and y: whether the whole body was selected before and is now, 1 or 0.
    selected: [f32; 4],
}

/// What one frame shows beyond the scene.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Overlay {
    /// The hovered face and the one it left, by body, face, whether it can be pushed and how strongly it shows.
    pub hover: [Option<(usize, u32, bool, f32)>; 2],
    /// The body whose masked vertices move, and by how much.
    pub stretch: Option<(usize, Vec3)>,
    /// Bumped whenever the mask changes.
    pub mask_revision: u64,
    /// Bumped whenever what is selected changes.
    pub selection_revision: u64,
    pub selection_fade: f32,
    pub clip: Option<[f32; 4]>,
    pub shade: Option<[f32; 4]>,
}

/// A selected body by scene index, with the faces of it selected, None for the whole body.
pub type Selected = (usize, Option<Vec<u32>>);

struct Targets {
    size: Size<DevicePixels>,
    msaa: wgpu::TextureView,
    depth: wgpu::TextureView,
    resolve: wgpu::TextureView,
    blur: Chain,
}

struct GpuBody {
    source: Arc<Body>,
    vertices: wgpu::Buffer,
    mask: wgpu::Buffer,
    /// Per vertex, how selected it showed when the fade began and how selected it is now.
    selected: wgpu::Buffer,
    /// What `selected` holds as now.
    whole: [f32; 2],
    bounds: (Vec3, Vec3),
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
    background: [u8; 3],
    frost: Vec<Panel>,
    scale: f32,
}

/// Draws the scene into a texture on GPUI's device, which GPUI then composites like any element.
pub struct Renderer {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    count_pipeline: wgpu::RenderPipeline,
    cap_pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    body_layout: wgpu::BindGroupLayout,
    body_stride: u64,
    body_uniforms: Option<(wgpu::Buffer, wgpu::BindGroup, usize)>,
    bodies: Vec<GpuBody>,
    scene_revision: u64,
    masked: Option<(usize, u64)>,
    selected_revision: u64,
    /// Set by a rebuild, the new buffers need the selection written again.
    selected_stale: bool,
    selection: super::motion::selection::Blend,
    targets: Option<Targets>,
    texture_generation: u64,
    drawn: Option<Drawn>,
    context_generation: u64,
    texture_index: u32,
    background: [u8; 3],
    blur: Blur,
    frost: Vec<Panel>,
    scale: f32,
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
        let buffers = [
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
            Some(wgpu::VertexBufferLayout {
                array_stride: 8,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![4 => Float32x2],
            }),
        ];
        let make = |label, vs, fs, buffers: &[Option<wgpu::VertexBufferLayout>], depth, write_mask| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vs),
                    compilation_options: Default::default(),
                    buffers,
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: Some(depth),
                multisample: wgpu::MultisampleState { count: SAMPLES, ..Default::default() },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let depth = |write, compare, stencil| wgpu::DepthStencilState {
            format: DEPTH,
            depth_write_enabled: Some(write),
            depth_compare: Some(compare),
            stencil,
            bias: Default::default(),
        };
        let parity = |compare, op| {
            let face = wgpu::StencilFaceState { compare, fail_op: wgpu::StencilOperation::Keep, depth_fail_op: op, pass_op: op };
            wgpu::StencilState { front: face, back: face, read_mask: 1, write_mask: 1 }
        };
        let pipeline = make(
            "viewport",
            "vs",
            "fs",
            &buffers,
            depth(true, wgpu::CompareFunction::Less, Default::default()),
            wgpu::ColorWrites::ALL,
        );
        // Each clipped triangle over a sample flips its low bit, so the bit ends set where the plane runs inside the
        // body, however many shells it has.
        let count_pipeline = make(
            "viewport section count",
            "vs",
            "fs_count",
            &buffers,
            depth(false, wgpu::CompareFunction::Always, parity(wgpu::CompareFunction::Always, wgpu::StencilOperation::Invert)),
            wgpu::ColorWrites::empty(),
        );
        // The cap clears the bit it reads, so the next body counts from zero.
        let cap_pipeline = make(
            "viewport section cap",
            "vs_cap",
            "fs_cap",
            &[],
            depth(true, wgpu::CompareFunction::Less, parity(wgpu::CompareFunction::Equal, wgpu::StencilOperation::Zero)),
            wgpu::ColorWrites::ALL,
        );
        let align = device.limits().min_uniform_buffer_offset_alignment as u64;
        let body_stride = (std::mem::size_of::<BodyUniforms>() as u64).div_ceil(align) * align;
        Self {
            device,
            queue: context.queue.clone(),
            format,
            pipeline,
            count_pipeline,
            cap_pipeline,
            uniforms,
            bind_group,
            body_layout,
            body_stride,
            body_uniforms: None,
            bodies: Vec::new(),
            scene_revision: u64::MAX,
            masked: None,
            selected_revision: u64::MAX,
            selected_stale: true,
            selection: Default::default(),
            targets: None,
            texture_generation: 0,
            drawn: None,
            context_generation,
            texture_index,
            background: [23, 26, 31],
            blur: Blur::new(&context.device, context.queue.clone(), format),
            frost: Vec::new(),
            scale: 1.0,
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
        self.selected_stale = true;
        let mut old: Vec<Option<GpuBody>> = std::mem::take(&mut self.bodies).into_iter().map(Some).collect();
        for body in &scene.bodies {
            let kept = old.iter_mut().find(|o| o.as_ref().is_some_and(|o| Arc::ptr_eq(&o.source, &body.source)));
            let mut gpu = match kept.and_then(Option::take) {
                Some(gpu) => {
                    self.queue.write_buffer(&gpu.mask, 0, bytemuck::cast_slice(&vec![0f32; gpu.vertex_count]));
                    gpu
                }
                None => self.upload(body),
            };
            gpu.bounds = body.vertices.iter().fold((Vec3::INFINITY, Vec3::NEG_INFINITY), |(lo, hi), v| {
                let p = Vec3::from(v.position);
                (lo.min(p), hi.max(p))
            });
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
            selected: init(
                "body selection",
                bytemuck::cast_slice(&vec![0f32; body.vertices.len().max(1) * 2]),
                wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            ),
            whole: [0.0; 2],
            bounds: (Vec3::INFINITY, Vec3::NEG_INFINITY),
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

    fn set_selected(&mut self, scene: &Scene, selected: &[Selected], revision: u64) {
        let changed = self.selected_revision != revision;
        if !changed && !self.selected_stale {
            return;
        }
        if changed {
            let shown = self.drawn.as_ref().map_or(1.0, |d| d.overlay.selection_fade);
            // A rebuild that is not mid fade shows the selection at once, its face ids may have moved.
            self.selection.retarget(selected, shown, self.selected_stale && shown >= 1.0);
        } else if self.selection.to != super::motion::selection::Levels::of(selected) {
            // A rebuild can move a picked body to another scene index, or resolve a tool's armed picks, with no new
            // selection revision.
            self.selection.retarget(selected, 1.0, true);
        }
        self.selected_revision = revision;
        self.selected_stale = false;
        for (i, gpu) in self.bodies.iter_mut().enumerate() {
            let Some(body) = scene.bodies.get(i) else { continue };
            let mut pairs: Vec<[f32; 2]> = body.vertices.iter().map(|v| self.selection.pair(i, v.face)).collect();
            pairs.resize(gpu.vertex_count, [0.0; 2]);
            self.queue.write_buffer(&gpu.selected, 0, bytemuck::cast_slice(&pairs));
            gpu.whole = self.selection.whole(i);
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
        let resolve = make(
            "viewport resolve",
            self.format,
            1,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        );
        let targets = Targets {
            size,
            blur: self.blur.chain(&self.device, self.format, size, &resolve),
            msaa: make("viewport msaa", self.format, SAMPLES, wgpu::TextureUsages::RENDER_ATTACHMENT),
            depth: make("viewport depth", DEPTH, SAMPLES, wgpu::TextureUsages::RENDER_ATTACHMENT),
            resolve,
        };
        self.texture_generation += 1;
        gpui_wgpu::register_external_texture(self.texture_index, targets.resolve.clone(), self.texture_generation);
        self.targets = Some(targets);
    }

    /// Draws a frame if anything changed since the last one and returns the texture index to paint.
    /// The submit lands on the shared queue before GPUI's own, so GPUI samples the finished frame.
    /// The colour behind the model, as sRGB bytes.
    pub fn set_background(&mut self, rgb: [u8; 3]) {
        self.background = rgb;
    }

    /// The panels floating over the view in device pixels from its origin, and the scale they were measured at.
    pub fn set_frost(&mut self, panels: Vec<Panel>, scale: f32) {
        self.frost = panels;
        self.scale = scale;
    }

    fn clear(&self) -> wgpu::Color {
        let srgb = self.format.is_srgb();
        let c = |b: u8| {
            let v = b as f64 / 255.0;
            match srgb {
                false => v,
                true if v <= 0.04045 => v / 12.92,
                true => ((v + 0.055) / 1.055).powf(2.4),
            }
        };
        let [r, g, b] = self.background;
        wgpu::Color { r: c(r), g: c(g), b: c(b), a: 1.0 }
    }

    pub fn render(
        &mut self,
        scene: &Scene,
        camera: &Camera,
        overlay: &Overlay,
        mask: Option<&[f32]>,
        selected: &[Selected],
        size: Size<DevicePixels>,
    ) -> u32 {
        self.ensure_targets(size);
        self.sync(scene);
        self.set_selected(scene, selected, overlay.selection_revision);
        if let (Some((body, _)), Some(mask)) = (overlay.stretch, mask) {
            self.set_mask(body, mask, overlay.mask_revision);
        }
        let drawn = Drawn {
            camera: camera.clone(),
            size,
            scene_revision: scene.revision,
            overlay: overlay.clone(),
            background: self.background,
            frost: self.frost.clone(),
            scale: self.scale,
        };
        if self.drawn.as_ref() == Some(&drawn) {
            return self.texture_index;
        }
        let aspect = size.width.0.max(1) as f32 / size.height.0.max(1) as f32;
        let uniforms = Uniforms {
            view_proj: (camera.projection(aspect) * camera.view()).to_cols_array_2d(),
            eye: camera.eye().extend(1.0).into(),
            encode_srgb: [if self.format.is_srgb() { 0.0 } else { 1.0 }; 4],
            clip: overlay.clip.unwrap_or_default(),
            shade: overlay.shade.unwrap_or_default(),
            hatch: hatch(self.scale),
        };
        self.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&uniforms));
        let mut capped = vec![false; self.bodies.len()];
        if let Some((buffer, _, _)) = &self.body_uniforms {
            for (i, gpu) in self.bodies.iter().enumerate() {
                let (mut hover, mut fade) = ([-1, 0, -1, 0], [0.0, 0.0, overlay.selection_fade, 0.0]);
                for (slot, h) in overlay.hover.iter().enumerate() {
                    if let Some((_, face, pushable, a)) = h.filter(|h| h.0 == i) {
                        (hover[slot * 2], hover[slot * 2 + 1], fade[slot]) = (face as i32, pushable as i32, a);
                    }
                }
                let moved = match overlay.stretch {
                    Some((b, offset)) if b == i => offset,
                    _ => Vec3::ZERO,
                };
                let cap = body_cap(overlay.clip, stretched(gpu.bounds, moved));
                capped[i] = cap[3] > 0.0;
                let selected = [gpu.whole[0], gpu.whole[1], 0.0, 0.0];
                let u = BodyUniforms { offset: moved.extend(0.0).into(), hover, fade, cap, selected };
                self.queue.write_buffer(buffer, self.body_stride * i as u64, bytemuck::bytes_of(&u));
            }
        }

        let targets = self.targets.as_ref().expect("targets were just ensured");
        let clear = self.clear();
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("viewport"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.msaa,
                    depth_slice: None,
                    resolve_target: Some(&targets.resolve),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(clear), store: wgpu::StoreOp::Discard },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0), store: wgpu::StoreOp::Discard }),
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
                    pass.set_vertex_buffer(2, body.selected.slice(..));
                    pass.set_index_buffer(body.indices.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..body.index_count, 0, 0..1);
                }
                if capped.contains(&true) {
                    pass.set_stencil_reference(1);
                    for (i, body) in self.bodies.iter().enumerate().filter(|(i, b)| capped[*i] && b.index_count > 0) {
                        pass.set_pipeline(&self.count_pipeline);
                        pass.set_bind_group(1, group, &[(self.body_stride * i as u64) as u32]);
                        pass.set_vertex_buffer(0, body.vertices.slice(..));
                        pass.set_vertex_buffer(1, body.mask.slice(..));
                        pass.set_vertex_buffer(2, body.selected.slice(..));
                        pass.set_index_buffer(body.indices.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..body.index_count, 0, 0..1);
                        pass.set_pipeline(&self.cap_pipeline);
                        pass.draw(0..6, 0..1);
                    }
                }
            }
        }
        self.blur.run(&mut encoder, &targets.blur, &targets.resolve, size, &self.frost, self.scale);
        self.queue.submit(Some(encoder.finish()));
        self.drawn = Some(drawn);
        self.texture_index
    }
}
