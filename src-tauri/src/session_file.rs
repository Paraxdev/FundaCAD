//! Where a running FundaCAD says how to reach its live engine, so `fundacad-mcp` can join the session on screen. The
//! token can rebuild, import and export, so the file is user only; joining the open document is gated in the frontend.

use std::path::{Path, PathBuf};

/// Also read by `crates/fundacad-mcp/src/app_session.rs`, which resolves the same directory from the bundle identifier.
pub const FILE_NAME: &str = "session.json";

/// Serialised by hand, four fields are not worth a serde_json dependency. `pid` is for a human telling two windows
/// apart; no liveness is stored, as a pid can be recycled and the reader's handshake answers that anyway.
#[derive(Debug, PartialEq, Eq)]
pub struct SessionInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// Always escaped, though the token is hex today: a quote in a token would silently parse into a different token.
pub fn to_json(info: &SessionInfo) -> String {
    format!("{{\"port\":{},\"token\":{},\"pid\":{}}}\n", info.port, json_string(&info.token), info.pid)
}

/// A JSON string literal. Minimal and complete for what goes in this file:
/// quote, backslash, and the control characters that are illegal raw in JSON.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Written to a temporary name and renamed, so a reader never sees a half written file.
pub fn write_into(dir: &Path, info: &SessionInfo) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(FILE_NAME);
    let tmp = dir.join(format!("{FILE_NAME}.{}.tmp", info.pid));
    std::fs::write(&tmp, to_json(info))?;
    restrict(&tmp)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Owner only, so a reader runs as this user and could read the documents anyway. Unix has no default worth relying
/// on, a permissive umask would otherwise publish the token to every account on the machine.
#[cfg(unix)]
fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// Windows: the file inherits the per user AppData ACL, which already excludes other accounts, and an explicit ACL edit
/// would only be a way to get it wrong.
#[cfg(not(unix))]
fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Best effort, and a kill skips it, so a leftover is ordinary: a reader dials and treats a refusal as no app.
pub fn remove_from(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(FILE_NAME));
}
