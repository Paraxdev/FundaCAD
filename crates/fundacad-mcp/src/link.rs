//! The line to the geometry engine. PRIVATE spawns `fundacad-engine --ws` on a free port with a token minted
//! here; ATTACHED joins a running app's engine and, through the session ops, the document on screen.
//! A child process, not linked fundacad-geom, since OpenCASCADE aborts on bad input and would end the session.
//! One connection, reopened on demand: the engine serialises heavy ops anyway.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::mesh::MeshBody;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// How long to wait for the spawned engine to print LISTENING.
pub const START_TIMEOUT: Duration = Duration::from_secs(120);

/// A heavy rebuild is minutes at worst and the engine supervises stalls itself,
/// so this only keeps a lost reply from wedging the agent.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(600);

const PREFIX: &str = "FUNDACAD_";
/// The retired spellings still answer, for a shell profile no rename can reach.
const LEGACY_PREFIXES: &[&str] = &["SINDRI_", "SINDRICAD_"];

pub fn appenv(suffix: &str) -> Option<String> {
    std::iter::once(PREFIX)
        .chain(LEGACY_PREFIXES.iter().copied())
        .find_map(|p| std::env::var(format!("{p}{suffix}")).ok())
}

/// `FUNDACAD_ENGINE_<suffix>`, else the retired `FUNDACAD_SIDECAR_<suffix>` of the Python engine.
pub fn engine_env(suffix: &str) -> Option<String> {
    appenv(&format!("ENGINE_{suffix}")).or_else(|| appenv(&format!("SIDECAR_{suffix}")))
}

/// What to do about a running app, from `FUNDACAD_MCP_MODE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Attach to a running FundaCAD if there is one, else spawn.
    Auto,
    /// Attach, or refuse to start: for a host meant for the open document,
    /// a private copy would look like the edits are being ignored.
    Attach,
    /// Never attach, even with an app open.
    Standalone,
}

/// Forgiving about spelling: inside an MCP host a refusal reads as "the server exited", its reason in an unread log.
pub fn mode_from_env() -> Mode {
    match std::env::var("FUNDACAD_MCP_MODE").unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "attach" => Mode::Attach,
        "standalone" => Mode::Standalone,
        _ => Mode::Auto,
    }
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "fundacad-engine.exe"
    } else {
        "fundacad-engine"
    }
}

/// The development build's binary is fundacad-dev (src-tauri/tauri.dev-product.conf.json), so it can be installed
/// beside the beta.
fn app_names() -> [&'static str; 2] {
    if cfg!(windows) {
        ["fundacad.exe", "fundacad-dev.exe"]
    } else {
        ["fundacad", "fundacad-dev"]
    }
}

/// A Python engine build ignores `--engine` and opens a window, so the Rust one is told by the IPC command
/// only it registers, the test the beta CI job applies to its bundle.
pub fn is_rust_engine_app(path: &Path) -> bool {
    const MARKER: &[u8] = b"engine_attach";
    std::fs::read(path).is_ok_and(|bytes| bytes.windows(MARKER.len()).any(|w| w == MARKER))
}

/// The program and arguments before `--ws`. `FUNDACAD_ENGINE_CMD` overrides it when that binary exists; else the
/// binary beside this one, then the app beside it (`fundacad --engine`), then target dirs found by walking UP.
pub fn engine_command() -> Vec<String> {
    if let Some(cmd) = appenv("ENGINE_CMD").filter(|c| !c.trim().is_empty()) {
        let parts = split_command(&cmd);
        if parts.first().is_some_and(|p| looks_runnable(p)) {
            return parts;
        }
    }
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
    if let Some(p) = beside.as_ref().map(|d| d.join(exe_name())).filter(|p| p.is_file()) {
        return vec![p.to_string_lossy().into_owned()];
    }
    let app = beside.as_ref().and_then(|d| app_names().into_iter().map(|n| d.join(n)).find(|p| is_rust_engine_app(p)));
    if let Some(app) = app {
        return vec![app.to_string_lossy().into_owned(), "--engine".into()];
    }
    let mut here = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    for _ in 0..8 {
        for profile in ["debug", "release"] {
            let candidate = here.join("target").join(profile).join(exe_name());
            if candidate.is_file() {
                return vec![candidate.to_string_lossy().into_owned()];
            }
        }
        match here.parent() {
            Some(parent) => here = parent.to_path_buf(),
            None => break,
        }
    }
    // Nothing found. Returned rather than refused so the caller fails where it
    // tries to use it, with the name in the message.
    vec![exe_name().to_string()]
}

