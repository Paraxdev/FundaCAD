//! Does the geometry engine die with the server that started it? A port of
//! the Python MCP server's `test_lifetime.py`.
//!
//! This is not housekeeping. Each session spawns an engine holding a loaded
//! OpenCASCADE; an MCP host kills its servers with TerminateProcess, which runs
//! no cleanup. Measured on the Python server before this was fixed: 53
//! processes left behind, after which a fresh engine could not start and every
//! build failed with an error about the machine, from a machine that had been
//! fine an hour earlier.
//!
//! So the test kills the OWNER the way a host would, with no chance to clean
//! up, and asks whether the engine is still there. The control is the same run
//! with nothing holding the child, which must leave it alive, otherwise this
//! would pass on a machine where something else happens to be reaping the
//! process, and prove nothing.
//!
//! Windows only. The job object exists because Windows has neither
//! PR_SET_PDEATHSIG nor a parent to poll for, and the app's own shell is the
//! only other thing that supplies one.

mod common;

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn owner_binary() -> PathBuf {
    let exe = std::env::current_exe().expect("a test binary has a path");
    let profile = exe
        .parent()
        .and_then(Path::parent)
        .expect("target/<profile>/deps");
    profile.join("examples").join(if cfg!(windows) {
        "engine_owner.exe"
    } else {
        "engine_owner"
    })
}

fn alive(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("tasklist is on Windows");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

fn kill(pid: u32, tree: bool) {
    let mut cmd = Command::new("taskkill");
    cmd.arg("/F");
    if tree {
        cmd.arg("/T");
    }
    let _ = cmd.args(["/PID", &pid.to_string()]).output();
}

/// Start an owner, kill it hard, and report whether the engine outlived it.
fn run_case(job: bool) -> (u32, bool) {
    let owner = owner_binary();
    assert!(
        owner.is_file(),
        "build the example first: {}",
        owner.display()
    );
    let mut child = Command::new(&owner)
        .arg(if job { "job" } else { "nojob" })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the owner runs");
    let stdout = child.stdout.take().expect("piped");
    let mut lines = BufReader::new(stdout).lines();
    let pid = lines
        .by_ref()
        .take(50)
        .filter_map(Result::ok)
        .find_map(|l| l.strip_prefix("PID ").and_then(|p| p.trim().parse().ok()))
        .unwrap_or_else(|| {
            let _ = child.kill();
            panic!("the owner never reported an engine pid")
        });
    assert!(alive(pid), "the engine was not running before the kill");

    // TerminateProcess on the OWNER only: no tree sweep, and nothing in the
    // owner gets to run. This is what a host does.
    kill(child.id(), false);
    let _ = child.wait();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if !alive(pid) {
            return (pid, false);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    (pid, true)
}

#[test]
fn the_engine_dies_when_its_owner_is_killed_outright() {
    if !cfg!(windows) {
        return; // the engine's own die-with-parent covers Linux and macOS
    }
    let (pid, left) = run_case(true);
    if left {
        kill(pid, true);
        panic!("{pid} outlived the process that started it");
    }
}

#[test]
fn the_control_without_a_job_object_leaks() {
    // Without the job object the engine MUST survive. If it does not, something
    // else on this machine is reaping it and the test above proves nothing.
    if !cfg!(windows) {
        return;
    }
    let (pid, left) = run_case(false);
    kill(pid, true);
    assert!(
        left,
        "{pid} died even with nothing holding it, the test above is not measuring what it claims"
    );
}
