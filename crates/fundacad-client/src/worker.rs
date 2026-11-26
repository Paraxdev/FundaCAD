//! One engine worker process: spawned with piped stdio, its frames and its exit forwarded to the driver.

use crate::Input;
use fundacad_protocol::{read_message, write_message, Message};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

const STDERR_KEEP: usize = 40;

/// How to start a worker: the engine binary, `--stdio` by default, and its environment.
#[derive(Debug, Clone)]
pub struct WorkerCommand {
    pub exe: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    /// The worker's own temp folder. Given, the worker runs sandboxed with it as its only writable place; None runs it
    /// with the user's full rights.
    pub temp: Option<PathBuf>,
}

impl WorkerCommand {
    pub fn new(exe: impl Into<PathBuf>) -> WorkerCommand {
        WorkerCommand { exe: exe.into(), args: vec!["--stdio".into()], env: Vec::new(), temp: None }
    }

    /// `FUNDACAD_ENGINE_EXE` when set, else `fundacad-engine` beside the running executable or one folder up, which
    /// is where cargo puts it for an example or a test.
    pub fn locate() -> io::Result<WorkerCommand> {
        if let Some(exe) = std::env::var_os("FUNDACAD_ENGINE_EXE") {
            return Ok(WorkerCommand::new(exe));
        }
        let name = format!("fundacad-engine{}", std::env::consts::EXE_SUFFIX);
        let here = std::env::current_exe()?;
        here.ancestors()
            .skip(1)
            .take(2)
            .map(|d| d.join(&name))
            .find(|p| p.is_file())
            .map(WorkerCommand::new)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("no {name} beside {}", here.display())))
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> WorkerCommand {
        self.env.push((key.into(), value.into()));
        self
    }
}

pub(crate) enum FromWorker {
    Frame(u64, Message, usize),
    Ended(u64, String),
}

pub(crate) struct Worker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    pub stderr_tail: Arc<Mutex<VecDeque<String>>>,
    #[cfg(windows)]
    _job: Option<fundacad_engine::sandbox::Job>,
}

impl Worker {
    pub fn spawn(cmd: &WorkerCommand, generation: u64, to: Sender<Input>) -> io::Result<Worker> {
        let mut c = Command::new(&cmd.exe);
        c.args(&cmd.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in &cmd.env {
            c.env(k, v);
        }
        let policy = std::env::var(fundacad_engine::sandbox::ENV).ok();
        let reduced = fundacad_engine::sandbox::worker_env(&mut c, cmd.temp.as_deref(), policy.as_deref());
        #[cfg(windows)]
        let (mut child, job) = spawn_in_job(&mut c, reduced)?;
        #[cfg(not(windows))]
        let mut child = {
            let _ = reduced;
            c.spawn()?
        };
        let stdin = child.stdin.take().ok_or_else(|| io::Error::other("no worker stdin"))?;
        let mut stdout = child.stdout.take().ok_or_else(|| io::Error::other("no worker stdout"))?;
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            std::thread::Builder::new().name("engine-stderr".into()).spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    // Never eprintln: with nobody reading our stderr it panics, and a worker whose stderr is not
                    // drained blocks on its next log line mid job.
                    let _ = writeln!(io::stderr(), "[engine] {line}");
                    let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
                    if t.len() == STDERR_KEEP {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            })?;
        }
        std::thread::Builder::new().name("engine-frames".into()).spawn(move || loop {
            match read_message(&mut stdout) {
                Ok(Some(m)) => {
                    let n = m.payload().len() + 5;
                    if to.send(Input::Worker(FromWorker::Frame(generation, m, n))).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = to.send(Input::Worker(FromWorker::Ended(generation, "the worker closed its output".into())));
                    return;
                }
                Err(e) => {
                    let _ = to.send(Input::Worker(FromWorker::Ended(generation, format!("bad frame from the worker: {e}"))));
                    return;
                }
            }
        })?;
        Ok(Worker {
            child,
            stdin: BufWriter::new(stdin),
            stderr_tail,
            #[cfg(windows)]
            _job: job,
        })
    }

    pub fn send(&mut self, text: String) -> io::Result<()> {
        write_message(&mut self.stdin, &Message::Text(text))
    }

    /// Ends the process and says how it ended. Its output already closed, so one still running is wedged.
    pub fn reap(mut self) -> String {
        let _ = self.child.kill();
        match self.child.wait() {
            Ok(s) => match s.code() {
                Some(fundacad_engine::EXIT_BREACH) => "it ended itself over a stalled job".into(),
                _ => s.to_string(),
            },
            Err(e) => e.to_string(),
        }
    }

    pub fn tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect()
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

/// Each worker runs in its own job, part of its reduced rights: it ends with the app and starts no process.
#[cfg(windows)]
fn spawn_in_job(cmd: &mut Command, reduced: bool) -> io::Result<(Child, Option<fundacad_engine::sandbox::Job>)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if !reduced {
        return Ok((cmd.creation_flags(CREATE_NO_WINDOW).spawn()?, None));
    }
    let (child, job) = fundacad_engine::sandbox::Job::spawn(cmd, CREATE_NO_WINDOW)?;
    let job = job.inspect_err(|e| {
        let _ = writeln!(io::stderr(), "[engine] runs outside its job, {e}");
    });
    Ok((child, job.ok()))
}