fn looks_runnable(program: &str) -> bool {
    let p = PathBuf::from(program);
    // A bare program name is left to PATH; a path is checked.
    !p.is_absolute() && p.parent().is_none_or(|d| d.as_os_str().is_empty()) || p.is_file()
}

/// Split as a shell would, quotes included, so `FUNDACAD_ENGINE_CMD` can name a path with a space.
pub fn split_command(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut any = false;
    for ch in text.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                any = true;
            }
            None if ch.is_whitespace() => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            None => cur.push(ch),
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn free_port() -> io::Result<u16> {
    // A race, something may take the port before the engine binds, but the engine names a bind failure.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn mint_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::fill(&mut bytes).is_err() {
        // Only reachable when the OS has no entropy source at all; a private
        // engine on loopback is still better than refusing to start.
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        bytes[..8].copy_from_slice(&n.to_le_bytes());
    }
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    bytes.iter().map(|b| ALPHABET[(*b % 64) as usize] as char).collect()
}

/// One WebSocket to an engine, and the request/reply pairing on it.
pub struct Socket {
    ws: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Socket {
    pub async fn connect(port: u16, token: &str) -> io::Result<Socket> {
        // The slash matters: without a path the request line is `GET ?token=... HTTP/1.1`, which the engine's
        // parser refuses, and the client reports an unfinished handshake with nothing to point at.
        let url = format!("ws://127.0.0.1:{port}/?token={token}");
        // A rebuild reply of a large assembly is tens of MB, far past tungstenite's 16 MiB default.
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(None)
            .max_frame_size(None);
        let (ws, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|e| io::Error::new(io::ErrorKind::ConnectionRefused, e.to_string()))?;
        Ok(Socket { ws })
    }

    /// Progress frames are dropped. A mesh reply comes in binary chunks, as the app gets it,
    /// since as one JSON message a large assembly breaks the frame cap.
    pub async fn request(&mut self, id: &str, request: &Value) -> io::Result<Value> {
        self.request_meshed(id, request).await.map(|(v, _)| v)
    }

    /// [`Socket::request`], a binary mesh reply's bodies kept as flat arrays
    /// beside it; the reply's own `bodies` then carry every key but those.
    pub async fn request_meshed(&mut self, id: &str, request: &Value) -> io::Result<(Value, Vec<MeshBody>)> {
        let mut payload = request.as_object().cloned().unwrap_or_default();
        payload.insert("id".into(), json!(id));
        payload.insert("binary".into(), json!(true));
        payload.insert("chunked".into(), json!(true));
        let mut streamed: Option<(Map<String, Value>, Vec<MeshBody>)> = None;
        let text = Value::Object(payload).to_string();
        self.ws.send(Message::Text(text.into())).await.map_err(closed)?;
        loop {
            let Some(msg) = self.ws.next().await else {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the engine closed the connection"));
            };
            let msg = msg.map_err(closed)?;
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => {
                    let (mut value, mut bufs) = fundacad_protocol::frame::decode_frame_raw(&b)
                        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
                    let mut meshes = Vec::new();
                    if let Some(result) = value.get_mut("result").and_then(Value::as_object_mut) {
                        if let Some(Value::Array(bodies)) = result.get_mut("bodies") {
                            for b in bodies.iter_mut() {
                                let m = MeshBody::from_frame(b.take(), &mut bufs);
                                *b = Value::Object(m.info.clone());
                                meshes.push(m);
                            }
                        }
                    }
                    let Some(stream) = value.get("stream").cloned() else {
                        return Ok((value, meshes));
                    };
                    let (fields, all) = streamed.get_or_insert_with(Default::default);
                    if let Some(Value::Object(mut result)) = value.get_mut("result").map(Value::take) {
                        result.shift_remove("bodies");
                        result.shift_remove("manifest");
                        fields.extend(result);
                    }
                    all.extend(meshes);
                    if stream.get("final") != Some(&Value::Bool(true)) {
                        continue;
                    }
                    let (mut fields, all) = streamed.take().unwrap_or_default();
                    let infos = all.iter().map(|m| Value::Object(m.info.clone())).collect();
                    fields.insert("bodies".into(), Value::Array(infos));
                    return Ok((json!({"id": value.get("id"), "ok": true, "result": fields}), all));
                }
                Message::Close(_) => {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the engine closed the connection"))
                }
                _ => continue,
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("status").is_some() {
                continue; // building or importing progress
            }
            match value.get("id") {
                Some(Value::Null) | None => return Ok((value, Vec::new())),
                Some(Value::String(got)) if got == id => return Ok((value, Vec::new())),
                _ => continue,
            }
        }
    }

    pub async fn close(&mut self) -> io::Result<()> {
        let _ = self.ws.close(None).await;
        Ok(())
    }
}

fn closed(e: tokio_tungstenite::tungstenite::Error) -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, e.to_string())
}

