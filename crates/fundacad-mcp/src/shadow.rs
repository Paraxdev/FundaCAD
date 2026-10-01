//! Runs the MCP server from a copy of its own executable, so a `cargo build`
//! can overwrite the original while a host keeps the server running.
//!
//! Windows refuses to replace an executable that a process is running from:
//! with a host holding `fundacad.exe --mcp` open, every `cargo build` of the
//! app fails with "Access is denied" until the host is closed. The same is
//! true of the engine the server spawns from beside it. So on Windows the
//! process the host starts copies itself (and the engine it would start) into
//! the temp directory, runs the copy with the same arguments and stdio, and
//! passes its exit code back. The build then writes the original freely, and
//! the next server the host starts runs the new build.
//!
//! `FUNDACAD_MCP_SHADOW=0` turns it off, `=1` turns it on elsewhere, which is
//! how the tests reach it on Linux.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::link;

/// Set on the copy so it runs the server instead of copying itself again.
const RUNNING_COPY: &str = "FUNDACAD_MCP_SHADOW_OF";

fn enabled() -> bool {
    if std::env::var_os(RUNNING_COPY).is_some() {
        return false;
    }
    match link::appenv("MCP_SHADOW").as_deref().map(str::trim) {
        Some("0") | Some("false") | Some("off") => false,
        Some("1") | Some("true") | Some("on") => true,
        _ => cfg!(windows),
    }
}

/// The original executable when this process is the copy.
pub fn original_exe() -> Option<PathBuf> {
    std::env::var_os(RUNNING_COPY).map(PathBuf::from)
}

/// Where the copies live: one directory under the system temp directory.
fn shadow_dir() -> PathBuf {
    std::env::temp_dir().join("fundacad-mcp-shadow")
}

/// A copy of `exe` in the shadow directory, named by its size and modified
/// time so a rebuilt binary gets a fresh copy and an unchanged one is reused.
fn copy_of(exe: &Path) -> std::io::Result<PathBuf> {
    let meta = std::fs::metadata(exe)?;
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("fundacad");
    let ext = exe
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let dir = shadow_dir();
    std::fs::create_dir_all(&dir)?;
    let name = format!("{stem}-{}-{stamp}{ext}", meta.len());
    let dest = dir.join(&name);
    if std::fs::metadata(&dest).is_ok_and(|m| m.len() == meta.len()) {
        return Ok(dest);
    }
    // Written beside and renamed into place, so a second server starting at
    // the same moment never runs a half-written copy.
    let partial = dir.join(format!("{name}.{}.partial", std::process::id()));
    std::fs::copy(exe, &partial)?;
    if std::fs::rename(&partial, &dest).is_err() {
        let _ = std::fs::remove_file(&partial);
        if !dest.is_file() {
            return Err(std::io::Error::other("the copy could not be put in place"));
        }
    }
    Ok(dest)
}

/// Removes copies of `stem` other than `keep`. One still running is locked
/// and stays, which is what should happen to it.
fn sweep(stem: &str, keep: &[&Path]) {
    let Ok(entries) = std::fs::read_dir(shadow_dir()) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let ours = p
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix(stem)?.strip_prefix('-'))
            .map(|rest| rest.split('.').next().unwrap_or_default())
            .is_some_and(|rest| {
                let parts: Vec<&str> = rest.split('-').collect();
                parts.len() == 2 && parts.iter().all(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
            });
        if ours && !keep.contains(&p.as_path()) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

fn quoted(parts: &[String]) -> String {
    parts
        .iter()
        .map(|p| format!("\"{p}\""))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The engine command the copy should use: the one the original would have
/// found, with its program swapped for a copy when it is a file of ours.
/// None leaves the copy to find it, which it would do from the temp directory.
fn engine_for_copy(exe: &Path, copy: &Path) -> Option<(String, Vec<PathBuf>)> {
    if link::appenv("ENGINE_CMD").is_some_and(|c| !c.trim().is_empty()) {
        return None;
    }
    let mut cmd = link::engine_command();
    let program = PathBuf::from(cmd.first()?);
    if !program.is_file() {
        return None;
    }
    let same = |a: &Path, b: &Path| {
        a.canonicalize().ok().zip(b.canonicalize().ok()).is_some_and(|(a, b)| a == b)
    };
    let (swapped, extra) = if same(&program, exe) {
        (copy.to_path_buf(), Vec::new())
    } else {
        let c = copy_of(&program).ok()?;
        (c.clone(), vec![c])
    };
    cmd[0] = swapped.to_string_lossy().into_owned();
    Some((quoted(&cmd), extra))
}

/// Runs the server from a copy when that is called for, and returns the
/// copy's exit code; None means run the server in this process, which is also
/// the answer whenever making or starting the copy fails.
pub fn run_from_copy() -> Option<i32> {
    if !enabled() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let copy = match copy_of(&exe) {
        Ok(c) => c,
        Err(e) => {
            crate::server::log(&format!("[mcp] running in place, no copy of the executable: {e}"));
            return None;
        }
    };
    let mut cmd = Command::new(&copy);
    cmd.args(std::env::args_os().skip(1)).env(RUNNING_COPY, &exe);
    let mut keep = vec![copy.clone()];
    if let Some((engine, extra)) = engine_for_copy(&exe, &copy) {
        cmd.env("FUNDACAD_ENGINE_CMD", engine);
        keep.extend(extra);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            crate::server::log(&format!("[mcp] running in place, the copy would not start: {e}"));
            return None;
        }
    };
    // A host stops its servers with TerminateProcess, which would leave the
    // copy running with nobody on its stdio; the job takes it down with us.
    #[cfg(windows)]
    let job = {
        let job = link::job::ProcessJob::new();
        job.adopt(child.id());
        job
    };
    let keep_refs: Vec<&Path> = keep.iter().map(PathBuf::as_path).collect();
    for p in &keep {
        if let Some(stem) = p.file_name().and_then(|n| n.to_str()).and_then(|n| n.rsplitn(3, '-').nth(2)) {
            sweep(stem, &keep_refs);
        }
    }
    // Once the copy is running, this process must not start a second server
    // on the same stdio, so a failed wait is a failed run.
    let code = child.wait().map_or(1, |s| s.code().unwrap_or(1));
    #[cfg(windows)]
    drop(job);
    Some(code)
}
