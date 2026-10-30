//! Windows: the engine labels its own folders so a low integrity process may write there, then lowers its own token to
//! low integrity. Every other folder of the user stays readable and refuses its writes. The network stays open: closing
//! it needs an AppContainer or a firewall rule.

use super::{opens_shared_folder, Outcome};
use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::ptr::{addr_of, null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetLengthSid, GetSecurityDescriptorSacl, SetTokenInformation, TokenIntegrityLevel, ACL, LABEL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_MANDATORY_LABEL,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::SystemServices::SE_GROUP_INTEGRITY;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcessToken, OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
};

/// Low processes may write the folder and everything below it, also what is made there later.
const LOW_LABEL: &str = "S:(ML;OICI;NW;;;LW)";
const LOW_SID: &str = "S-1-16-4096";

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}

fn failed(what: &str, e: io::Error) -> String {
    format!("{what} failed: {e}")
}

pub fn enter(writable: &[PathBuf]) -> Outcome {
    match lower(writable) {
        Ok(()) => Outcome::On { writes: true },
        Err(why) => Outcome::Failed(why),
    }
}

fn shared_folders() -> Vec<PathBuf> {
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let mut shared = Vec::new();
    shared.extend(var("USERPROFILE"));
    shared.extend(var("LOCALAPPDATA").map(|d| d.join("Temp")));
    if let Some(windows) = var("SystemRoot") {
        shared.push(windows.join("Temp"));
        shared.push(windows);
    }
    shared
}

fn lower(writable: &[PathBuf]) -> Result<(), String> {
    let shared = shared_folders();
    if let Some(dir) = writable.iter().find(|dir| opens_shared_folder(dir, &shared)) {
        return Err(format!(
            "{} is shared with other apps, so the engine needs a temp folder of its own",
            dir.display()
        ));
    }
    for dir in writable {
        // Labelling walks every file below, so only once.
        if !labelled_low(dir)? {
            label_low(dir)?;
        }
    }
    lower_token()
}

fn labelled_low(dir: &Path) -> Result<bool, String> {
    let what = || format!("reading the label of {}", dir.display());
    let path = wide(dir);
    let mut sd: PSECURITY_DESCRIPTOR = null_mut();
    let err = unsafe {
        GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut sd,
        )
    };
    if err != ERROR_SUCCESS {
        return Err(failed(&what(), io::Error::from_raw_os_error(err as i32)));
    }
    let (mut text, mut len) = (null_mut::<u16>(), 0u32);
    let ok = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            sd,
            SDDL_REVISION_1,
            LABEL_SECURITY_INFORMATION,
            &mut text,
            &mut len,
        )
    };
    let err = io::Error::last_os_error();
    unsafe { LocalFree(sd) };
    if ok == 0 {
        return Err(failed(&what(), err));
    }
    let sddl = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len as usize) });
    unsafe { LocalFree(text.cast()) };
    // An inherited label reads OICIID.
    Ok(sddl.replace("ID;", ";").contains("(ML;OICI;NW;;;LW)"))
}

fn label_low(dir: &Path) -> Result<(), String> {
    let (label, path) = (wide(LOW_LABEL), wide(dir));
    let mut sd: PSECURITY_DESCRIPTOR = null_mut();
    let built = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(label.as_ptr(), SDDL_REVISION_1, &mut sd, null_mut())
    };
    if built == 0 {
        return Err(failed("building the low label", io::Error::last_os_error()));
    }
    let (mut present, mut defaulted, mut sacl) = (0, 0, null_mut::<ACL>());
    let done = if unsafe { GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        let err = unsafe {
            SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null(),
                sacl,
            )
        };
        if err == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(err as i32))
        }
    };
    unsafe { LocalFree(sd) };
    done.map_err(|e| failed(&format!("labelling {} for the engine", dir.display()), e))
}

fn lower_token() -> Result<(), String> {
    let low = wide(LOW_SID);
    let mut sid: PSID = null_mut();
    if unsafe { ConvertStringSidToSidW(low.as_ptr(), &mut sid) } == 0 {
        return Err(failed("building the low integrity id", io::Error::last_os_error()));
    }
    let mut token: HANDLE = null_mut();
    let done = if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_DEFAULT, &mut token) } == 0 {
        Err(failed("opening the engine's token", io::Error::last_os_error()))
    } else {
        let label =
            TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: sid, Attributes: SE_GROUP_INTEGRITY as u32 } };
        let size = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + unsafe { GetLengthSid(sid) };
        let ok = unsafe { SetTokenInformation(token, TokenIntegrityLevel, addr_of!(label).cast(), size) };
        let err = io::Error::last_os_error();
        unsafe { CloseHandle(token) };
        if ok == 0 {
            Err(failed("lowering the engine to low integrity", err))
        } else {
            Ok(())
        }
    };
    unsafe { LocalFree(sid) };
    done
}

/// A job that ends the engine when the app lets go of it, and lets the engine start no process of its own.
pub struct Job(HANDLE);

// The handle is only closed, once, on drop.
unsafe impl Send for Job {}

impl Job {
    fn new() -> io::Result<Job> {
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(job);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = 1;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, addr_of!(info).cast(), size) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Starts `cmd` with the creation `flags` inside a new job. It is created suspended and resumed once the job holds
    /// it, so it runs no instruction outside. When no job can hold it, it runs without one and the reason comes back.
    pub fn spawn(cmd: &mut Command, flags: u32) -> io::Result<(Child, io::Result<Job>)> {
        let job = match Job::new() {
            Ok(job) => job,
            Err(e) => return Ok((cmd.creation_flags(flags).spawn()?, Err(e))),
        };
        let mut child = cmd.creation_flags(flags | CREATE_SUSPENDED).spawn()?;
        let held = match unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) } {
            0 => Err(io::Error::last_os_error()),
            _ => Ok(job),
        };
        if let Err(e) = resume(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        Ok((child, held))
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// Resumes the one thread of a process created suspended. std closes its handle, so the thread is found by its id.
fn resume(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut found = Err(io::Error::other("the new engine has no thread to resume"));
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            found = resume_thread(entry.th32ThreadID);
            break;
        }
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    found
}

fn resume_thread(id: u32) -> io::Result<()> {
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, id) };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    let resumed = unsafe { ResumeThread(thread) };
    let err = io::Error::last_os_error();
    unsafe { CloseHandle(thread) };
    if resumed == u32::MAX {
        Err(err)
    } else {
        Ok(())
    }
}
