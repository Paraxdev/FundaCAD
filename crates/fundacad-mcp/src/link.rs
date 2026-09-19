//! The line to the geometry engine, and the engine's own lifetime. A port of
//! the Python MCP server's engine link and Windows job object, on the Rust engine.
//!
//! Everything the MCP server can say about a model, it learns by asking the
//! same engine the app asks. That is deliberate: a gap an agent hits here is a
//! gap a user hits in the viewport, which is the only reason driving the engine
//! is worth more than computing geometry in this process.
//!
//! There are two ways to have an engine, and which one is in force decides what
//! an agent can reach:
//!
//!   * PRIVATE, spawn one (`fundacad-engine --ws`) on a free port with a token
//!     minted here. It never competes with a running app for the worker and it
//!     cannot see the document the user has open.
//!   * ATTACHED, join the engine a running FundaCAD already has, by reading the
//!     port and token it publishes (`app_session`). The agent then shares the
//!     user's engine AND, through the session ops, the document on their screen.
//!
//! A spawned engine is a CHILD PROCESS rather than this process linking
//! fundacad-geom: OpenCASCADE aborts and segfaults on bad input, and in this
//! process that would take the MCP session with it, mid conversation, with no
//! reply. It is also what keeps the two modes one code path, because a live
//! session has to be a socket to somebody else's engine whatever this one does.
//!
//! One connection, reopened on demand. The engine serialises heavy ops anyway,
//! so there is nothing to gain from more, and a single socket makes cancelling
//! and shutting down one thing each.

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
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// How long to wait for the spawned engine to print LISTENING.
pub const START_TIMEOUT: Duration = Duration::from_secs(120);

/// Ceiling on one request. A rebuild of a heavy document is minutes in the
/// worst case and the engine has its own stall supervision underneath this, so
/// this exists only so a lost reply cannot wedge the agent forever.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(600);

const PREFIX: &str = "FUNDACAD_";
/// The retired spellings still answer, for a shell profile no rename can reach.
const LEGACY_PREFIXES: &[&str] = &["SINDRI_", "SINDRICAD_"];

pub fn appenv(suffix: &str) -> Option<String> {
    std::iter::once(PREFIX)
        .chain(LEGACY_PREFIXES.iter().copied())
        .find_map(|p| std::env::var(format!("{p}{suffix}")).ok())
}

/// `FUNDACAD_ENGINE_<suffix>`, else the retired `FUNDACAD_SIDECAR_<suffix>`
/// from the Python engine.
pub fn engine_env(suffix: &str) -> Option<String> {
    appenv(&format!("ENGINE_{suffix}")).or_else(|| appenv(&format!("SIDECAR_{suffix}")))
}

/// What to do about a running app, from `FUNDACAD_MCP_MODE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Attach to a running FundaCAD if there is one, else spawn.
    Auto,
    /// Attach, or refuse to start. For a host configured to work on the open
    /// document and nothing else, where quietly falling back to a private copy
    /// would look like the edits are being ignored.
    Attach,
    /// Never attach, even with an app open.
    Standalone,
}

/// Deliberately forgiving about spelling: this is read at start-up inside an
/// MCP host, where a refusal reaches the user as "the server exited" with the
/// reason in a log they may never open.
pub fn mode_from_env() -> Mode {
    match std::env::var("FUNDACAD_MCP_MODE")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "attach" => Mode::Attach,
        "standalone" => Mode::Standalone,
        _ => Mode::Auto,
    }
}

// --- where the engine is -----------------------------------------------------

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "fundacad-engine.exe"
    } else {
        "fundacad-engine"
    }
}

fn app_name() -> &'static str {
    if cfg!(windows) {
        "fundacad.exe"
    } else {
        "fundacad"
    }
}

/// Whether `path` is an app built with the Rust engine, which answers
/// `--engine --ws`. A Python beta build ignores `--engine` and opens a
/// window, so it is recognised by the IPC command only the Rust build
/// registers, the same test the alpha CI job applies to its bundle.
pub fn is_rust_engine_app(path: &Path) -> bool {
    const MARKER: &[u8] = b"engine_attach";
    std::fs::read(path).is_ok_and(|bytes| bytes.windows(MARKER.len()).any(|w| w == MARKER))
}

