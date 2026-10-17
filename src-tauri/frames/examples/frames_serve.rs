//! The WebSocket transport alone, for e2e/frames_ws_e2e.cjs. Prints its port,
//! then every note a page sends. Usage: frames_serve <token> [width height]
use std::sync::Arc;

use fundacad_frames::{frame_bytes, FrameSource, Notes, WebSocketTransport};

struct Pattern(Vec<u8>);

impl FrameSource for Pattern {
    fn render(&self, out: &mut [u8], _w: u32, _h: u32, seq: u32) {
        out.copy_from_slice(&self.0[..out.len()]);
        let n = out.len();
        out[..4].copy_from_slice(&seq.to_le_bytes());
        out[n / 2..n / 2 + 4].copy_from_slice(&seq.to_le_bytes());
        out[n - 4..].copy_from_slice(&seq.to_le_bytes());
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let token = args.next().expect("usage: frames_serve <token> [width height]");
    let width: u32 = args.next().and_then(|a| a.parse().ok()).unwrap_or(1920);
    let height: u32 = args.next().and_then(|a| a.parse().ok()).unwrap_or(1080);
    let pattern = (0..frame_bytes(width, height)).map(|i| (i * 31 >> 3) as u8).collect();
    let authorize = Arc::new(move |query: Option<&str>, _origin: Option<&str>| {
        query.unwrap_or("").split('&').any(|p| p.strip_prefix("token=") == Some(token.as_str()))
    });
    let notes: Notes = Arc::new(|s| println!("NOTE {s}"));
    let t = WebSocketTransport::start(Arc::new(Pattern(pattern)), authorize, Some(notes), width, height)
        .expect("bind 127.0.0.1");
    println!("{}", t.port());
    loop {
        std::thread::park();
    }
}
