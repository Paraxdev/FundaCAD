//! The engine's reduced rights from the inside: this test binary starts itself as a child that enters the sandbox the
//! way the engine does, then tries what a hijacked engine would try, and reports each attempt on its stdout.

use fundacad_engine::sandbox::{self, Policy};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn report(key: &str, attempt: io::Result<()>) {
    match attempt {
        Ok(()) => println!("{key}=ok"),
        Err(e) => println!("{key}=err {e}"),
    }
    io::stdout().flush().unwrap();
}

fn accept_one(door: &TcpListener) -> io::Result<()> {
    door.set_nonblocking(true)?;
    let t0 = Instant::now();
    let (mut stream, _) = loop {
        match door.accept() {
            Ok(pair) => break pair,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock && t0.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    };
    stream.set_nonblocking(false)?;
    let mut hello = [0u8; 2];
    stream.read_exact(&mut hello)?;
    if &hello != b"hi" {
        return Err(io::Error::other("the door read something else"));
    }
    Ok(())
}

fn child(allowed: &Path, outside: &Path, port: u16, documents: &str) {
    let outcome = sandbox::enter(Policy::Tool, &[allowed.to_path_buf()]);
    println!("outcome={outcome:?}");
    // Stands in for the live door, which binds after enter and before close_network.
    let door = TcpListener::bind("127.0.0.1:0");
    println!("door_bind={}", door.as_ref().map_or_else(|e| format!("err {e}"), |_| "ok".into()));
    sandbox::close_network(&outcome);

    report("write_allowed", std::fs::write(allowed.join("inside.txt"), b"ok"));
    report("write_outside", std::fs::write(outside.join("escaped.txt"), b"no"));
    report("read_outside", std::fs::read(outside.join("read.txt")).map(|_| ()));
    if documents != "-" {
        report("write_documents", std::fs::write(documents, b"no"));
    }
    #[cfg(windows)]
    report("start_process", Command::new("cmd").args(["/c", "exit"]).status().map(|_| ()));
    report("tcp_connect", TcpStream::connect(("127.0.0.1", port)).map(|_| ()));
    report("udp_socket", UdpSocket::bind("127.0.0.1:0").map(|_| ()));
    #[cfg(unix)]
    report("unix_socket", std::os::unix::net::UnixDatagram::unbound().map(|_| ()));

    if let Ok(door) = door {
        println!("door={}", door.local_addr().unwrap().port());
        io::stdout().flush().unwrap();
        report("door_accept", accept_one(&door));
    }
}

struct Probe {
    results: HashMap<String, String>,
    stderr: String,
}

impl Probe {
    fn get(&self, key: &str) -> &str {
        self.results.get(key).map(String::as_str).unwrap_or_else(|| panic!("no {key} in {:?}", self.results))
    }

    fn ok(&self, key: &str) {
        assert_eq!(self.get(key), "ok", "{key}, stderr: {}", self.stderr);
    }

    /// Access denied, so the refusal came from the sandbox and not from a missing listener or file.
    #[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
    fn refused(&self, key: &str) {
        let denied = if cfg!(windows) { "os error 5" } else { "os error 13" };
        let got = self.get(key);
        assert!(got.starts_with("err") && got.contains(denied), "{key}: {got}, stderr: {}", self.stderr);
    }
}

/// A file the child tries to write among the user's documents, when that folder exists here.
fn documents_file() -> Option<PathBuf> {
    let documents =
        PathBuf::from(std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?).join("Documents");
    documents.is_dir().then(|| documents.join(format!("fundacad-sandbox-probe-{}.txt", std::process::id())))
}

fn run_probe(root: &Path) -> Probe {
    let allowed = root.join("allowed");
    let outside = root.join("outside");
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("read.txt"), b"a user file").unwrap();
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let documents = documents_file();
    let port = target.local_addr().unwrap().port();

    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.arg("--child")
        .arg(&allowed)
        .arg(&outside)
        .arg(port.to_string())
        .arg(documents.as_deref().unwrap_or(Path::new("-")))
        .env(sandbox::ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    let (mut child, job) = sandbox::Job::spawn(&mut cmd, 0).expect("spawn the probe child");
    #[cfg(windows)]
    let _job = job.expect("put the probe child in a job");
    #[cfg(not(windows))]
    let mut child = cmd.spawn().expect("spawn the probe child");
    let mut stderr = child.stderr.take().unwrap();
    let stderr = std::thread::spawn(move || {
        let mut s = String::new();
        stderr.read_to_string(&mut s).ok();
        s
    });
    let mut results = HashMap::new();
    for line in BufReader::new(child.stdout.take().unwrap()).lines() {
        let line = line.unwrap();
        let Some((key, value)) = line.split_once('=') else { continue };
        if key == "door" {
            let mut knock = TcpStream::connect(("127.0.0.1", value.parse::<u16>().unwrap())).unwrap();
            knock.write_all(b"hi").unwrap();
        }
        results.insert(key.to_string(), value.to_string());
    }
    let status = child.wait().unwrap();
    let stderr = stderr.join().unwrap();
    assert!(status.success(), "probe child exited with {status}, stderr: {stderr}");
    let escaped = outside.join("escaped.txt");
    if escaped.exists() {
        results.insert("escaped_file".into(), "exists".into());
    }
    if let Some(file) = documents.filter(|file| file.exists()) {
        std::fs::remove_file(file).ok();
        results.insert("escaped_documents".into(), "exists".into());
    }
    Probe { results, stderr }
}

fn the_engine_keeps_what_it_needs(p: &Probe) {
    p.ok("door_bind");
    p.ok("write_allowed");
    p.ok("read_outside");
    p.ok("door_accept");
}

#[cfg(target_os = "linux")]
fn the_engine_cannot_write_outside_its_folders_or_open_a_socket(p: &Probe) {
    let outcome = p.get("outcome");
    assert!(outcome.starts_with("On"), "outcome {outcome}, stderr: {}", p.stderr);
    if outcome.contains("writes: true") {
        p.refused("write_outside");
        assert!(!p.results.contains_key("escaped_file"), "the file outside was written");
    } else {
        println!("note: landlock not available on this kernel, so the write outside was not checked");
    }
    p.refused("tcp_connect");
    p.refused("udp_socket");
    p.refused("unix_socket");
    assert!(p.stderr.trim().is_empty(), "the sandbox logged: {}", p.stderr);
}

#[cfg(windows)]
fn the_engine_cannot_write_outside_its_folders_or_open_a_socket(p: &Probe) {
    let outcome = p.get("outcome");
    assert!(outcome.starts_with("On"), "outcome {outcome}, stderr: {}", p.stderr);
    p.refused("write_outside");
    assert!(!p.results.contains_key("escaped_file"), "the file outside was written");
    if p.results.contains_key("write_documents") {
        p.refused("write_documents");
        assert!(!p.results.contains_key("escaped_documents"), "the file in Documents was written");
    } else {
        println!("note: no Documents folder here, so that write was not checked");
    }
    assert!(p.get("start_process").starts_with("err"), "the job let the engine start a process");
    // Closing the network on Windows needs an AppContainer or a firewall rule.
    p.ok("tcp_connect");
    p.ok("udp_socket");
    assert!(p.stderr.trim().is_empty(), "the sandbox logged: {}", p.stderr);
}

/// The engine ends when the app drops its job, even when the app itself is killed and closes no pipe.
#[cfg(windows)]
fn the_job_ends_the_engine_when_the_app_lets_go() {
    let (mut child, job) = sandbox::Job::spawn(Command::new(std::env::current_exe().unwrap()).arg("--sleep"), 0)
        .expect("spawn the sleeper");
    let job = job.expect("put the sleeper in a job");
    assert!(child.try_wait().unwrap().is_none(), "the sleeper ended early");
    drop(job);
    let t0 = Instant::now();
    while child.try_wait().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(10), "the sleeper outlived its job");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The engine is created suspended and runs only once its job holds it, so not one instruction runs outside.
#[cfg(windows)]
fn the_engine_runs_only_inside_its_job() {
    let (mut child, job) =
        sandbox::Job::spawn(Command::new(std::env::current_exe().unwrap()).arg("--in-job"), 0).expect("spawn in a job");
    let _job = job.expect("a job holds the engine");
    assert_eq!(child.wait().unwrap().code(), Some(0), "the engine ran outside its job");
}

/// Exits 0 only when this process already belongs to a job.
#[cfg(windows)]
fn in_job() -> ! {
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut inside = 0;
    let ok = unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut inside) };
    std::process::exit(if ok != 0 && inside != 0 { 0 } else { 3 })
}