pub struct EngineLink {
    pub port: u16,
    pub token: String,
    /// True when this link joined somebody else's engine and starts nothing.
    pub attached: bool,
    state: Mutex<LinkState>,
    #[cfg(windows)]
    job: crate::link::job::ProcessJob,
}

#[derive(Default)]
struct LinkState {
    child: Option<Child>,
    socket: Option<Socket>,
    next_id: u64,
    /// The engine's `build` from its `ping`, `{}` when it gave none, None
    /// until asked and again once a new engine process is started.
    build: Option<Value>,
}

impl EngineLink {
    /// Nothing is spawned until the first call.
    pub fn private() -> EngineLink {
        EngineLink {
            port: free_port().unwrap_or(0),
            token: mint_token(),
            attached: false,
            state: Mutex::new(LinkState::default()),
            #[cfg(windows)]
            job: crate::link::job::ProcessJob::new(),
        }
    }

    pub fn attach(port: u16, token: impl Into<String>) -> EngineLink {
        EngineLink {
            port,
            token: token.into(),
            attached: true,
            state: Mutex::new(LinkState::default()),
            #[cfg(windows)]
            job: crate::link::job::ProcessJob::new(),
        }
    }

    /// The explicit environment override, which knows nothing about a running app.
    pub fn from_env() -> EngineLink {
        match engine_env("TOKEN").filter(|t| !t.is_empty()) {
            Some(token) => {
                let port = engine_env("PORT").and_then(|p| p.parse().ok()).unwrap_or(8765);
                EngineLink::attach(port, token)
            }
            None => EngineLink::private(),
        }
    }

    /// `app` is the running app's session when attached, so the caller need not infer it from `attached`,
    /// which the env override also sets. An explicit env token wins over discovery, since whoever set it
    /// points this at a specific engine on purpose.
    pub async fn for_mode(
        mode: Mode,
        log: impl Fn(&str),
    ) -> Result<(EngineLink, Option<crate::app_session::AppSession>), String> {
        if engine_env("TOKEN").is_some_and(|t| !t.is_empty()) {
            log("[mcp] attaching to the engine named in the environment");
            return Ok((EngineLink::from_env(), None));
        }
        if mode != Mode::Standalone {
            let found = crate::app_session::find_running_app(None, crate::app_session::PROBE_TIMEOUT).await;
            if let Some(app) = found {
                log(&format!(
                    "[mcp] FundaCAD is open (pid {}), attaching to its engine on port {}",
                    app.pid.map_or("?".into(), |p| p.to_string()),
                    app.port
                ));
                let link = EngineLink::attach(app.port, app.token.clone());
                return Ok((link, Some(app)));
            }
            if mode == Mode::Attach {
                // Loud by request: for a host meant for the open document,
                // a private copy would look like ignored edits.
                return Err("FUNDACAD_MCP_MODE=attach, but no FundaCAD window is running (no live \
                     session file, or the engine it names is gone). Open FundaCAD, or use \
                     FUNDACAD_MCP_MODE=auto to work on a private copy when it is closed."
                    .into());
            }
            log(&format!(
                "[mcp] no FundaCAD window is open, starting a private engine (looked for {})",
                crate::app_session::session_file_path(None).display()
            ));
        } else {
            log("[mcp] standalone by configuration, starting a private engine");
        }
        Ok((EngineLink::private(), None))
    }

