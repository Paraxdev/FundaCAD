// Added by FundaCAD: render_to_image for a windowed wgpu renderer, so screenshots work on Vulkan and GL.

use super::{RendererState, WgpuRenderer};
use anyhow::Context as _;
use gpui::{DevicePixels, Scene, Size};

impl WgpuRenderer {
    /// Draws `scene` into an offscreen texture of the surface's format and size and reads it back.
    pub fn render_to_image(&mut self, scene: &Scene) -> anyhow::Result<image::RgbaImage> {
        let format = self.surface_config.format;
        let width = self.surface_config.width;
        let height = self.surface_config.height;
        let core = match &mut self.state {
            RendererState::Ready { core, .. } | RendererState::Unconfigured { core } => core,
            RendererState::Released => anyhow::bail!("the renderer was released"),
        };
        let device = core.resources.device.clone();
        let queue = core.resources.queue.clone();

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("fundacad_readback_target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let size = Size {
            width: DevicePixels(width as i32),
            height: DevicePixels(height as i32),
        };
        core.render_frame(scene, &view, size, wgpu::Color::TRANSPARENT)?;

        let bytes_per_row = width.checked_mul(4).context("readback row size overflowed")?;
        let padded_bytes_per_row = bytes_per_row
            .checked_next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            .context("readback padded row size overflowed")?;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("fundacad_readback_buffer"),
            size: u64::from(padded_bytes_per_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("fundacad_readback_encoder"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            texture.size(),
        );
        let submission = queue.submit(std::iter::once(encoder.finish()));
        let (sender, receiver) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(std::time::Duration::from_secs(30)),
            })
            .map_err(|error| anyhow::anyhow!("waiting for the readback failed: {error}"))?;
        receiver
            .recv_timeout(std::time::Duration::from_secs(30))
            .context("the readback mapping never answered")?
            .context("mapping the readback buffer failed")?;
        if let Some(error) = self
            .device_errors
            .observe_error(&mut self.observed_error_generation)
        {
            anyhow::bail!("GPU error during the readback: {error}");
        }

        let mapped = buffer.slice(..).get_mapped_range()?;
        let mut pixels = Vec::with_capacity(bytes_per_row as usize * height as usize);
        for row in mapped.chunks_exact(padded_bytes_per_row as usize) {
            pixels.extend_from_slice(&row[..bytes_per_row as usize]);
        }
        drop(mapped);
        buffer.unmap();
        match format {
            wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
            }
            wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => {}
            other => anyhow::bail!("readback of {other:?} is not supported"),
        }
        image::RgbaImage::from_raw(width, height, pixels).context("readback pixels do not fit the image")
    }
}
