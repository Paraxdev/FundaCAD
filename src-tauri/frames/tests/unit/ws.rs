use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use fundacad_frames::{read_header, Authorize, FrameSource, Notes, Transport, WebSocketTransport, HEADER_BYTES};
use tungstenite::client::IntoClientRequest;
use tungstenite::Message;

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