    async fn start(&self, state: &mut LinkState) -> io::Result<()> {
        // A child that died (killed, crashed, reaped) left a port nothing listens
        // on, and every call after it was refused until the host restarted us.
        if let Some(child) = state.child.as_mut() {
            if !matches!(child.try_wait(), Ok(None)) {
                state.child = None;
            }
        }
        if self.attached || state.child.is_some() {
            return Ok(());
        }
        let argv = engine_command();
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]).arg("--ws");
        // Current names only and the retired ones cleared, since a child handed two disagreeing
        // auth tokens would pick one by its own lookup order.
        for prefix in std::iter::once(PREFIX).chain(LEGACY_PREFIXES.iter().copied()) {
            for retired in ["SIDECAR_PORT", "SIDECAR_TOKEN"] {
                cmd.env_remove(format!("{prefix}{retired}"));
            }
        }
        for legacy in LEGACY_PREFIXES {
            cmd.env_remove(format!("{legacy}ENGINE_PORT"));
            cmd.env_remove(format!("{legacy}ENGINE_TOKEN"));
            cmd.env_remove(format!("{legacy}BLOB_DIR"));
        }
        cmd.env("FUNDACAD_ENGINE_PORT", self.port.to_string());
        cmd.env("FUNDACAD_ENGINE_TOKEN", &self.token);
        // The durable blob store, which the app's shell normally sets. An `import`'s `geom` is a hash INTO it,
        // so a default chosen here would save a document naming a blob the app never held.
        // An explicit FUNDACAD_BLOB_DIR wins.
        if appenv("BLOB_DIR").is_none() {
            cmd.env("FUNDACAD_BLOB_DIR", crate::app_session::app_data_dir().join("blobs"));
        }
        // The app's installed plugins, as the app tells its own worker, so a
        // private engine runs the same plugin geometry the window does.
        if appenv("PLUGIN_DIR").is_none() {
            let plugins = crate::app_session::app_data_dir().join("plugins");
            if plugins.is_dir() {
                cmd.env("FUNDACAD_PLUGIN_DIR", plugins);
            }
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn()?;
        state.build = None;
        // Drained for the engine's life, or a full pipe blocks its next log line.
        // Our stdout is the MCP protocol, so its output goes to stderr, the host's log.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[engine] {line}");
                }
            });
        }
        // Adopted BEFORE the readiness wait, so anything it spawns while starting is in the job too.
        // An MCP host kills its servers with TerminateProcess, which runs no cleanup at all.
        #[cfg(windows)]
        if let Some(pid) = child.id() {
            self.job.adopt(pid);
        }
        let stdout = child.stdout.take().expect("piped");
        let mut lines = BufReader::new(stdout).lines();
        // The engine prints LISTENING only once it serves;
        // a merely bound port would let the first request race the accept loop.
        let ready = tokio::time::timeout(START_TIMEOUT, async {
            while let Ok(Some(line)) = lines.next_line().await {
                if line.starts_with("LISTENING") {
                    return true;
                }
            }
            false
        })
        .await;
        match ready {
            Ok(true) => {
                tokio::spawn(async move {
                    while let Ok(Some(line)) = lines.next_line().await {
                        eprintln!("[engine] {line}");
                    }
                });
                state.child = Some(child);
                Ok(())
            }
            Ok(false) => {
                let _ = child.kill().await;
                Err(io::Error::other("the geometry engine exited before it was ready"))
            }
            Err(_) => {
                let _ = child.kill().await;
                Err(io::Error::other(format!("the geometry engine did not start within {}s", START_TIMEOUT.as_secs())))
            }
        }
    }

    /// Serialised on the link's lock: ids are unique per connection, and this simple client matches replies
    /// rather than routing them.
    pub async fn call(&self, op: &str, payload: Value) -> io::Result<Value> {
        self.call_meshed(op, payload).await.map(|(v, _)| v)
    }

    /// [`Link::call`] with a mesh reply's bodies as flat arrays, see
    /// [`Socket::request_meshed`].
    pub async fn call_meshed(&self, op: &str, payload: Value) -> io::Result<(Value, Vec<MeshBody>)> {
        let mut state = self.state.lock().await;
        state.next_id += 1;
        let req_id = state.next_id.to_string();
        let mut request = payload.as_object().cloned().unwrap_or_default();
        request.insert("op".into(), json!(op));
        let request = Value::Object(request);
        for attempt in 0..2 {
            if state.socket.is_none() {
                self.start(&mut state).await?;
                state.socket = Some(Socket::connect(self.port, &self.token).await?);
            }
            let socket = state.socket.as_mut().expect("just connected");
            let sent = tokio::time::timeout(CALL_TIMEOUT, socket.request_meshed(&req_id, &request)).await;
            match sent {
                Ok(Ok(reply)) => return Ok(reply),
                Ok(Err(e)) => {
                    // The worker can be killed under a socket (a stall reap, an OCCT crash): one silent reconnect,
                    // then the caller sees the error.
                    state.socket = None;
                    if attempt == 1 {
                        return Err(e);
                    }
                }
                Err(_) => {
                    state.socket = None;
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("the engine did not reply within {}s", CALL_TIMEOUT.as_secs()),
                    ));
                }
            }
        }
        Err(io::Error::other("the engine could not be reached"))
    }

    /// What the engine says about its build, asked once per engine process.
    pub async fn build(&self) -> Option<Value> {
        if let Some(known) = self.state.lock().await.build.clone() {
            return Some(known);
        }
        let pong = self.call("ping", json!({})).await.ok()?;
        let build = pong.get("result")?.get("build").cloned().unwrap_or_else(|| json!({}));
        self.state.lock().await.build = Some(build.clone());
        Some(build)
    }

    pub async fn engine_pid(&self) -> Option<u32> {
        self.state.lock().await.child.as_ref().and_then(Child::id)
    }

    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        if let Some(mut socket) = state.socket.take() {
            let _ = socket.close().await;
        }
        if let Some(mut child) = state.child.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
        }
        #[cfg(windows)]
        self.job.close();
    }
}

