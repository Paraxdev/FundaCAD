//! Supervises the Rust geometry engine worker and relays it to the webview.
//!
//! The worker is this executable started with `--engine` (docs/RUST-PIVOT.md,
//! section 2.1). It speaks framed messages on its stdin and stdout; every
//! message it sends goes to the one channel the webview attached, prefixed
//! with its kind byte. A worker that dies is restarted, and a job that does not
//! stop within a grace period after Cancel is ended by restarting the worker,
//! the only way to stop a kernel call that does not check for cancellation.
//!
//! The worker exits by itself when its stdin closes, which covers this process
//! crashing without a chance to kill it.

use fundacad_protocol::stdio::{read_message, write_message, Message};
use fundacad_protocol::{envelope, message_id};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody, Request};
use tauri::{AppHandle, Emitter, Manager};

const CANCEL_GRACE: Duration = Duration::from_secs(3);
const RESTART_FLOOR: Duration = Duration::from_millis(500);
const RESTART_CEILING: Duration = Duration::from_secs(10);
/// A worker that stayed up this long crashed for a new reason, not in a loop.
const HEALTHY_AFTER: Duration = Duration::from_secs(30);

pub struct Engine(Arc<Inner>);

struct Inner {
    app: AppHandle,
    worker: Mutex<Option<Worker>>,
    channel: Mutex<Option<Channel<InvokeResponseBody>>>,
    up: AtomicBool,
    generation: AtomicU64,
    /// Requests sent and not yet answered by a terminal message, by id.
    in_flight: Mutex<HashSet<String>>,
    /// Cancel requests awaiting their acknowledgement, to the id they target.
    cancels: Mutex<HashMap<String, String>>,
    stopping: AtomicBool,
    /// The generation last ended on purpose by a cancel, which is no crash.
    cancel_killed: AtomicU64,
    /// Where `session.json` goes, None without an app data directory.
    session_dir: Option<std::path::PathBuf>,
}

struct Worker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    generation: u64,
}

/// The worker entry point, called from `main` before Tauri starts.
///
/// `--engine --ws` is the same engine on its own WebSocket, what the shipped
/// `fundacad-mcp` starts as its private engine, so a packaged app needs no
/// second copy of the kernel for it.
pub fn run_worker() -> ! {
    // server.py's startup `plugin_geometry.discover()`, over FUNDACAD_PLUGIN_DIR.
    fundacad_geom::plugins::load();
    if std::env::args().nth(2).as_deref() == Some("--ws") {
        fundacad_engine::ws::run(fundacad_geom::jobs::GeomJobs)
    }
    fundacad_engine::stdio::serve(fundacad_geom::jobs::GeomJobs, live_door)
}

/// The app's token for the live session port, handed to the worker it spawns.
const LIVE_TOKEN_ENV: &str = "FUNDACAD_LIVE_TOKEN";

/// A loopback WebSocket on the app's own engine, so an assistant attached
/// through `session.json` shares the document on screen. The port goes to the
/// app on stderr, since stdout carries the frames.
fn live_door(engine: &Arc<fundacad_engine::Engine>) {
    let Some(token) = std::env::var(LIVE_TOKEN_ENV).ok().filter(|t| !t.is_empty()) else {
        return;
    };
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
    let gate = fundacad_engine::ws::Gate::new(token, "");
    match fundacad_engine::ws::Server::for_engine(engine.clone(), addr, gate) {
        Ok(server) => {
            eprintln!("LISTENING {}", server.port());
            let _ = std::thread::Builder::new()
                .name("live-door".into())
                .spawn(move || server.serve());
        }
        Err(e) => eprintln!("no live session port: {e}"),
    }
}

impl Engine {
    pub fn start(app: &AppHandle) -> Engine {
        let inner = Arc::new(Inner {
            app: app.clone(),
            worker: Mutex::new(None),
            channel: Mutex::new(None),
            up: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            in_flight: Mutex::new(HashSet::new()),
            cancels: Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            cancel_killed: AtomicU64::new(0),
            session_dir: app.path().app_data_dir().ok(),
        });
        let supervisor = inner.clone();
        std::thread::Builder::new()
            .name("engine-supervisor".into())
            .spawn(move || supervise(supervisor))
            .expect("spawn the engine supervisor");
        Engine(inner)
    }

