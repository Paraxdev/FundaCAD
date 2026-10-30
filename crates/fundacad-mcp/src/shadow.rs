//! Runs the server from a temp copy of itself and its engine, since Windows refuses to replace
//! a running executable and every `cargo build` would fail while a host holds the server open.
//! FUNDACAD_MCP_SHADOW=0 turns it off, =1 turns it on elsewhere, which is how tests reach it on Linux.

use std::fs::File;
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

fn shadow_dir() -> PathBuf {
    std::env::temp_dir().join("fundacad-mcp-shadow")
}

/// A folder of this account's own, not a link to one, so no other account can have put files in it first.
pub fn own_folder(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()) && owned_by_this_account(dir)
}

#[cfg(not(windows))]
fn owned_by_this_account(_dir: &Path) -> bool {
    true
}

/// The folder's owner is this process's user, or the owner its token gives new files, which for an
/// elevated administrator can be the Administrators group.
#[cfg(windows)]
fn owned_by_this_account(dir: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        EqualSid, GetFileSecurityW, GetSecurityDescriptorOwner, GetTokenInformation, TokenOwner, TokenUser,
        OWNER_SECURITY_INFORMATION, PSID, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // u64 words keep the buffers aligned for the structs Windows writes into them.
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut need = 0u32;
    unsafe { GetFileSecurityW(wide.as_ptr(), OWNER_SECURITY_INFORMATION, std::ptr::null_mut(), 0, &mut need) };
    let mut sd = vec![0u64; (need as usize).div_ceil(8)];
    if need == 0
        || unsafe {
            GetFileSecurityW(wide.as_ptr(), OWNER_SECURITY_INFORMATION, sd.as_mut_ptr().cast(), need, &mut need)
        } == 0
    {
        return false;
    }
    let (mut owner, mut defaulted): (PSID, i32) = (std::ptr::null_mut(), 0);
    if unsafe { GetSecurityDescriptorOwner(sd.as_mut_ptr().cast(), &mut owner, &mut defaulted) } == 0 || owner.is_null()
    {
        return false;
    }
    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    // TOKEN_USER and TOKEN_OWNER both start with the SID pointer.
    let ours = [TokenUser, TokenOwner].into_iter().any(|class| {
        let mut need = 0u32;
        unsafe { GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut need) };
        let mut buf = vec![0u64; (need as usize).div_ceil(8)];
        need != 0
            && unsafe { GetTokenInformation(token, class, buf.as_mut_ptr().cast(), need, &mut need) } != 0
            && unsafe { EqualSid(*buf.as_ptr().cast::<PSID>(), owner) } != 0
    });
    unsafe { CloseHandle(token) };
    ours
}

/// Opened so that, while it is held, nobody can write, move or delete the file, and the bytes compared
/// are the bytes that run.
fn held(path: &Path) -> std::io::Result<File> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        o.share_mode(FILE_SHARE_READ);
    }
    o.open(path)
}

/// The copy, held, when it has the executable's bytes.
fn held_copy(exe: &Path, copy: &Path) -> Option<File> {
    let mut kept = held(copy).ok()?;
    let mut original = File::open(exe).ok()?;
    same_bytes(&mut original, &mut kept).then_some(kept)
}

/// Named by size and modified time, so a rebuilt binary gets a fresh copy, and an unchanged one is reused
/// only while its bytes still match the executable. The handle keeps the copy as it is while held.
fn copy_of(exe: &Path) -> std::io::Result<(PathBuf, File)> {
    let meta = std::fs::metadata(exe)?;
    let stamp =
        meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("fundacad");
    let ext = exe.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let dir = shadow_dir();
    std::fs::create_dir_all(&dir)?;
    if !own_folder(&dir) {
        return Err(std::io::Error::other(format!("{} is a link or another account's folder", dir.display())));
    }
    let name = format!("{stem}-{}-{stamp}{ext}", meta.len());
    let dest = dir.join(&name);
    if let Some(kept) = held_copy(exe, &dest) {
        return Ok((dest, kept));
    }
    // Written beside and renamed into place, so a second server starting at
    // the same moment never runs a half-written copy.
    let partial = dir.join(format!("{name}.{}.partial", std::process::id()));
    std::fs::copy(exe, &partial)?;
    if std::fs::rename(&partial, &dest).is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    match held_copy(exe, &dest) {
        Some(kept) => Ok((dest, kept)),
        None => Err(std::io::Error::other("the copy could not be put in place")),
    }
}

fn same_bytes(ra: &mut File, rb: &mut File) -> bool {
    use std::io::Read;
    if ra.metadata().map(|m| m.len()).ok() != rb.metadata().map(|m| m.len()).ok() {
        return false;
    }
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = match ra.read(&mut ba) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if n == 0 {
            return rb.read(&mut bb[..1]).is_ok_and(|m| m == 0);
        }
        if rb.read_exact(&mut bb[..n]).is_err() || ba[..n] != bb[..n] {
            return false;
        }
    }
}

/// A copy still running is locked and stays, which is what should happen to it.
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
    parts.iter().map(|p| format!("\"{p}\"")).collect::<Vec<_>>().join(" ")
}

/// The engine the original would have found, swapped for a copy when it is a file of ours.
/// None leaves the copy to find it, which it would do from the temp directory.
fn engine_for_copy(exe: &Path, copy: &Path) -> Option<(String, Option<(PathBuf, File)>)> {
    if link::appenv("ENGINE_CMD").is_some_and(|c| !c.trim().is_empty()) {
        return None;
    }
    let mut cmd = link::engine_command();
    let program = PathBuf::from(cmd.first()?);
    if !program.is_file() {
        return None;
    }
    let same = |a: &Path, b: &Path| a.canonicalize().ok().zip(b.canonicalize().ok()).is_some_and(|(a, b)| a == b);
    let (swapped, extra) = if same(&program, exe) {
        (copy.to_path_buf(), None)
    } else {
        let (c, kept) = copy_of(&program).ok()?;
        (c.clone(), Some((c, kept)))
    };
    cmd[0] = swapped.to_string_lossy().into_owned();
    Some((quoted(&cmd), extra))
}

/// The copy's exit code, or None to run the server in this process, also when making or starting the copy fails.
pub fn run_from_copy() -> Option<i32> {
    if !enabled() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let (copy, kept) = match copy_of(&exe) {
        Ok(c) => c,
        Err(e) => {
            crate::server::log(&format!("[mcp] running in place, no copy of the executable: {e}"));
            return None;
        }
    };
    let mut cmd = Command::new(&copy);
    cmd.args(std::env::args_os().skip(1)).env(RUNNING_COPY, &exe);
    let mut keep = vec![copy.clone()];
    // Held until the copy exits, which is as long as it may start the engine.
    let mut held_files = vec![kept];
    if let Some((engine, extra)) = engine_for_copy(&exe, &copy) {
        cmd.env("FUNDACAD_ENGINE_CMD", engine);
        if let Some((path, file)) = extra {
            keep.push(path);
            held_files.push(file);
        }
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
    drop(held_files);
    Some(code)
}
