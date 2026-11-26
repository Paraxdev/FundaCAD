//! FUNDA_VIEW_DUMP=<file.png> saves the view's own texture once, with the blur in it, which GPUI's window capture does
//! not include. Behind the `shot` feature.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui_wgpu::wgpu;

pub struct Dump {
    path: PathBuf,
    started: Instant,
}

impl Dump {
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os("FUNDA_VIEW_DUMP")?.into();
        Some(Self { path, started: Instant::now() })
    }

    /// About two seconds in, or six when the model is still not there.
    pub fn due(&self, has_model: bool) -> bool {
        self.started.elapsed() >= Duration::from_secs(if has_model { 2 } else { 6 })
    }

    pub fn save(&self, device: &wgpu::Device, queue: &wgpu::Queue, view: &wgpu::TextureView, bgra: bool) {
        let texture = view.texture();
        let (w, h) = (texture.width(), texture.height());
        let row = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("view dump"),
            size: row as u64 * h as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) },
            },
            texture.size(),
        );
        queue.submit(Some(encoder.finish()));
        buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None });
        let mapped = buffer.slice(..).get_mapped_range().expect("the dump buffer was just mapped");
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for line in mapped.chunks(row as usize).take(h as usize) {
            for px in line[..w as usize * 4].chunks(4) {
                let (r, b) = if bgra { (px[2], px[0]) } else { (px[0], px[2]) };
                rgb.extend([r, px[1], b]);
            }
        }
        match std::fs::write(&self.path, png(w, h, &rgb)) {
            Ok(()) => log::info!("view dump {}", self.path.display()),
            Err(e) => log::error!("view dump {}: {e}", self.path.display()),
        }
    }
}

/// An uncompressed RGB PNG, to need no encoder.
fn png(w: u32, h: u32, rgb: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(rgb.len() + h as usize);
    for line in rgb.chunks(w as usize * 3) {
        raw.push(0);
        raw.extend(line);
    }
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, block) in blocks.iter().enumerate() {
        z.push((i + 1 == blocks.len()) as u8);
        z.extend((block.len() as u16).to_le_bytes());
        z.extend((!(block.len() as u16)).to_le_bytes());
        z.extend(*block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    z.extend(((b << 16) | a).to_be_bytes());

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        out.extend((data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend(data);
        let mut crc = !0u32;
        for &x in &body {
            crc ^= x as u32;
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320 & (crc & 1).wrapping_neg());
            }
        }
        out.extend(&body);
        out.extend((!crc).to_be_bytes());
    };
    let mut head = Vec::new();
    head.extend(w.to_be_bytes());
    head.extend(h.to_be_bytes());
    head.extend([8, 2, 0, 0, 0]);
    chunk(b"IHDR", &head);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}
