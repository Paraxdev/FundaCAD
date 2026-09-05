//! Where a running FundaCAD says how to reach it.
//!
//! The sidecar's port and token live in this process's memory and nowhere else,
//! which is why an outside program — the MCP server in `mcp/`, a probe script —
//! has never been able to join a session in progress. It could only start a
//! second engine of its own and work on a copy. That is a safe default and a
//! poor one for the thing an agent is most often asked to do, which is change
//! the part the user is looking at.
//!
//! So a running app drops one small file naming its port and token, and removes
//! it on the way out.
//!
//! ## The token is now on disk, and that is a real change
//!
//! Whoever holds the token can drive the geometry engine: rebuild, import,
//! export. The file is written user-only (0600 on Unix; on Windows the per-user
//! AppData tree is already ACLed to the account), so the reader has to be a
//! process running as this user — which is a process that can already read the
//! user's documents directly. The engine adds no reach beyond that.
//!
//! What it DOES add is reach into the document open in the app right now, and
//! that is gated separately, in the frontend, by a setting the user can see and
//! an indicator that says when someone is attached. Nothing here grants it.
//!
//! ## A file left behind by a crash means nothing
//!
//! The file is removed on a clean exit and NOT on a kill, so a stale one is
//! ordinary. It is therefore a hint, never an assertion: a reader has to dial
//! the port and present the token, and treat a refusal as "no app". Liveness is
//! not stored — a pid can be recycled, and checking one portably is more code
//! than the handshake the reader needs to do anyway.

use std::path::{Path, PathBuf};

/// The file's name inside the app data directory. Read by `mcp/app_session.py`,
/// which resolves the same directory from the bundle identifier — change one and
/// the other stops finding it, which is why both name the constant in a comment.
pub const FILE_NAME: &str = "session.json";

/// The document this app writes about itself. Serialised by hand: it is four
/// fields and a dependency on serde_json for them would be the tail wagging the
/// dog. `port` and `token` are what a client needs; `pid` is for a human reading
/// the file while working out which of two windows they are looking at.
#[derive(Debug, PartialEq, Eq)]
pub struct SessionInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// JSON for a session file. Pure, so the escaping can be asserted without a
/// filesystem.
///
/// The token comes from `random_token`, which is hex, so it needs no escaping —
/// but writing it unescaped would make this function correct only for as long as
/// that stays true, and a token containing a quote would produce a file that
/// silently parses into a DIFFERENT token. Escaped, always.
pub fn to_json(info: &SessionInfo) -> String {
    format!(
        "{{\"port\":{},\"token\":{},\"pid\":{}}}\n",
        info.port,
        json_string(&info.token),
        info.pid
    )
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

/// Write the session file under `dir`, creating the directory if needed.
///
/// Written to a temporary name and renamed into place, because a reader can
/// arrive at any moment and a half-written file is a parse error the reader
/// would have to distinguish from a missing one. Rename is atomic on both
/// platforms we ship.
pub fn write_into(dir: &Path, info: &SessionInfo) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(FILE_NAME);
    let tmp = dir.join(format!("{FILE_NAME}.{}.tmp", info.pid));
    std::fs::write(&tmp, to_json(info))?;
    restrict(&tmp)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Owner-only permissions. Unix has no default worth relying on — a permissive
/// umask would otherwise publish the token to every account on the machine.
#[cfg(unix)]
fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// Windows: the file inherits the ACL of the per-user AppData directory, which
/// already excludes other accounts. Nothing to tighten, and an explicit ACL edit
/// here would be a way to get it wrong.
#[cfg(not(unix))]
fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Remove the file. Best-effort by design: this runs on the way out, and an app
/// that refused to exit because it could not delete a hint file would be trading
/// a small problem for a much larger one. A leftover is handled by the reader.
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

    /// A token is hex today. If it ever stops being, an unescaped quote would
    /// end the string early and the file would parse into a token that is not
    /// the one this app is using — every client refused, and the file looking
    /// perfectly fine to a human reading it.
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
