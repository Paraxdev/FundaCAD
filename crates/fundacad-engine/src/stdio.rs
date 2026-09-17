//! The worker's transport to the app: framed messages on stdin and stdout.
//!
//! OpenCASCADE writes diagnostics to the C runtime's stdout, which would land
//! inside a frame, so the frames get a private duplicate of the stdout handle
//! and descriptor 1 is pointed at stderr before any kernel code runs.

use crate::{Engine, EngineOptions, Jobs, Outbox};
use fundacad_protocol::{read_message, write_message, Message};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::sync::{Arc, Mutex};

struct FrameOut(Mutex<BufWriter<File>>);

impl Outbox for FrameOut {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        let mut w = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for m in msgs {
            write_message(&mut *w, &m)?;
        }
        w.flush()
    }
}

/// Serves requests from stdin until the app closes it, then exits the process.
/// Exiting on EOF is also what ends a worker whose app crashed, even while a
/// kernel call is still running on the job thread.
pub fn run<J: Jobs + Default>(jobs: J) -> ! {
    let frames = match take_stdout() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("engine: cannot take stdout for frames: {e}");
            std::process::exit(2);
        }
    };
    // No cancel grace: the app's supervisor restarts a worker that ignores a
    // cancel, which frees what an abandoned job thread would keep.
    let engine = Engine::start_with(
        jobs,
        Some(Arc::new(J::default)),
        EngineOptions::from_env(),
        Arc::new(FrameOut(Mutex::new(BufWriter::new(frames)))),
    );
    let mut stdin = io::stdin().lock();
    loop {
        match read_message(&mut stdin) {
            Ok(Some(msg)) => engine.handle(msg),
            Ok(None) => std::process::exit(0),
            Err(e) => {
                eprintln!("engine: bad frame from the app: {e}");
                std::process::exit(3);
            }
        }
    }
}

/// A private handle on the real stdout, with descriptor 1 and the OS standard
/// handle pointed at stderr, so kernel diagnostics cannot corrupt what the
/// caller writes. Call it before any other thread exists.
pub fn take_stdout() -> io::Result<File> {
    io::stdout().flush()?;
    // SAFETY: plain descriptor calls on the process's own standard streams,
    // before any other thread exists.
    unsafe {
        let fd = libc::dup(1);
        if fd < 0 || libc::dup2(2, 1) < 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(windows)]
        {
            // Rust's own stdout asks the OS for the standard handle, which the
            // CRT's dup2 does not move in a GUI subsystem process.
            use windows_sys::Win32::System::Console::{
                GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
            };
            SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE));
        }
        file_from_fd(fd)
    }
}

#[cfg(unix)]
unsafe fn file_from_fd(fd: libc::c_int) -> io::Result<File> {
    use std::os::unix::io::FromRawFd;
    Ok(File::from_raw_fd(fd))
}

#[cfg(windows)]
unsafe fn file_from_fd(fd: libc::c_int) -> io::Result<File> {
    use std::os::windows::io::FromRawHandle;
    let handle = libc::get_osfhandle(fd);
    if handle == -1 {
        return Err(io::Error::last_os_error());
    }
    // The CRT descriptor is leaked on purpose: the File owns the OS handle and
    // lives as long as the process.
    Ok(File::from_raw_handle(handle as _))
}
