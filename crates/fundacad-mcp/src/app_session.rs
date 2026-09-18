//! Is FundaCAD open, and how do I reach it? A port of
//! the Python MCP server's `app_session.py`.
//!
//! The app drops a small file naming its engine's port and token while it runs
//! (src-tauri/src/session_file.rs). This reads it, and then does the only thing
//! that actually settles the question: dials that port and presents that token.
//!
//! The file is a HINT and nothing more. It is removed on a clean exit and not
//! on a kill, so a stale one is ordinary, after a crash, after a power cut,
//! after a `taskkill`. Trusting it would make "the app is open" mean "the app
//! was open once on this machine", which is exactly the wrong answer to give an
//! agent about to edit a document. Dialling costs one connect on loopback.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

/// The bundle identifier from src-tauri/tauri.conf.json. Tauri derives the app
/// data directory from it and this re-derives it, so the two must agree: change
/// the identifier and this constant changes with it.
pub const APP_IDENTIFIER: &str = "dev.fundacad.app";

/// Written by session_file.rs. Named there too; change one, change both.
pub const SESSION_FILE: &str = "session.json";

/// How long to wait for the app's engine to answer. Loopback and already
/// listening, so this is a "the file is stale" timeout, not a slow network one.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Point discovery at a different file, for a test or a probe that wants a
/// session of its own.
pub const SESSION_FILE_ENV: &str = "FUNDACAD_SESSION_FILE";

#[derive(Debug, Clone)]
pub struct AppSession {
    pub port: u16,
    pub token: String,
    pub pid: Option<i64>,
}

/// The directory Tauri's `app_data_dir()` resolves to, without Tauri. Getting a
/// platform's branch wrong means never finding a running app there, silently.
pub fn app_data_dir() -> PathBuf {
    let base = if cfg!(windows) {
        // FOLDERID_RoamingAppData. Tauri uses the roaming one, not Local.
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local").join("share"))
    };
    base.join(APP_IDENTIFIER)
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
}

/// The file `read_session_file` will actually open. Its own function so a log
/// line can name it, and that line is usually the answer: the reason this finds
/// nothing is rarely that the app is closed, it is that APPDATA differed
/// between the app and whatever launched this server.
pub fn session_file_path(path: Option<&Path>) -> PathBuf {
    if let Some(p) = path {
        return p.to_path_buf();
    }
    if let Some(v) = std::env::var_os(SESSION_FILE_ENV) {
        return PathBuf::from(v);
    }
    app_data_dir().join(SESSION_FILE)
}

/// `{port, token, pid}`, or None. Every failure is None and none of them are
/// exceptional: no file (no app has run), unreadable (someone else's),
/// unparseable (a half written file we lost the rename race with).
pub fn read_session_file(path: Option<&Path>) -> Option<AppSession> {
    let path = session_file_path(path);
    let text = std::fs::read_to_string(path).ok()?;
    let data: Value = serde_json::from_str(&text).ok()?;
    let port = data.get("port").and_then(Value::as_u64)?;
    if port == 0 || port > 65535 {
        return None;
    }
    let token = data.get("token").and_then(Value::as_str)?;
    if token.is_empty() {
        return None;
    }
    Some(AppSession {
        port: port as u16,
        token: token.to_string(),
        pid: data.get("pid").and_then(Value::as_i64),
    })
}

/// Does something answer on that port, with that token, and is it ours?
///
/// `ping` rather than a bare connect: the token is checked during the handshake,
/// but a successful connect only proves SOMETHING accepted it. One round trip
/// proves the other end speaks this protocol, which is what the caller is about
/// to rely on.
pub async fn probe(info: &AppSession, timeout: Duration) -> bool {
    let call = async {
        let mut ws = crate::link::Socket::connect(info.port, &info.token).await.ok()?;
        let reply = ws
            .request("probe", &serde_json::json!({"op": "ping"}))
            .await
            .ok()?;
        let _ = ws.close().await;
        Some(reply.get("result")?.get("pong")?.as_bool().unwrap_or(false))
    };
    matches!(tokio::time::timeout(timeout, call).await, Ok(Some(true)))
}

/// The running app's session, or None. The file alone is never enough to act on
/// and the probe alone has nowhere to dial, so the two are joined here.
pub async fn find_running_app(path: Option<&Path>, timeout: Duration) -> Option<AppSession> {
    let info = read_session_file(path)?;
    if probe(&info, timeout).await {
        Some(info)
    } else {
        None
    }
}
