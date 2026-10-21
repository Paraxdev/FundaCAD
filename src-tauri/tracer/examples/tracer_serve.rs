//! The native tracer without the app, for browser scripts: the page's
//! `?tracer=native-dev&port=P&token=T`, the e2e, and later the gap harness.
//! Frames go over the same loopback WebSocket transport as in the app; the
//! pt_* and frames_* commands the app takes through Tauri come over a second,
//! command socket behind the same token and Origin rules as the engine's.
//!
//! Usage: tracer_serve <token> [--port N]. Prints `LISTENING <port>`, port 0
//! (the default) picks a free one. Exits when its stdin closes, so a script
//! that spawns it with a piped stdin never leaves it running. Started with
//! stdin from /dev/null, under nohup or as a shell background job it exits at
//! once: spawn it with a piped stdin, as e2e/pathtrace_bloom_e2e.cjs does.
//!
//! The command socket: a text message is `{"id","cmd","args"}`, a binary one
//! (pt_mesh, pt_colors) is `[u32 LE id][u16 LE cmd length][cmd][raw body]`.
//! Every request is answered by `{"id","ok":true,"value"}` or
//! `{"id","ok":false,"error"}`. The commands mirror src-tauri/src/frames.rs
//! and src-tauri/src/frames/tracer.rs, a new one there needs adding here.

