use std::io;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::Message;

use crate::{frame_bytes, write_header, FrameSource, Transport, HEADER_BYTES};

/// Decides a handshake from its query string and Origin header. The app passes
/// fundacad_engine::ws::Gate (token plus Origin allow list).
pub type Authorize = Arc<dyn Fn(Option<&str>, Option<&str>) -> bool + Send + Sync>;

/// Receives the text after "note " that a page sends, its timings for the log.
pub type Notes = Arc<dyn Fn(&str) + Send + Sync>;

/// Every client is the app's own page, so a few sockets are plenty.
pub const MAX_CONNECTIONS: usize = 4;

// Also how often a connection thread looks at the stop flag.
const POLL: Duration = Duration::from_millis(500);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
struct Size {
    width: u32,
    height: u32,
    generation: u32,
}

struct Shared {
    size: Mutex<Size>,
    seq: AtomicU32,
    stop: AtomicBool,
    connections: AtomicUsize,
    source: Arc<dyn FrameSource>,
    authorize: Authorize,
    notes: Option<Notes>,
}

/// Frames over a loopback WebSocket. The page pulls: each text message "next"
/// is answered by one binary message, the header then the pixels, so the page
/// decides how many frames are in flight.
pub struct WebSocketTransport {
    shared: Arc<Shared>,
    addr: SocketAddr,
}

impl WebSocketTransport {
    pub fn start(
        source: Arc<dyn FrameSource>,
        authorize: Authorize,
        notes: Option<Notes>,
        width: u32,
        height: u32,
    ) -> io::Result<WebSocketTransport> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            size: Mutex::new(Size { width, height, generation: 1 }),
            seq: AtomicU32::new(0),
            stop: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            source,
            authorize,
            notes,
        });
        let s = shared.clone();
        std::thread::Builder::new().name("frames-ws".into()).spawn(move || accept_loop(listener, s))?;
        Ok(WebSocketTransport { shared, addr })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn generation(&self) -> u32 {
        self.shared.size.lock().unwrap().generation
    }
}

impl Transport for WebSocketTransport {
    fn kind(&self) -> &'static str {
        "websocket"
    }

    fn resize(&self, width: u32, height: u32) -> u32 {
        let mut s = self.shared.size.lock().unwrap();
        s.width = width;
        s.height = height;
        s.generation = s.generation.wrapping_add(1);
        s.generation
    }
}