pub fn args(pairs: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.into(), v);
    }
    Value::Object(m)
}

/// What to tell a person when this server's engine is not the build FundaCAD's is, by their `ping` builds.
/// None when they match or either cannot say.
pub fn build_mismatch(app: &Value, private: &Value) -> Option<String> {
    fn commit(b: &Value) -> Option<&str> {
        b.get("commit").and_then(Value::as_str).filter(|c| !c.is_empty())
    }
    let (a, p) = (commit(app)?, commit(private)?);
    if a == p && app.get("changes") == private.get("changes") {
        return None;
    }
    let describe = |b: &Value, commit: &str| {
        let mut out = format!("commit {}", commit.chars().take(12).collect::<String>());
        if let Some(date) = b.get("commitDate").and_then(Value::as_str).filter(|d| !d.is_empty()) {
            out.push_str(&format!(" of {date}"));
        }
        if let Some(changes) = b.get("changes").and_then(Value::as_str) {
            out.push_str(&format!(" with uncommitted changes {}", changes.chars().take(8).collect::<String>()));
        }
        out
    };
    Some(format!(
        "Note: the engine this MCP server started is not the build FundaCAD runs, so a document can \
         build differently here than in the app. This engine is {}, FundaCAD's is {}. Rebuild this \
         engine from the same source as the app, or use the MCP server that came with the app, then \
         restart the MCP server.",
        describe(private, p),
        describe(app, a)
    ))
}

#[cfg(windows)]
pub mod job {
    //! Makes the engine die with this process: hosts kill servers with TerminateProcess, and die-with-parent covers
    //! only Linux and macOS. Without it the Python engine once left 46 orphaned workers and could start no more.

    use std::sync::Mutex;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JOBOBJECTINFOCLASS,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: JOBOBJECTINFOCLASS = 9;

    pub struct ProcessJob(Mutex<isize>);

    impl ProcessJob {
        pub fn new() -> ProcessJob {
            ProcessJob(Mutex::new(0))
        }

        /// Puts `pid` in a job that kills its members when this process's last handle to it closes,
        /// which a TerminateProcess does.
        pub fn adopt(&self, pid: u32) {
            let mut held = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if *held == 0 {
                let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
                if job.is_null() {
                    return;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = unsafe {
                    SetInformationJobObject(
                        job,
                        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                        std::ptr::addr_of!(info).cast(),
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    )
                };
                if ok == 0 {
                    unsafe { CloseHandle(job) };
                    return;
                }
                *held = job as isize;
            }
            let proc = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            if proc.is_null() {
                return;
            }
            unsafe {
                AssignProcessToJobObject(*held as HANDLE, proc);
                CloseHandle(proc);
            }
        }

        pub fn close(&self) {
            let mut held = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if *held != 0 {
                unsafe { CloseHandle(*held as HANDLE) };
                *held = 0;
            }
        }
    }

    impl Default for ProcessJob {
        fn default() -> Self {
            ProcessJob::new()
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            self.close();
        }
    }
}
