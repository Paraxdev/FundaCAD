//! The WebSocket transport, for a browser, the e2e scripts and the Python
//! protocol suites (docs/ENGINE.md, section 2.1).
//!
//! Replaces the serving half of the Python engine's `server.py` (`main`, `handle`,
//! `_authorized`, `_mint_token`, `_ip_conns`): the same loopback address, port
//! variable, token and Origin gate, per address connection cap, close codes,
//! stdout readiness lines and port in use exit.
//!
//! tungstenite on one std thread per connection, no async runtime: the engine
//! already owns its job thread, a loopback server holds a handful of sockets,
//! and blocking writes of a 128 MiB frame are what a job's reply wants anyway.
//! A socket has one reader and many writers (job replies, progress, read path
//! answers), so the WebSocket sits behind a mutex. The reader waits for bytes
//! with `peek` outside the lock and parses them under it with the socket put
//! in non-blocking mode, so an idle connection never holds a writer back.

use crate::{Client, Engine, EngineOptions, Jobs, Outbox, Respawn};
use fundacad_protocol::{Message, MAX_FRAME};
use std::collections::{BTreeSet, HashMap};
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tungstenite::{Error as WsError, Message as WsMessage, WebSocket};

pub const HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 8765;

/// The exit code of a `--ws` engine whose port is taken, so a launcher can say
/// so rather than report a crash.
pub const EXIT_PORT_IN_USE: i32 = 3;

/// server.py `MAX_CONNS_PER_IP`. Every client is on 127.0.0.1, so in practice
/// this caps open sockets.
pub const MAX_CONNS_PER_IP: usize = 8;

/// A foreign Origin is refused even with the token; no Origin (a non-browser
/// client) is allowed.
pub const ALLOWED_ORIGINS: [&str; 5] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
];

/// Nothing supervises a `--ws` engine from outside, so a job that ignores a
/// cancel this long is abandoned by the engine itself, where server.py kills
/// its worker pool at once.
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

/// `FUNDACAD_<suffix>` or a retired spelling. An empty value is a value, not a
/// miss.
pub fn appenv(suffix: &str) -> Option<String> {
    ["FUNDACAD_", "SINDRI_", "SINDRICAD_"]
        .iter()
        .find_map(|p| std::env::var(format!("{p}{suffix}")).ok())
}

/// `FUNDACAD_ENGINE_<suffix>`, else the retired `FUNDACAD_SIDECAR_<suffix>`
/// from the Python engine, which a script or a shell profile may still set.
pub fn engine_env(suffix: &str) -> Option<String> {
    appenv(&format!("ENGINE_{suffix}")).or_else(|| appenv(&format!("SIDECAR_{suffix}")))
}

/// The token and Origin check every connection passes, server.py `_authorized`.
#[derive(Debug, Clone)]
pub struct Gate {
    token: String,
    origins: BTreeSet<String>,
}

impl Gate {
    /// `extra_origins` is the comma separated `FUNDACAD_EXTRA_ORIGINS`.
    pub fn new(token: impl Into<String>, extra_origins: &str) -> Gate {
        let mut origins: BTreeSet<String> = ALLOWED_ORIGINS.iter().map(|s| s.to_string()).collect();
        origins.extend(
            extra_origins
                .split(',')
                .filter(|o| !o.is_empty())
                .map(String::from),
        );
        Gate {
            token: token.into(),
            origins,
        }
    }

    pub fn authorized(&self, query: Option<&str>, origin: Option<&str>) -> bool {
        if self.token.is_empty() {
            return false;
        }
        let tok = query
            .and_then(|q| query_value(q, "token"))
            .unwrap_or_default();
        if !constant_time_eq(tok.as_bytes(), self.token.as_bytes()) {
            return false;
        }
        let origin = origin.unwrap_or("");
        if !origin.is_empty() && !self.origins.contains(origin) {
            let allowed: Vec<String> = self.origins.iter().map(|o| format!("'{o}'")).collect();
            eprintln!(
                "[auth] rejected WS handshake from origin '{origin}' (allowed: [{}])",
                allowed.join(", ")
            );
            return false;
        }
        true
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// The first non-empty value of `key`, decoded the way Python's `parse_qs` does.
fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (!v.is_empty() && form_decode(k) == key).then(|| form_decode(v))
    })
}

fn form_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len()
                && hex(bytes[i + 1]).is_some()
                && hex(bytes[i + 2]).is_some() =>
            {
                out.push(hex(bytes[i + 1]).unwrap_or(0) * 16 + hex(bytes[i + 2]).unwrap_or(0));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// A fresh token, the shape of Python's `secrets.token_urlsafe(32)`.
pub fn mint_token() -> io::Result<String> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|e| io::Error::other(e.to_string()))?;
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(43);
    for chunk in raw.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    Ok(out)
}