/// The command that starts a private engine: the program and its arguments
/// before `--ws`.
///
/// `FUNDACAD_ENGINE_CMD` is the override, the same variable the protocol suites
/// drive both engines with. It is checked for existence rather than trusted:
/// an override naming a binary that is not there would otherwise turn "no
/// engine" into a spawn failure naming a path nobody set.
///
/// Without one, the binary next to this one, then the app next to this one
/// (`fundacad --engine`, how a packaged app ships it, one copy of the kernel),
/// then the workspace target directories, found by walking UP until one turns
/// up rather than by counting directories, because counting encodes where a
/// file happens to live today.
pub fn engine_command() -> Vec<String> {
    if let Some(cmd) = appenv("ENGINE_CMD").filter(|c| !c.trim().is_empty()) {
        let parts = split_command(&cmd);
        if parts.first().is_some_and(|p| looks_runnable(p)) {
            return parts;
        }
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(PathBuf::from));
    if let Some(p) = beside
        .as_ref()
        .map(|d| d.join(exe_name()))
        .filter(|p| p.is_file())
    {
        return vec![p.to_string_lossy().into_owned()];
    }
    if let Some(app) = beside
        .as_ref()
        .map(|d| d.join(app_name()))
        .filter(|p| is_rust_engine_app(p))
    {
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

/// A command line split the way a shell would, quotes included, so
/// `FUNDACAD_ENGINE_CMD` can name a path with a space in it.
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
    // Inherently a race, something else can take it between this close and the
    // engine's bind, but the engine reports a bind failure by name, so the race
    // is loud rather than silent.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn mint_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::fill(&mut bytes).is_err() {
        // Only reachable when the OS has no entropy source at all; a private
        // engine on loopback is still better than refusing to start.
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64);
        bytes[..8].copy_from_slice(&n.to_le_bytes());
    }
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    bytes
        .iter()
        .map(|b| ALPHABET[(*b % 64) as usize] as char)
        .collect()
}

// --- the socket --------------------------------------------------------------

/// One WebSocket to an engine, and the request/reply pairing on it.
pub struct Socket {
    ws: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
}

impl Socket {
    pub async fn connect(port: u16, token: &str) -> io::Result<Socket> {
        // The slash is not decoration. Without a path the request line comes
        // out as `GET ?token=... HTTP/1.1`, which is not a request-URI: the
        // engine's header parser refuses it, drops the connection, and the
        // client reports an unfinished handshake with nothing to point at.
        let url = format!("ws://127.0.0.1:{port}/?token={token}");
        // A rebuild reply of a large assembly is tens of MB, far past
        // tungstenite's 16 MiB default. The Python server sets max_size=None.
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(None)
            .max_frame_size(None);
        let (ws, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|e| io::Error::new(io::ErrorKind::ConnectionRefused, e.to_string()))?;
        Ok(Socket { ws })
    }

    /// One request, one reply. Progress frames are dropped: they carry a
    /// percentage for a progress bar nobody here is drawing.
    pub async fn request(&mut self, id: &str, request: &Value) -> io::Result<Value> {
        let mut payload = request.as_object().cloned().unwrap_or_default();
        payload.insert("id".into(), json!(id));
        let text = Value::Object(payload).to_string();
        self.ws
            .send(Message::Text(text.into()))
            .await
            .map_err(closed)?;
        loop {
            let Some(msg) = self.ws.next().await else {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "the engine closed the connection",
                ));
            };
            let msg = msg.map_err(closed)?;
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "the engine closed the connection",
                    ))
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
                Some(Value::Null) | None => return Ok(value),
                Some(Value::String(got)) if got == id => return Ok(value),
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

// --- the link ----------------------------------------------------------------

/// Spawn (or attach to) one engine, and speak to it.
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
}

impl EngineLink {
    /// A private engine: a free port and a token minted here. Nothing is
    /// spawned until the first call.
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

    /// A link to an engine somebody else is running.
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

    /// A link configured by environment variables alone: the explicit
    /// override, which knows nothing about a running app.
    pub fn from_env() -> EngineLink {
        match engine_env("TOKEN").filter(|t| !t.is_empty()) {
            Some(token) => {
                let port = engine_env("PORT")
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(8765);
                EngineLink::attach(port, token)
            }
            None => EngineLink::private(),
        }
    }