    pub fn stop(&self) {
        self.0.stopping.store(true, Ordering::SeqCst);
        if let Some(dir) = &self.0.session_dir {
            crate::session_file::remove_from(dir);
        }
        if let Some(mut w) = lock(&self.0.worker).take() {
            let _ = w.child.kill();
            let _ = w.child.wait();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Listened for by src/app/engineWatch.ts.
const DIED_EVENT: &str = "engine:died";

fn supervise(inner: Arc<Inner>) {
    let mut delay = RESTART_FLOOR;
    let mut start_failed = false;
    while !inner.stopping.load(Ordering::SeqCst) {
        let started = Instant::now();
        match spawn(&inner) {
            Ok(stdout) => {
                set_up(&inner, true);
                let generation = inner.generation.load(Ordering::SeqCst);
                let cause = relay(&inner, stdout);
                let status = lock(&inner.worker)
                    .as_mut()
                    .filter(|w| w.generation == generation)
                    .and_then(|w| {
                        // Its output closed, so a worker still alive is wedged.
                        let _ = w.child.kill();
                        w.child.wait().ok()
                    });
                set_up(&inner, false);
                if let Some(dir) = &inner.session_dir {
                    crate::session_file::remove_from(dir);
                }
                if inner.stopping.load(Ordering::SeqCst) {
                    return;
                }
                let how = status.map(|s| s.to_string()).unwrap_or(cause);
                eprintln!("[engine] worker ended: {how}");
                if inner.cancel_killed.load(Ordering::SeqCst) == generation {
                    delay = Duration::ZERO;
                } else {
                    let _ = inner.app.emit(
                        DIED_EVENT,
                        serde_json::json!({ "kind": "restarted", "cause": how }),
                    );
                }
                if started.elapsed() > HEALTHY_AFTER {
                    delay = RESTART_FLOOR;
                }
                start_failed = false;
            }
            Err(e) => {
                eprintln!("[engine] cannot start the worker: {e}");
                if !start_failed {
                    start_failed = true;
                    let _ = inner.app.emit(
                        DIED_EVENT,
                        serde_json::json!({ "kind": "start_failed", "cause": e.to_string() }),
                    );
                }
            }
        }
        std::thread::sleep(delay);
        delay = (delay * 2).clamp(RESTART_FLOOR, RESTART_CEILING);
    }
}

fn spawn(inner: &Inner) -> std::io::Result<std::process::ChildStdout> {
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    cmd.arg("--engine")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Where installed plugins are, so the worker can run the geometry any of
    // them ship, the same variable the Python sidecar is told (sidecar.rs).
    if let Ok(dir) = crate::plugins::plugins_root(&inner.app) {
        cmd.env("FUNDACAD_PLUGIN_DIR", dir);
    }
    let token = crate::sidecar::random_token();
    cmd.env(LIVE_TOKEN_ENV, &token);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no worker stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no worker stdout"))?;
    if let Some(stderr) = child.stderr.take() {
        let session_dir = inner.session_dir.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                // Written once the port answers, as sidecar.rs does, so the file
                // never names a port nobody is listening on yet.
                if let (Some(dir), Some(port)) = (&session_dir, line.strip_prefix("LISTENING ").and_then(|p| p.trim().parse::<u16>().ok())) {
                    let info = crate::session_file::SessionInfo {
                        port,
                        token: token.clone(),
                        pid: std::process::id(),
                    };
                    if let Err(e) = crate::session_file::write_into(dir, &info) {
                        eprintln!("[engine] no session file: {e}");
                    }
                }
                eprintln!("[engine] {line}");
            }
        });
    }
    let generation = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *lock(&inner.worker) = Some(Worker {
        child,
        stdin: BufWriter::new(stdin),
        generation,
    });
    Ok(stdout)
}

/// Forwards the worker's messages until it goes away, and says why.
fn relay(inner: &Arc<Inner>, stdout: std::process::ChildStdout) -> String {
    let mut reader = BufReader::with_capacity(1 << 20, stdout);
    loop {
        match read_message(&mut reader) {
            Ok(Some(msg)) => {
                settle(inner, &msg);
                deliver(inner, &msg);
            }
            Ok(None) => return "its output closed".into(),
            Err(e) => return format!("unreadable output ({e})"),
        }
    }
}

/// Drops a request from `in_flight` once its terminal message is seen, and
/// starts the grace period of a cancel the worker says reached a running job.
fn settle(inner: &Arc<Inner>, msg: &Message) {
    let Some(Value::String(id)) = message_id(msg) else { return };
    if let Some(target) = lock(&inner.cancels).remove(&id) {
        if cancel_hit(msg) {
            escalate_cancel(inner.clone(), target);
        }
        return;
    }
    let terminal = match msg {
        Message::Text(t) => !t.contains("\"status\": \"building\"") && !t.contains("\"status\": \"importing\""),
        Message::Binary(b) => binary_is_final(b),
    };
    if terminal {
        lock(&inner.in_flight).remove(&id);
    }
}