struct Shared {
    engine: Arc<Engine>,
    gate: Gate,
    conns: Mutex<HashMap<IpAddr, usize>>,
    max_message: usize,
    max_conns_per_ip: usize,
}

/// A bound WebSocket server, not yet accepting.
pub struct Server {
    listener: TcpListener,
    shared: Arc<Shared>,
}

struct Discard;

impl Outbox for Discard {
    fn send(&self, _msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        Ok(())
    }
}

impl Server {
    pub fn bind<J: Jobs>(jobs: J, addr: SocketAddr, gate: Gate) -> io::Result<Server> {
        Server::bind_with(jobs, None, EngineOptions::default(), addr, gate)
    }

    pub fn bind_with<J: Jobs>(
        jobs: J,
        respawn: Option<Respawn<J>>,
        opts: EngineOptions,
        addr: SocketAddr,
        gate: Gate,
    ) -> io::Result<Server> {
        let listener = TcpListener::bind(addr)?;
        let engine = Arc::new(Engine::start_with(jobs, respawn, opts, Arc::new(Discard)));
        Ok(Server {
            listener,
            shared: Arc::new(Shared {
                engine,
                gate,
                conns: Mutex::default(),
                max_message: MAX_FRAME,
                max_conns_per_ip: MAX_CONNS_PER_IP,
            }),
        })
    }

    /// A server for an engine that already has a transport, the app's stdio
    /// worker, whose clients then share the app's document and live session.
    pub fn for_engine(engine: Arc<Engine>, addr: SocketAddr, gate: Gate) -> io::Result<Server> {
        Ok(Server {
            listener: TcpListener::bind(addr)?,
            shared: Arc::new(Shared {
                engine,
                gate,
                conns: Mutex::default(),
                max_message: MAX_FRAME,
                max_conns_per_ip: MAX_CONNS_PER_IP,
            }),
        })
    }

    /// The largest message a client may send, closed with 1009 past it.
    pub fn with_max_message(mut self, bytes: usize) -> Server {
        if let Some(s) = Arc::get_mut(&mut self.shared) {
            s.max_message = bytes;
        }
        self
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// Accepts connections until the process ends.
    pub fn serve(self) {
        for stream in self.listener.incoming() {
            let Ok(stream) = stream else { continue };
            let shared = self.shared.clone();
            let spawned = std::thread::Builder::new()
                .name("ws-conn".into())
                .spawn(move || connection(stream, &shared));
            if let Err(e) = spawned {
                eprintln!("[ws] cannot start a connection thread: {e}");
            }
        }
    }
}

/// `fundacad-engine --ws`: the environment, the readiness lines and the exit
/// codes of the engine that serves its own socket.
pub fn run<J: Jobs + Default>(jobs: J) -> ! {
    let token = match engine_env("TOKEN").filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => match mint_token() {
            Ok(t) => {
                println!("TOKEN {t}");
                t
            }
            Err(e) => {
                eprintln!("FATAL: cannot mint a token: {e}");
                std::process::exit(1);
            }
        },
    };
    let port_text = engine_env("PORT").unwrap_or_else(|| DEFAULT_PORT.to_string());
    let Ok(port) = port_text.trim().parse::<u16>() else {
        eprintln!("FATAL: FUNDACAD_ENGINE_PORT is not a port: {port_text:?}");
        std::process::exit(1);
    };
    let gate = Gate::new(token, &appenv("EXTRA_ORIGINS").unwrap_or_default());
    let addr = SocketAddr::new(HOST.parse().expect("loopback literal"), port);
    let opts = EngineOptions {
        cancel_grace: Some(CANCEL_GRACE),
        ..EngineOptions::from_env()
    };
    let server = match Server::bind_with(jobs, Some(Arc::new(J::default)), opts, addr, gate) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("FATAL: cannot open port {port} on {HOST}");
            eprintln!("  bind failed: {e}");
            std::process::exit(EXIT_PORT_IN_USE);
        }
    };
    println!("LISTENING {port}");
    let _ = io::stdout().flush();
    server.serve();
    std::process::exit(0)
}

/// Gives a connection's slot back however the connection ends.
struct Slot<'a> {
    shared: &'a Shared,
    ip: IpAddr,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut conns = self.shared.conns.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(n) = conns.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                conns.remove(&self.ip);
            }
        }
    }
}

fn take_slot<'a>(shared: &'a Shared, ip: IpAddr) -> Option<Slot<'a>> {
    let mut conns = shared.conns.lock().unwrap_or_else(|p| p.into_inner());
    let n = conns.entry(ip).or_insert(0);
    if *n >= shared.max_conns_per_ip {
        return None;
    }
    *n += 1;
    Some(Slot { shared, ip })
}