    /// The link this mode asks for, and what it found. `app` is the running
    /// app's session when attached and None when not, so the caller can say
    /// which of the two worlds it is in without inferring it from `attached`,
    /// which the environment override also sets.
    ///
    /// An explicit token in the environment wins over everything here. Someone
    /// who set it is pointing this at a specific engine on purpose, and a
    /// discovery step that overrode them would make a debugging session
    /// unexplainable.
    pub async fn for_mode(
        mode: Mode,
        log: impl Fn(&str),
    ) -> Result<(EngineLink, Option<crate::app_session::AppSession>), String> {
        if engine_env("TOKEN").is_some_and(|t| !t.is_empty()) {
            log("[mcp] attaching to the engine named in the environment");
            return Ok((EngineLink::from_env(), None));
        }
        if mode != Mode::Standalone {
            let found =
                crate::app_session::find_running_app(None, crate::app_session::PROBE_TIMEOUT).await;
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
                // Loud, and by request: this mode exists for a host meant to
                // work on the open document, where silently working on a
                // private copy would look like the edits are being ignored.
                return Err(
                    "FUNDACAD_MCP_MODE=attach, but no FundaCAD window is running (no live \
                     session file, or the engine it names is gone). Open FundaCAD, or use \
                     FUNDACAD_MCP_MODE=auto to work on a private copy when it is closed."
                        .into(),
                );
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
        // Written under the current names only, and the retired spellings
        // cleared with them: a child handed two names that disagree would pick
        // whichever its own lookup order preferred, which is not a thing to
        // leave to chance when one of them is the auth token.
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
        // The durable blob store, which the app's shell normally sets. Without
        // it the store falls back to a default this process chose, and an
        // `import` feature's `geom` is a content hash INTO that store: the
        // document would save cleanly, name a blob the app has never held, and
        // fail to open, which is the worst of the three outcomes because it
        // looks like it worked. Not forced: an explicit FUNDACAD_BLOB_DIR is
        // someone pointing this at a store on purpose.
        if appenv("BLOB_DIR").is_none() {
            cmd.env(
                "FUNDACAD_BLOB_DIR",
                crate::app_session::app_data_dir().join("blobs"),
            );
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
        // Drained for the life of the engine: a pipe nobody reads fills, and
        // the engine then blocks on its next log line. Our stdout is the MCP
        // protocol, so what it says goes to stderr, the host's log.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[engine] {line}");
                }
            });
        }
        // Adopted BEFORE the readiness wait, so anything it spawns during
        // start-up is inside the job too. An MCP host kills its servers with
        // TerminateProcess, which runs no cleanup at all.
        #[cfg(windows)]
        if let Some(pid) = child.id() {
            self.job.adopt(pid);
        }
        let stdout = child.stdout.take().expect("piped");
        let mut lines = BufReader::new(stdout).lines();
        // Wait for the readiness line rather than polling the port: the engine
        // prints LISTENING only once it is serving, and a port that is merely
        // bound would let the first request race the accept loop.
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
                Err(io::Error::other(
                    "the geometry engine exited before it was ready",
                ))
            }
            Err(_) => {
                let _ = child.kill().await;
                Err(io::Error::other(format!(
                    "the geometry engine did not start within {}s",
                    START_TIMEOUT.as_secs()
                )))
            }
        }
    }

    /// One request, one reply, serialised on the link's own lock because ids
    /// are unique per connection and replies are matched by this simple client
    /// rather than routed. One agent asking one question at a time is the whole
    /// traffic pattern.
    pub async fn call(&self, op: &str, payload: Value) -> io::Result<Value> {
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
            let sent = tokio::time::timeout(CALL_TIMEOUT, socket.request(&req_id, &request)).await;
            match sent {
                Ok(Ok(reply)) => return Ok(reply),
                Ok(Err(e)) => {
                    // The worker can be killed out from under a socket (a stall
                    // reap, an OCCT crash). One silent reconnect, then the error
                    // is the caller's to see.
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

    /// The process id of the engine this link spawned, when it spawned one.
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

/// A call's payload, built from pairs so a tool reads like the Python did.
pub fn args(pairs: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.into(), v);
    }
    Value::Object(m)
}

#[cfg(windows)]
pub mod job {
    //! The Windows job object that makes the engine die with this process,
    //! a port of the Python MCP server's `winjob.py`.
    //!
    //! Not housekeeping: an MCP host kills its servers with TerminateProcess,
    //! which runs no cleanup, and the engine's own die-with-parent covers Linux
    //! and macOS only. Measured on the Python engine without it: 46 orphaned
    //! worker processes, after which a fresh engine could no longer start one.

    use std::sync::Mutex;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECTINFOCLASS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: JOBOBJECTINFOCLASS = 9;

    pub struct ProcessJob(Mutex<isize>);

    impl ProcessJob {
        pub fn new() -> ProcessJob {
            ProcessJob(Mutex::new(0))
        }

        /// Put `pid` in a job that kills its members when this process's last
        /// handle to it closes, which a TerminateProcess does.
        pub fn adopt(&self, pid: u32) {
            let mut held = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if *held == 0 {
                let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
                if job.is_null() {
                    return;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                    unsafe { std::mem::zeroed() };
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
