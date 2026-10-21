use crate::env::Environment;

use super::{bytes, storage, Tracer};

/// The map the trace pass samples and the tables it picks texels by. Without
/// an environment a black texel and a header saying 1 x 1, so the layout
/// never changes.
pub(super) struct EnvMap {
    pub texture: wgpu::TextureView,
    pub lights: wgpu::Buffer,
    /// What `lights` starts with, kept to copy over when the emitter table
    /// after them outgrows the buffer.
    pub tables: Vec<[f32; 4]>,
    pub held: Option<Environment>,
    /// The mean radiance's luminance over the sphere, before the brightness.
    pub mean: f32,
    /// The luminance irradiance on a face looking up, before the brightness.
    pub up: f32,
}

fn texture(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, rgba: &[u16]) -> wgpu::TextureView {
    let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
    let t = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("tracer-env"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        t.as_image_copy(),
        bytes(rgba),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 8), rows_per_image: Some(h) },
        size,
    );
    t.create_view(&Default::default())
}

impl EnvMap {
    pub(super) fn new(device: &wgpu::Device, queue: &wgpu::Queue, e: Option<Environment>) -> EnvMap {
        let Some(e) = e else {
            let lights = storage(device, 256, wgpu::BufferUsages::empty());
            let tables = vec![[1.0, 1.0, 8.0, 9.0], [0.0, 2.0, 0.0, 0.0]];
            queue.write_buffer(&lights, 0, bytes(&tables));
            return EnvMap { texture: texture(device, queue, 1, 1, &[0; 4]), lights, tables, held: None, mean: 0.0, up: 0.0 };
        };
        let tables = e.tables();
        let lights = storage(device, (tables.len() * 16).max(256) as u64, wgpu::BufferUsages::empty());
        queue.write_buffer(&lights, 0, bytes(&tables));
        EnvMap { texture: texture(device, queue, e.width, e.height, &e.rgba), lights, mean: tables[1][0], up: tables[1][2], tables, held: Some(e) }
    }
}

impl Tracer {
    /// What the page's room or HDR lights the scene with; none goes back to
    /// the look's sky gradient.
    pub fn set_environment(&mut self, e: Option<Environment>) {
        if e.is_some() && e == self.env.held {
            return;
        }
        self.env = EnvMap::new(&self.device, &self.queue, e);
        self.write_emitters();
        self.reset();
    }

    /// The key of the environment held, for a page to tell whether to send it.
    pub fn environment_key(&self) -> Option<&str> {
        self.env.held.as_ref().map(|e| e.key.as_str())
    }
}
