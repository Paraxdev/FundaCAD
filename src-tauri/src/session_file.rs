//! Where a running FundaCAD says how to reach its live engine, so `fundacad-mcp` can join the session on screen. The
//! token file is user only, readable only by processes that could read the user's documents anyway, and joining the
//! open document is gated in the frontend. A file left by a crash is a hint: a reader dials and treats a refusal as no
//! app.

use std::path::{Path, PathBuf};

/// Also read by `crates/fundacad-mcp/src/app_session.rs`, which resolves the same directory from the bundle identifier.
pub const FILE_NAME: &str = "session.json";

/// Serialised by hand, four fields are not worth a serde_json dependency. `pid` is for a human telling two windows
/// apart.
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

/// Owner-only permissions. Unix has no default worth relying on, a permissive
/// umask would otherwise publish the token to every account on the machine.
#[cfg(unix)]
fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// Windows: the file inherits the per user AppData ACL, which already excludes other accounts, and an explicit ACL
/// edit would only be a way to get it wrong.
#[cfg(not(unix))]
fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Best effort: this runs on the way out, and a leftover is handled by the reader.
pub fn remove_from(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(FILE_NAME));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_json_is_what_the_reader_parses() {
        let info = SessionInfo { port: 8765, token: "abc123".into(), pid: 42 };
        assert_eq!(to_json(&info), "{\"port\":8765,\"token\":\"abc123\",\"pid\":42}\n");
    }

    /// An unescaped quote would end the string early, and every client would be refused by a file that looks fine.
    #[test]
    fn a_token_with_json_syntax_in_it_survives_the_round_trip() {
        let nasty = "a\"b\\c\nd";
        let json = to_json(&SessionInfo { port: 1, token: nasty.into(), pid: 2 });
        assert!(json.contains(r#""token":"a\"b\\c\nd""#), "{json}");
        // and the control character is not left raw, which would be invalid JSON
        assert!(!json.contains('\n') || json.ends_with('\n'));
        assert_eq!(json.matches('\n').count(), 1, "only the trailing newline: {json:?}");
    }

    #[test]
    fn writing_then_removing_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join(format!("fundacad-session-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let info = SessionInfo { port: 9000, token: "tok".into(), pid: 7 };
        let path = write_into(&dir, &info).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), to_json(&info));

        // the temporary must not survive: a reader globbing the directory, or a
        // human, should see exactly one file
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec![FILE_NAME.to_string()], "a temporary file survived");

        remove_from(&dir);
        assert!(!path.exists(), "the session file outlived the app");
        // ...and removing what is not there is not an error, because that is the
        // ordinary case on a second exit path
        remove_from(&dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_token_is_not_readable_by_other_accounts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fundacad-session-perm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = write_into(&dir, &SessionInfo { port: 1, token: "t".into(), pid: 1 }).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the session file is group/world readable");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
