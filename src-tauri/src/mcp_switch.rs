//! The MCP switch in Preferences. The shell keeps it rather than the page, since the engine worker starts before the
//! page loads and has to know by then whether to open its live session port.

use std::io;
use std::path::Path;

pub const FILE: &str = "mcp.json";

/// On unless `mcp.json` says `"enabled": false`.
pub fn enabled(dir: &Path) -> bool {
    let Ok(bytes) = std::fs::read(dir.join(FILE)) else {
        return true;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes).ok().and_then(|v| v.get("enabled")?.as_bool()).unwrap_or(true)
}

/// On is the default, so it is kept as no file at all.
pub fn set(dir: &Path, on: bool) -> io::Result<()> {
    let path = dir.join(FILE);
    if on {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(dir)?;
    let part = dir.join(format!("{FILE}.part"));
    std::fs::write(&part, b"{\"enabled\":false}\n")?;
    std::fs::rename(&part, &path)
}