#[cfg(not(any(target_os = "linux", windows)))]
fn the_engine_cannot_write_outside_its_folders_or_open_a_socket(p: &Probe) {
    println!("note: no reduced rights on this platform yet, outcome {}", p.get("outcome"));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--child") => return child(Path::new(&args[2]), Path::new(&args[3]), args[4].parse().unwrap(), &args[5]),
        Some("--sleep") => return std::thread::sleep(Duration::from_secs(30)),
        #[cfg(windows)]
        Some("--in-job") => in_job(),
        _ => {}
    }
    let root: PathBuf = std::env::temp_dir().join(format!("fundacad-sandbox-probe-{}", std::process::id()));
    let probe = run_probe(&root);
    std::fs::remove_dir_all(&root).ok();
    for (name, test) in [
        ("the_engine_keeps_what_it_needs", the_engine_keeps_what_it_needs as fn(&Probe)),
        (
            "the_engine_cannot_write_outside_its_folders_or_open_a_socket",
            the_engine_cannot_write_outside_its_folders_or_open_a_socket,
        ),
    ] {
        test(&probe);
        println!("test {name} ... ok");
    }
    #[cfg(windows)]
    {
        the_job_ends_the_engine_when_the_app_lets_go();
        println!("test the_job_ends_the_engine_when_the_app_lets_go ... ok");
        the_engine_runs_only_inside_its_job();
        println!("test the_engine_runs_only_inside_its_job ... ok");
    }
}