impl Drop for WebSocketTransport {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        // accept() only returns on a connection.
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    for stream in listener.incoming() {
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        if shared.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let s = shared.clone();
        let spawned = std::thread::Builder::new().name("frames-ws-conn".into()).spawn(move || {
            serve(stream, &s);
            s.connections.fetch_sub(1, Ordering::SeqCst);
        });
        if spawned.is_err() {
            shared.connections.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn serve(stream: TcpStream, shared: &Shared) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let gate = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|o| o.to_str().ok());
        if (shared.authorize)(req.uri().query(), origin) {
            Ok(resp)
        } else {
            let mut e = ErrorResponse::new(None);
            *e.status_mut() = StatusCode::FORBIDDEN;
            Err(e)
        }
    };
    let Ok(mut ws) = tungstenite::accept_hdr(stream, gate) else { return };
    let _ = ws.get_ref().set_read_timeout(Some(POLL));
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Some(note) = t.strip_prefix("note ") {
                    if let Some(n) = &shared.notes {
                        n(note);
                    }
                } else if t.as_str() == "next" && ws.send(Message::Binary(frame(shared).into())).is_err() {
                    return;
                }
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) =>
            {
                if shared.stop.load(Ordering::SeqCst) {
                    let _ = ws.close(None);
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

fn frame(shared: &Shared) -> Vec<u8> {
    let size = *shared.size.lock().unwrap();
    let seq = shared.seq.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let mut out = vec![0u8; HEADER_BYTES + frame_bytes(size.width, size.height)];
    write_header(&mut out, seq, size.generation, size.width, size.height);
    shared.source.render(&mut out[HEADER_BYTES..], size.width, size.height, seq);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read_header;
    use tungstenite::client::IntoClientRequest;

    struct Stamp;
    impl FrameSource for Stamp {
        fn render(&self, out: &mut [u8], _w: u32, _h: u32, seq: u32) {
            for c in out.chunks_exact_mut(4) {
                c.copy_from_slice(&seq.to_le_bytes());
            }
        }
    }

    const TOKEN: &str = "s3cret";

    fn gate() -> Authorize {
        Arc::new(|query: Option<&str>, origin: Option<&str>| {
            let ok_token = query.unwrap_or("").split('&').any(|p| p == format!("token={TOKEN}"));
            ok_token && matches!(origin, None | Some("tauri://localhost") | Some("http://tauri.localhost"))
        })
    }

    fn start() -> WebSocketTransport {
        WebSocketTransport::start(Arc::new(Stamp), gate(), None, 64, 32).unwrap()
    }

    type Client = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

    fn connect(t: &WebSocketTransport, query: &str, origin: Option<&str>) -> Result<Client, u16> {
        let mut req = format!("ws://127.0.0.1:{}/{query}", t.port()).into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("origin", o.parse().unwrap());
        }
        match tungstenite::connect(req) {
            Ok((ws, _)) => Ok(ws),
            Err(tungstenite::Error::Http(r)) => Err(r.status().as_u16()),
            Err(e) => panic!("{e}"),
        }
    }

    fn next(ws: &mut Client) -> Vec<u8> {
        ws.send(Message::text("next")).unwrap();
        loop {
            if let Message::Binary(b) = ws.read().unwrap() {
                return b.to_vec();
            }
        }
    }

    #[test]
    fn binds_loopback_only() {
        assert!(start().local_addr().ip().is_loopback());
    }

    #[test]
    fn a_handshake_without_the_token_is_refused() {
        let t = start();
        assert_eq!(connect(&t, "", Some("tauri://localhost")).err(), Some(403));
        assert_eq!(connect(&t, "?token=wrong", None).err(), Some(403));
    }

    #[test]
    fn a_foreign_origin_is_refused_even_with_the_token() {
        let t = start();
        assert_eq!(connect(&t, &format!("?token={TOKEN}"), Some("https://evil.example")).err(), Some(403));
    }

    #[test]
    fn the_app_page_receives_stamped_frames_and_a_resize() {
        let t = start();
        let mut ws = connect(&t, &format!("?token={TOKEN}"), Some("tauri://localhost")).unwrap();
        let a = next(&mut ws);
        let [seq, g, w, h] = read_header(&a).unwrap();
        assert_eq!((w, h, g), (64, 32, 1));
        assert_eq!(a.len(), HEADER_BYTES + 64 * 32 * 4);
        assert!(a[HEADER_BYTES..].chunks_exact(4).all(|c| c == seq.to_le_bytes()));

        let g2 = t.resize(10, 8);
        let b = next(&mut ws);
        let [seq2, gb, wb, hb] = read_header(&b).unwrap();
        assert_eq!((wb, hb, gb), (10, 8, g2));
        assert_eq!(seq2, seq + 1);
        assert_eq!(b.len(), HEADER_BYTES + 10 * 8 * 4);
    }

    #[test]
    fn a_note_reaches_the_log_hook() {
        let got = Arc::new(Mutex::new(String::new()));
        let g = got.clone();
        let notes: Notes = Arc::new(move |s| *g.lock().unwrap() = s.to_string());
        let t = WebSocketTransport::start(Arc::new(Stamp), gate(), Some(notes), 4, 4).unwrap();
        let mut ws = connect(&t, &format!("?token={TOKEN}"), None).unwrap();
        ws.send(Message::text("note p50 9.5")).unwrap();
        // The frame reply orders the note before it on the server side.
        next(&mut ws);
        assert_eq!(got.lock().unwrap().as_str(), "p50 9.5");
    }
}