type Socket = WebSocket<TcpStream>;

struct WsOut(Arc<Mutex<Socket>>);

impl Outbox for WsOut {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        let mut ws = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for m in msgs {
            let m = match m {
                Message::Text(t) => WsMessage::text(t),
                Message::Binary(b) => WsMessage::binary(b),
            };
            ws.send(m).map_err(to_io)?;
        }
        Ok(())
    }
}

fn to_io(e: WsError) -> io::Error {
    match e {
        WsError::Io(e) => e,
        other => io::Error::other(other.to_string()),
    }
}

// The handshake callback's error type is tungstenite's, not ours to shrink.
#[allow(clippy::result_large_err)]
fn connection(stream: TcpStream, shared: &Shared) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let peer = stream.peer_addr().ok().map(|a| a.ip());
    let slot = peer.map(|ip| take_slot(shared, ip));

    let seen: Arc<Mutex<(Option<String>, Option<String>)>> = Arc::default();
    let seen_cb = seen.clone();
    let config = WebSocketConfig::default()
        .max_message_size(Some(shared.max_message))
        .max_frame_size(Some(shared.max_message));
    let callback = move |req: &tungstenite::handshake::server::Request,
                         resp: tungstenite::handshake::server::Response| {
        let origin = req
            .headers()
            .get("origin")
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
        *seen_cb.lock().unwrap_or_else(|p| p.into_inner()) =
            (req.uri().query().map(String::from), origin);
        Ok(resp)
    };
    let Ok(mut ws) = tungstenite::accept_hdr_with_config(stream, callback, Some(config)) else {
        return;
    };

    if matches!(slot, Some(None)) {
        close_and_linger(&mut ws, CloseCode::Policy, "too many connections");
        return;
    }
    let (query, origin) = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if !shared.gate.authorized(query.as_deref(), origin.as_deref()) {
        close_and_linger(&mut ws, CloseCode::Policy, "unauthorized");
        return;
    }
    let _ = ws.get_ref().set_read_timeout(None);
    let Ok(waiter) = ws.get_ref().try_clone() else {
        return;
    };

    let ws = Arc::new(Mutex::new(ws));
    let client = shared.engine.client(Arc::new(WsOut(ws.clone())));
    serve_connection(&ws, &waiter, &client);
    drop(client);
}

enum ReadState {
    More,
    Done,
    TooBig,
}

fn serve_connection(ws: &Arc<Mutex<Socket>>, waiter: &TcpStream, client: &Client) {
    let mut probe = [0u8; 1];
    loop {
        if let Err(e) = waiter.peek(&mut probe) {
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        let mut incoming = Vec::new();
        let state = {
            let mut sock = ws.lock().unwrap_or_else(|p| p.into_inner());
            if sock.get_ref().set_nonblocking(true).is_err() {
                return;
            }
            let state = drain(&mut sock, &mut incoming);
            let _ = sock.get_ref().set_nonblocking(false);
            match state {
                ReadState::TooBig => {
                    close_and_linger(&mut sock, CloseCode::Size, "message too big");
                }
                _ => {
                    let _ = sock.flush();
                }
            }
            state
        };
        for msg in incoming {
            client.handle(msg);
        }
        match state {
            ReadState::More => {}
            ReadState::Done | ReadState::TooBig => return,
        }
    }
}

/// Every message the socket has ready without blocking.
fn drain(sock: &mut Socket, into: &mut Vec<Message>) -> ReadState {
    loop {
        match sock.read() {
            Ok(WsMessage::Text(t)) => into.push(Message::Text(t.as_str().to_owned())),
            Ok(WsMessage::Binary(b)) => into.push(Message::Binary(b.to_vec())),
            Ok(_) => {}
            Err(WsError::Io(e)) if e.kind() == io::ErrorKind::WouldBlock => return ReadState::More,
            Err(WsError::Capacity(_)) => return ReadState::TooBig,
            Err(_) => return ReadState::Done,
        }
    }
}

/// Sends a close frame and waits for the client to hang up. Dropping a socket
/// with unread bytes resets it, and a reset can reach the client before the
/// close frame is read, which would hide the close code.
fn close_and_linger(sock: &mut Socket, code: CloseCode, reason: &'static str) {
    let _ = sock.close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }));
    let _ = sock.flush();
    let stream = sock.get_mut();
    let deadline = Instant::now() + CLOSE_TIMEOUT;
    let mut buf = [0u8; 64 * 1024];
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            break;
        }
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

#[cfg(test)]
mod tests;