/// A job queued behind another is not running, so a cancel misses it, and
/// ending the worker then would take the running job down with it.
fn cancel_hit(msg: &Message) -> bool {
    let Message::Text(t) = msg else { return false };
    serde_json::from_str::<Value>(t)
        .ok()
        .and_then(|v| v.pointer("/result/cancelled").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn binary_is_final(frame: &[u8]) -> bool {
    let Some(len) = frame.get(0..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize) else {
        return true;
    };
    let Some(header) = frame.get(4..4 + len) else { return true };
    match serde_json::from_slice::<Value>(header) {
        Ok(h) => h.get("stream").map_or(true, |s| s.get("final") == Some(&Value::Bool(true))),
        Err(_) => true,
    }
}

fn deliver(inner: &Inner, msg: &Message) {
    let payload = msg.payload();
    let mut bytes = Vec::with_capacity(payload.len() + 1);
    bytes.push(msg.kind());
    bytes.extend_from_slice(payload);
    if let Some(ch) = lock(&inner.channel).as_ref() {
        let _ = ch.send(InvokeResponseBody::Raw(bytes));
    }
}

fn set_up(inner: &Inner, up: bool) {
    if inner.up.swap(up, Ordering::SeqCst) != up {
        if !up {
            lock(&inner.in_flight).clear();
            lock(&inner.cancels).clear();
        }
        let _ = inner.app.emit("engine:state", up);
    }
}

fn send_to_worker(inner: &Inner, msg: &Message) -> Result<(), String> {
    let mut guard = lock(&inner.worker);
    let w = guard.as_mut().ok_or("the geometry engine is not running")?;
    write_message(&mut w.stdin, msg).and_then(|_| w.stdin.flush()).map_err(|e| e.to_string())
}

/// Restarts the worker when `target` is still running after the grace period,
/// answering it as cancelled first so the client reports a cancel, not a crash.
fn escalate_cancel(inner: Arc<Inner>, target: String) {
    std::thread::spawn(move || {
        let generation = inner.generation.load(Ordering::SeqCst);
        std::thread::sleep(CANCEL_GRACE);
        if !lock(&inner.in_flight).contains(&target) || inner.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        eprintln!("[engine] {target} ignored cancel, restarting the worker");
        deliver(&inner, &Message::Text(envelope::cancelled(&Value::String(target.clone()))));
        lock(&inner.in_flight).remove(&target);
        if let Some(w) = lock(&inner.worker).as_mut().filter(|w| w.generation == generation) {
            inner.cancel_killed.store(generation, Ordering::SeqCst);
            let _ = w.child.kill();
        }
    });
}

#[tauri::command]
pub fn engine_kind() -> &'static str {
    "rust"
}

/// The `fundacad-mcp` bundled beside this executable, for the "How to connect
/// it" block in Preferences. The bundle config ships it (`externalBin`).
#[tauri::command]
pub fn mcp_server() -> Result<String, String> {
    let name = if cfg!(windows) { "fundacad-mcp.exe" } else { "fundacad-mcp" };
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe
        .parent()
        .map(|d| d.join(name))
        .ok_or("the app has no directory")?;
    if path.is_file() {
        Ok(path.to_string_lossy().into_owned())
    } else {
        Err(format!(
            "{} is missing, this build did not ship the MCP server",
            path.display()
        ))
    }
}

/// The webview's one channel for engine messages. Returns whether the engine is up.
#[tauri::command]
pub fn engine_attach(state: tauri::State<'_, Engine>, channel: Channel<InvokeResponseBody>) -> bool {
    *lock(&state.0.channel) = Some(channel);
    state.0.up.load(Ordering::SeqCst)
}

/// One request, as the UTF-8 bytes of its JSON.
#[tauri::command]
pub fn engine_send(state: tauri::State<'_, Engine>, request: Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("engine_send takes the request as raw bytes".into());
    };
    let text = String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?;
    let Head { id, op, target, soft } = head(&text);
    // Recorded before sending: a fast reply can be relayed before
    // send_to_worker returns, and would find nothing to settle.
    let Some(id) = id else {
        return send_to_worker(&state.0, &Message::Text(text));
    };
    match op.as_deref() {
        // A soft cancel stops a superseded preview at its next checkpoint. It is
        // never escalated: restarting the worker would drop every cached
        // feature to save a job whose reply nobody is waiting for.
        Some("cancel") if !soft => {
            let target = target.or_else(|| lock(&state.0.in_flight).iter().next().cloned());
            if let Some(target) = target {
                lock(&state.0.cancels).insert(id.clone(), target);
            }
        }
        Some("cancel") => {}
        Some("ping") | None => {}
        Some(_) => {
            lock(&state.0.in_flight).insert(id.clone());
        }
    }
    send_to_worker(&state.0, &Message::Text(text)).inspect_err(|_| {
        lock(&state.0.in_flight).remove(&id);
        lock(&state.0.cancels).remove(&id);
    })
}