use std::io::{self, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use fundacad_engine::ws::{appenv, mint_token, Gate};
use fundacad_frames::{frame_size, Current, FrameSource, Notes, Reopen, Transport, WebSocketTransport};
use fundacad_tracer::{
    decode_colors, decode_env, decode_mesh, denoise, oidn, Bloom, BodyDesc, Camera, Denoiser, Look, Path, Quality, Tracer,
    TracerOptions,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::Message;

/// GPU time per frame, as in the app.
const TRACE_BUDGET: Duration = Duration::from_millis(12);
const MAX_CONNECTIONS: usize = 4;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The largest pt_mesh body the app's page sends is a few tens of MB.
const MAX_MESSAGE: usize = 512 << 20;

struct State {
    tracer: Tracer,
    fault: Option<String>,
    /// The seq of the last frame drawn, which pt_camera answers so the page
    /// can tell which camera a frame was traced with.
    drawn: u32,
}

struct TracerSource(Mutex<State>);

impl TracerSource {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn name(&self) -> String {
        let s = self.lock();
        let path = match s.tracer.path() {
            Path::RayQuery => "ray query",
            Path::Software => "software",
        };
        format!("tracer, {path}, {}", s.tracer.adapter())
    }
}

impl FrameSource for TracerSource {
    fn render(&self, out: &mut [u8], width: u32, height: u32, seq: u32) {
        let mut s = self.lock();
        s.drawn = seq;
        if s.fault.is_some() {
            out.fill(0);
            return;
        }
        match catch_unwind(AssertUnwindSafe(|| s.tracer.frame(width, height, TRACE_BUDGET))) {
            Ok(px) if px.len() == out.len() => out.copy_from_slice(&px),
            Ok(px) => {
                s.fault = Some(format!("a {} byte frame for a {} byte slot", px.len(), out.len()));
                out.fill(0);
            }
            Err(e) => {
                let why = e
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "the tracer panicked".into());
                eprintln!("[tracer_serve] tracer fault: {why}");
                s.fault = Some(why);
                out.fill(0);
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    samples: u32,
    generation: u64,
    band: u32,
    path: &'static str,
    adapter: String,
    fault: Option<String>,
    denoised: bool,
    denoising: bool,
    denoiser: Option<Denoiser>,
    denoise_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    available: bool,
    path: Option<&'static str>,
    adapter: Option<String>,
    denoise: bool,
    denoiser: Option<Denoiser>,
    reason: Option<String>,
}

fn path_id(p: Path) -> &'static str {
    match p {
        Path::RayQuery => "rayquery",
        Path::Software => "software",
    }
}

/// One tracer and at most one frame transport, as the app holds them.
#[derive(Default)]
struct Dev {
    tracer: Reopen<TracerSource>,
    open: Current<WebSocketTransport>,
    life: Mutex<()>,
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{key}: {e}"))
}

fn to_value<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

impl Dev {
    fn life(&self) -> MutexGuard<'_, ()> {
        self.life.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// FUNDACAD_TRACER=software keeps the BVH path on a ray query adapter.
    fn tracer(&self) -> Result<Arc<TracerSource>, String> {
        self.tracer.get(|| {
            let mode = std::env::var("FUNDACAD_TRACER").unwrap_or_default();
            if mode == "off" {
                return Err("the native tracer is off (FUNDACAD_TRACER=off)".into());
            }
            let opts = TracerOptions { software: mode == "software", ..Default::default() };
            Tracer::new(opts).map(|tracer| TracerSource(Mutex::new(State { tracer, fault: None, drawn: 0 }))).map_err(|e| e.to_string())
        })
    }

    fn with<T>(&self, f: impl FnOnce(&mut Tracer) -> T) -> Result<T, String> {
        self.with_state(|s| f(&mut s.tracer))
    }

    fn with_state<T>(&self, f: impl FnOnce(&mut State) -> T) -> Result<T, String> {
        let t = self.tracer.current().ok_or("the native tracer is not open")?;
        let mut s = t.lock();
        if let Some(f) = &s.fault {
            return Err(format!("the native tracer stopped: {f}"));
        }
        Ok(f(&mut *s))
    }

    fn dispatch(&self, cmd: &str, args: &Value, body: Option<&[u8]>) -> Result<Value, String> {
        let raw = || body.ok_or_else(|| format!("{cmd} takes raw bytes"));
        match cmd {
            "frames_open" => self.frames_open(arg(args, "width")?, arg(args, "height")?),
            "frames_resize" => {
                let (w, h) = frame_size(arg(args, "width")?, arg(args, "height")?)?;
                self.open.with(|o| o.map(|t| json!(t.resize(w, h))).ok_or_else(|| "no frame transport is open".into()))
            }
            "frames_close" => {
                let id: u64 = arg(args, "id")?;
                let _life = self.life();
                if let Some(t) = self.open.take_if(id) {
                    drop(t);
                    drop(self.tracer.release());
                }
                Ok(Value::Null)
            }
            "pt_probe" => to_value(self.probe()),
            "pt_scene" => {
                let bodies: Vec<BodyDesc> = arg(args, "bodies")?;
                to_value(self.with(|t| t.set_bodies(bodies))?)
            }
            "pt_mesh" => {
                let (key, mesh) = decode_mesh(raw()?)?;
                self.with(|t| t.add_mesh(&key, mesh)).map(|_| Value::Null)
            }
            "pt_env" => {
                let e = decode_env(raw()?)?;
                self.with(|t| t.set_environment(e)).map(|_| Value::Null)
            }
            "pt_colors" => {
                let (key, colors) = decode_colors(raw()?)?;
                to_value(self.with(|t| t.set_colors(&key, colors))?)
            }
            "pt_camera" => {
                let c: Camera = arg(args, "camera")?;
                self.with_state(|s| {
                    s.tracer.set_camera(c);
                    s.drawn
                })
                .map(Value::from)
            }
            "pt_look" => {
                let l: Look = arg(args, "look")?;
                to_value(self.with(|t| {
                    t.set_look(l);
                    t.environment_key().map(String::from)
                })?)
            }
            "pt_cap" => {
                let cap: u32 = arg(args, "cap")?;
                self.with(|t| t.set_cap(cap)).map(|_| Value::Null)
            }
            "pt_denoise" => {
                let q: Quality = arg(args, "level")?;
                self.with(|t| t.set_denoise(q)).map(|_| Value::Null)
            }
            "pt_bloom" => {
                let b: Option<Bloom> = arg(args, "bloom")?;
                self.with(|t| t.set_bloom(b)).map(|_| Value::Null)
            }
            "pt_budget" => {
                let paths: u32 = arg(args, "paths")?;
                self.with(|t| t.set_frame_budget(paths)).map(|_| Value::Null)
            }
            "pt_status" => to_value(self.status()?),
            "pt_denoiser" => Ok(json!({
                "active": denoise::active(),
                "version": oidn::VERSION,
                "offered": false,
                "bytes": 0,
                "note": if oidn::api().is_some() { None } else { Some("set FUNDACAD_OIDN_DIR to an unpacked set") },
            })),
            _ => Err(format!("tracer_serve has no command {cmd}")),
        }
    }

    fn frames_open(&self, width: u32, height: u32) -> Result<Value, String> {
        let (width, height) = frame_size(width, height)?;
        let _life = self.life();
        drop(self.open.take());
        let src = self.tracer()?;
        // A new transport counts its frames from 1.
        src.lock().drawn = 0;
        let source = src.name();
        let token = mint_token().map_err(|e| e.to_string())?;
        let gate = Gate::new(token.clone(), &appenv("EXTRA_ORIGINS").unwrap_or_default());
        let authorize: fundacad_frames::Authorize = Arc::new(move |q, o| gate.authorized(q, o));
        let notes: Notes = Arc::new(|s| eprintln!("[frames] {s}"));
        let t = WebSocketTransport::start(src, authorize, Some(notes), width, height).map_err(|e| e.to_string())?;
        let (generation, port) = (t.generation(), t.port());
        let (id, displaced) = self.open.replace(t);
        drop(displaced);
        Ok(json!({ "id": id, "kind": "websocket", "generation": generation, "port": port, "token": token, "source": source }))
    }

    /// A tracer made only to answer is released again.
    fn probe(&self) -> Probe {
        let _life = self.life();
        let was_open = self.tracer.current().is_some();
        let probe = match self.tracer() {
            Ok(t) => {
                let s = t.lock();
                Probe {
                    available: true,
                    path: Some(path_id(s.tracer.path())),
                    adapter: Some(s.tracer.adapter().to_string()),
                    denoise: true,
                    denoiser: Some(denoise::active()),
                    reason: None,
                }
            }
            Err(e) => Probe { available: false, path: None, adapter: None, denoise: false, denoiser: None, reason: Some(e) },
        };
        if !was_open {
            drop(self.tracer.release());
        }
        probe
    }

    fn status(&self) -> Result<Status, String> {
        let t = self.tracer.current().ok_or("the native tracer is not open")?;
        let mut s = t.lock();
        s.tracer.poll_denoise();
        Ok(Status {
            samples: s.tracer.samples(),
            generation: s.tracer.generation(),
            band: s.tracer.band(),
            path: path_id(s.tracer.path()),
            adapter: s.tracer.adapter().to_string(),
            fault: s.fault.clone(),
            denoised: s.tracer.denoised(),
            denoising: s.tracer.denoising(),
            denoiser: s.tracer.denoised_by(),
            denoise_error: s.tracer.denoise_error().map(str::to_string),
        })
    }

    /// One request in, its reply out.
    fn answer(&self, msg: &Message) -> Option<String> {
        let (id, cmd, args, body) = match msg {
            Message::Text(t) => match serde_json::from_str::<Value>(t.as_str()) {
                Ok(v) => {
                    let cmd = v.get("cmd").and_then(Value::as_str).unwrap_or_default().to_string();
                    (v.get("id").cloned().unwrap_or(Value::Null), cmd, v.get("args").cloned().unwrap_or(json!({})), None)
                }
                Err(e) => return Some(reply(Value::Null, Err(format!("not a request: {e}")))),
            },
            Message::Binary(b) => match decode_binary(b) {
                Ok((id, cmd, body)) => (json!(id), cmd.to_string(), json!({}), Some(body)),
                Err(e) => return Some(reply(Value::Null, Err(e))),
            },
            _ => return None,
        };
        Some(reply(id, self.dispatch(&cmd, &args, body)))
    }
}

fn reply(id: Value, r: Result<Value, String>) -> String {
    match r {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    }
    .to_string()
}

fn decode_binary(b: &[u8]) -> Result<(u32, &str, &[u8]), String> {
    let short = || format!("a {} byte request is shorter than its header", b.len());
    let id = u32::from_le_bytes(b.get(0..4).ok_or_else(short)?.try_into().unwrap());
    let n = u16::from_le_bytes(b.get(4..6).ok_or_else(short)?.try_into().unwrap()) as usize;
    let cmd = std::str::from_utf8(b.get(6..6 + n).ok_or_else(short)?).map_err(|e| e.to_string())?;
    Ok((id, cmd, &b[6 + n..]))
}

struct Server {
    listener: TcpListener,
    dev: Arc<Dev>,
    gate: Arc<Gate>,
    connections: Arc<AtomicUsize>,
}

impl Server {
    fn bind(token: &str, port: u16) -> io::Result<Server> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))?;
        let gate = Gate::new(token, &appenv("EXTRA_ORIGINS").unwrap_or_default());
        Ok(Server { listener, dev: Arc::default(), gate: Arc::new(gate), connections: Arc::default() })
    }

    fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    fn serve(self) {
        for stream in self.listener.incoming() {
            let Ok(stream) = stream else { continue };
            if self.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                self.connections.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let (dev, gate, n) = (self.dev.clone(), self.gate.clone(), self.connections.clone());
            let spawned = std::thread::Builder::new().name("tracer-serve-conn".into()).spawn(move || {
                connection(stream, &dev, &gate);
                n.fetch_sub(1, Ordering::SeqCst);
            });
            if spawned.is_err() {
                self.connections.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
}

// The handshake callback's error type is tungstenite's, not ours to shrink.
#[allow(clippy::result_large_err)]
fn connection(stream: TcpStream, dev: &Dev, gate: &Gate) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|o| o.to_str().ok());
        if gate.authorized(req.uri().query(), origin) {
            Ok(resp)
        } else {
            let mut e = ErrorResponse::new(None);
            *e.status_mut() = StatusCode::FORBIDDEN;
            Err(e)
        }
    };
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let Ok(mut ws) = tungstenite::accept_hdr_with_config(stream, check, Some(config)) else { return };
    let _ = ws.get_ref().set_read_timeout(None);
    loop {
        match ws.read() {
            Ok(Message::Close(_)) | Err(_) => return,
            Ok(m) => {
                if let Some(r) = dev.answer(&m) {
                    if ws.send(Message::text(r)).is_err() {
                        return;
                    }
                }
            }
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: tracer_serve <token> [--port N]\nruns until its stdin closes, so spawn it with a piped stdin, not /dev/null";
    let token = args.next().filter(|t| !t.starts_with("--")).unwrap_or_else(|| {
        eprintln!("{usage}");
        std::process::exit(2);
    });
    let mut port = 0u16;
    while let Some(a) = args.next() {
        match (a.as_str(), args.next().and_then(|p| p.parse().ok())) {
            ("--port", Some(p)) => port = p,
            _ => {
                eprintln!("{usage}");
                std::process::exit(2);
            }
        }
    }
    if let Some(dir) = appenv("OIDN_DIR") {
        if let Err(e) = oidn::load(std::path::Path::new(&dir)) {
            eprintln!("[tracer_serve] no Open Image Denoise from {dir}: {e}");
        }
    }
    let server = Server::bind(&token, port).unwrap_or_else(|e| {
        eprintln!("[tracer_serve] cannot listen on 127.0.0.1:{port}: {e}");
        std::process::exit(3);
    });
    println!("LISTENING {}", server.port());
    std::thread::spawn(move || server.serve());
    let _ = io::stdin().lock().read_to_end(&mut Vec::new());
    eprintln!("[tracer_serve] stdin closed, exiting (it needs a piped stdin to keep running)");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::client::IntoClientRequest;
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::WebSocket;

    type Client = WebSocket<MaybeTlsStream<TcpStream>>;

    fn start() -> u16 {
        let s = Server::bind("tok", 0).unwrap();
        let port = s.port();
        std::thread::spawn(move || s.serve());
        port
    }

    fn connect(port: u16, token: &str, origin: Option<&str>) -> Result<Client, tungstenite::Error> {
        let mut req = format!("ws://127.0.0.1:{port}/?token={token}").into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("origin", o.parse().unwrap());
        }
        tungstenite::connect(req).map(|(ws, _)| ws)
    }

    fn refused_with(r: Result<Client, tungstenite::Error>) -> Option<u16> {
        match r {
            Err(tungstenite::Error::Http(resp)) => Some(resp.status().as_u16()),
            _ => None,
        }
    }

    fn ask(ws: &mut Client, msg: Message) -> Value {
        ws.send(msg).unwrap();
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    }

    fn call(ws: &mut Client, id: u32, cmd: &str, args: Value) -> Value {
        let r = ask(ws, Message::text(json!({ "id": id, "cmd": cmd, "args": args }).to_string()));
        assert_eq!(r["id"], json!(id), "{r}");
        r
    }

    fn binary(id: u32, cmd: &str, body: &[u8]) -> Vec<u8> {
        let mut b = id.to_le_bytes().to_vec();
        b.extend_from_slice(&(cmd.len() as u16).to_le_bytes());
        b.extend_from_slice(cmd.as_bytes());
        b.extend_from_slice(body);
        b
    }

    #[test]
    fn the_command_socket_takes_the_token_and_the_engines_origins_only() {
        let port = start();
        assert_eq!(refused_with(connect(port, "nope", None)), Some(403));
        assert_eq!(refused_with(connect(port, "tok", Some("https://evil.example"))), Some(403));
        connect(port, "tok", Some("http://localhost:5173")).unwrap();
        connect(port, "tok", None).unwrap();
    }

    #[test]
    fn a_binary_request_carries_its_id_command_and_raw_body() {
        let b = binary(7, "pt_mesh", &[1, 2, 3]);
        assert_eq!(decode_binary(&b), Ok((7, "pt_mesh", &[1u8, 2, 3][..])));
        assert!(decode_binary(&b[..5]).is_err());
        assert!(decode_binary(&binary(1, "pt_colors", &[])[..8]).is_err());
    }

    #[test]
    fn scene_calls_before_frames_open_and_unknown_commands_answer_errors() {
        let port = start();
        let mut ws = connect(port, "tok", None).unwrap();
        let r = call(&mut ws, 1, "pt_scene", json!({ "bodies": [] }));
        assert_eq!((r["ok"].clone(), r["error"].clone()), (json!(false), json!("the native tracer is not open")));
        let r = ask(&mut ws, Message::binary(binary(2, "pt_colors", b"\0\0\0\0")));
        assert_eq!(r["id"], json!(2));
        assert_eq!(r["ok"], json!(false));
        let r = call(&mut ws, 3, "pt_selfie", json!({}));
        assert_eq!(r["error"], json!("tracer_serve has no command pt_selfie"));
        let r = call(&mut ws, 4, "frames_resize", json!({ "width": 8, "height": 8 }));
        assert_eq!(r["error"], json!("no frame transport is open"));
        let r = ask(&mut ws, Message::text("{"));
        assert_eq!((r["id"].clone(), r["ok"].clone()), (Value::Null, json!(false)));
    }

    fn frame_header(port: u64, token: &str) -> [u32; 4] {
        let (mut f, _) = tungstenite::connect(format!("ws://127.0.0.1:{port}/?token={token}")).unwrap();
        f.send(Message::text("next")).unwrap();
        loop {
            if let Message::Binary(b) = f.read().unwrap() {
                return fundacad_frames::read_header(&b).unwrap();
            }
        }
    }

    #[test]
    fn pt_camera_answers_the_seq_of_the_last_frame_drawn_before_it() {
        let port = start();
        let mut ws = connect(port, "tok", None).unwrap();
        let p = call(&mut ws, 1, "pt_probe", json!({}));
        if p["value"]["available"] != json!(true) {
            eprintln!("skipped: no adapter ({})", p["value"]["reason"]);
            return;
        }
        let o = call(&mut ws, 2, "frames_open", json!({ "width": 8, "height": 8, "prefer": "websocket" }));
        let o = &o["value"];
        let (fport, ftoken) = (o["port"].as_u64().unwrap(), o["token"].as_str().unwrap().to_string());
        let cam = |x: f32| json!({ "camera": { "eye": [x, -6.0, 3.0], "target": [0.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0], "fov": 50.0 } });
        assert_eq!(call(&mut ws, 3, "pt_camera", cam(4.0))["value"], json!(0));
        let [seq, ..] = frame_header(fport, &ftoken);
        assert_eq!(call(&mut ws, 4, "pt_camera", cam(5.0))["value"], json!(seq));
        let [seq2, ..] = frame_header(fport, &ftoken);
        assert_eq!(seq2, seq + 1);
        assert_eq!(call(&mut ws, 5, "pt_camera", cam(6.0))["value"], json!(seq2));
        call(&mut ws, 6, "frames_close", json!({ "id": o["id"] }));
    }

    #[test]
    fn frames_open_streams_frames_of_its_size_resize_bumps_the_generation_and_close_releases() {
        let port = start();
        let mut ws = connect(port, "tok", None).unwrap();
        let p = call(&mut ws, 1, "pt_probe", json!({}));
        if p["value"]["available"] != json!(true) {
            eprintln!("skipped: no adapter ({})", p["value"]["reason"]);
            return;
        }
        let o = call(&mut ws, 2, "frames_open", json!({ "width": 32, "height": 16, "prefer": "websocket" }));
        assert_eq!(o["ok"], json!(true), "{o}");
        let o = &o["value"];
        assert_eq!(o["kind"], json!("websocket"));
        assert!(o["source"].as_str().unwrap().starts_with("tracer, "), "{o}");
        let (fport, ftoken) = (o["port"].as_u64().unwrap(), o["token"].as_str().unwrap().to_string());
        assert_ne!(ftoken, "tok");
        let [_, g, w, h] = frame_header(fport, &ftoken);
        assert_eq!((g, w, h), (o["generation"].as_u64().unwrap() as u32, 32, 16));

        let r = call(&mut ws, 3, "pt_scene", json!({ "bodies": [] }));
        assert_eq!(r["value"], json!([]), "{r}");
        let r = call(&mut ws, 4, "pt_cap", json!({ "cap": 4 }));
        assert_eq!(r["ok"], json!(true), "{r}");
        let r = call(&mut ws, 5, "pt_status", json!({}));
        assert!(r["value"]["adapter"].is_string(), "{r}");

        let r = call(&mut ws, 6, "frames_resize", json!({ "width": 20, "height": 10 }));
        let g2 = r["value"].as_u64().unwrap() as u32;
        assert!(g2 > g, "{g} -> {g2}");
        let [_, g, w, h] = frame_header(fport, &ftoken);
        assert_eq!((g, w, h), (g2, 20, 10));

        let id = o["id"].clone();
        assert_eq!(call(&mut ws, 7, "frames_close", json!({ "id": id.as_u64().unwrap() + 1 }))["ok"], json!(true));
        assert_eq!(call(&mut ws, 8, "pt_status", json!({}))["ok"], json!(true), "a stale close left the tracer open");
        call(&mut ws, 9, "frames_close", json!({ "id": id }));
        let r = call(&mut ws, 10, "pt_status", json!({}));
        assert_eq!(r["error"], json!("the native tracer is not open"));
    }
}
