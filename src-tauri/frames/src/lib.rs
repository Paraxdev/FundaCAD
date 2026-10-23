//! Moves natively rendered frames into the webview: WebView2 shared buffers on Windows, a loopback WebSocket elsewhere.
//! Never Tauri IPC, which copies every byte through a stream at about 170 MB/s.

mod ring;
mod swap;
mod ws;

pub use ring::{FrameRing, Slot, SLOTS};
pub use swap::{Buffers, Current, Reopen};
pub use ws::{Authorize, Notes, WebSocketTransport, MAX_CONNECTIONS};

/// RGBA8.
pub const BYTES_PER_PIXEL: usize = 4;

/// Before each WebSocket frame's pixels: seq, generation, width, height, each
/// a little endian u32.
pub const HEADER_BYTES: usize = 16;

pub trait FrameSource: Send + Sync {
    /// `out` is exactly `width * height * BYTES_PER_PIXEL` bytes, rows top
    /// first with no padding.
    fn render(&self, out: &mut [u8], width: u32, height: u32, seq: u32);
}

pub trait Transport: Send + Sync {
    /// "sharedbuffer" or "websocket".
    fn kind(&self) -> &'static str;
    /// The frame size from now on. Returns the generation frames of that size
    /// carry; the page drops anything older.
    fn resize(&self, width: u32, height: u32) -> u32;
}

/// Each side of a frame. Larger asks are refused rather than allocated, three
/// 8192 square buffers are already 768 MB.
pub const MAX_SIDE: u32 = 8192;

/// A size the page asked for, at least one pixel a side.
pub fn frame_size(width: u32, height: u32) -> Result<(u32, u32), String> {
    if width > MAX_SIDE || height > MAX_SIDE {
        return Err(format!("a {width} x {height} frame is over the {MAX_SIDE} pixel side limit"));
    }
    Ok((width.max(1), height.max(1)))
}

pub fn frame_bytes(width: u32, height: u32) -> usize {
    width as usize * height as usize * BYTES_PER_PIXEL
}

pub fn write_header(out: &mut [u8], seq: u32, generation: u32, width: u32, height: u32) {
    for (i, v) in [seq, generation, width, height].into_iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
}

pub fn read_header(b: &[u8]) -> Option<[u32; 4]> {
    if b.len() < HEADER_BYTES {
        return None;
    }
    let w = |i: usize| u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
    Some([w(0), w(1), w(2), w(3)])
}