#[derive(Debug, PartialEq, Eq, Default)]
struct Head {
    id: Option<String>,
    op: Option<String>,
    target: Option<String>,
    soft: bool,
}

/// The head of a request without parsing a multi-megabyte document: the
/// client writes it first, so a prefix almost always holds it, and a full
/// parse is the fallback.
fn head(text: &str) -> Head {
    #[derive(serde::Deserialize)]
    struct Raw {
        id: Option<Value>,
        op: Option<String>,
        target: Option<Value>,
        soft: Option<bool>,
    }
    let pick = |h: Raw| {
        let s = |v: Option<Value>| v.and_then(|v| v.as_str().map(str::to_owned));
        Head { id: s(h.id), op: h.op, target: s(h.target), soft: h.soft == Some(true) }
    };
    let prefix_end = text.char_indices().nth(512).map_or(text.len(), |(i, _)| i);
    if let Some(close) = text[..prefix_end].find(",\"") {
        let rest = &text[close + 1..prefix_end];
        if let Some(second) = rest.find(",\"").map(|i| close + 1 + i) {
            let candidate = format!("{}}}", &text[..second]);
            if let Ok(h) = serde_json::from_str::<Raw>(&candidate) {
                if h.op.is_some() && h.op.as_deref() != Some("cancel") {
                    return pick(h);
                }
            }
        }
    }
    serde_json::from_str::<Raw>(text).map(pick).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_head_of_a_request_is_read_from_its_prefix() {
        let h = |id: Option<&str>, op: Option<&str>, target: Option<&str>, soft: bool| Head {
            id: id.map(Into::into),
            op: op.map(Into::into),
            target: target.map(Into::into),
            soft,
        };
        let big = format!(r#"{{"id":"a","op":"rebuild","document":{{"x":"{}"}}}}"#, "y".repeat(10_000));
        assert_eq!(head(&big), h(Some("a"), Some("rebuild"), None, false));
        assert_eq!(
            head(r#"{"id":"c","op":"cancel","target":"a"}"#),
            h(Some("c"), Some("cancel"), Some("a"), false)
        );
        assert_eq!(
            head(r#"{"id":"c","op":"cancel","target":"a","soft":true}"#),
            h(Some("c"), Some("cancel"), Some("a"), true)
        );
        assert_eq!(head(r#"{"op":"ping"}"#), h(None, Some("ping"), None, false));
        assert_eq!(head("not json"), Head::default());
    }

    #[test]
    fn only_a_cancel_that_reached_a_running_job_is_a_hit() {
        let ack = |s: &str| Message::Text(s.into());
        assert!(cancel_hit(&ack(r#"{"id": "c", "ok": true, "result": {"cancelled": true}}"#)));
        assert!(!cancel_hit(&ack(r#"{"id": "c", "ok": true, "result": {"cancelled": false}}"#)));
        assert!(!cancel_hit(&ack(r#"{"id": "c", "ok": false, "error": {"message": "x"}}"#)));
        assert!(!cancel_hit(&Message::Binary(vec![0, 0, 0, 0])));
    }

    #[test]
    fn only_the_last_frame_of_a_stream_is_final() {
        let frame = |h: &str| {
            let mut v = (h.len() as u32).to_le_bytes().to_vec();
            v.extend_from_slice(h.as_bytes());
            v
        };
        assert!(binary_is_final(&frame(r#"{"id":"a","ok":true}"#)));
        assert!(!binary_is_final(&frame(r#"{"id":"a","stream":{"seq":0,"final":false}}"#)));
        assert!(binary_is_final(&frame(r#"{"id":"a","stream":{"seq":2,"final":true}}"#)));
    }
}
