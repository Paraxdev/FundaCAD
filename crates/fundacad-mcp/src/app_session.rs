//! Is FundaCAD open? The app's session file (src-tauri/src/session_file.rs) is only a hint, stale after
//! any kill, so the answer is a dial to its port with its token.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

/// From src-tauri/tauri.conf.json: Tauri derives the app data directory from it, so the two must agree.
pub const APP_IDENTIFIER: &str = "dev.fundacad.app";

static IDENTIFIER: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The app sets the identifier its build config carries, since the development build has its own
/// (src-tauri/tauri.dev-product.conf.json). Before any directory is resolved; a later call is ignored.
pub fn set_app_identifier(id: &str) {
    let _ = IDENTIFIER.set(id.to_string());
}

pub fn app_identifier() -> &'static str {
    IDENTIFIER.get().map_or(APP_IDENTIFIER, String::as_str)
}

/// Written by session_file.rs. Named there too; change one, change both.
pub const SESSION_FILE: &str = "session.json";

/// A "the file is stale" timeout, not a slow network one: loopback and already listening.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Points discovery at another file, for a test or a probe that wants a session of its own.
pub const SESSION_FILE_ENV: &str = "FUNDACAD_SESSION_FILE";

#[derive(Debug, Clone)]
pub struct AppSession {
    pub port: u16,
    pub token: String,
    pub pid: Option<i64>,
    /// The `build` of its engine's `ping` reply (docs/PROTOCOL.md), None before the probe.
    pub build: Option<Value>,
}

/// The directory Tauri's `app_data_dir()` resolves to, without Tauri. Getting a
/// platform's branch wrong means never finding a running app there, silently.
pub fn app_data_dir() -> PathBuf {
    let base = if cfg!(windows) {
        // FOLDERID_RoamingAppData. Tauri uses the roaming one, not Local.
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local").join("share"))
    };
    base.join(app_identifier())
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
}

/// Its own function so a log line can name it: when nothing is found, APPDATA usually differed
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

/// Every failure is None and ordinary: no file, someone else's, or a half written one that lost the rename race.
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
        build: None,
    })
}

/// `ping` rather than a bare connect: a connect only proves SOMETHING accepted it, one round trip
/// proves it speaks this protocol. The reply, when it is one.
pub async fn probe(info: &AppSession, timeout: Duration) -> Option<Value> {
    let call = async {
        let mut ws = crate::link::Socket::connect(info.port, &info.token).await.ok()?;
        let reply = ws.request("probe", &serde_json::json!({"op": "ping"})).await.ok()?;
        let _ = ws.close().await;
        let result = reply.get("result")?;
        (result.get("pong") == Some(&Value::Bool(true))).then(|| result.clone())
    };
    tokio::time::timeout(timeout, call).await.ok().flatten()
}

/// The file alone is never enough to act on and the probe alone has nowhere to dial.
pub async fn find_running_app(path: Option<&Path>, timeout: Duration) -> Option<AppSession> {
    let mut info = read_session_file(path)?;
    let pong = probe(&info, timeout).await?;
    info.build = pong.get("build").cloned();
    Some(info)
}
