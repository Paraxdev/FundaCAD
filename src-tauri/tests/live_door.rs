//! The engine worker opens its live session port only when the app hands it a token, so the MCP switch in Preferences
//! closes the port for real rather than only refusing guests.

use fundacad_lib::engine::{announced_port, configure_env};
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-live-door-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The worker as the app starts it, kept off the user's own plugins and blob store.
fn worker(tag: &str, token: Option<&str>) -> Child {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_fundacad"));
    cmd.arg("--engine").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env("FUNDACAD_PLUGIN_DIR", "");
    configure_env(&mut cmd, Some(&scratch(tag)), None, token);
    cmd.spawn().expect("start the engine worker")
}

#[test]
fn a_worker_given_a_token_opens_its_live_door() {
    let mut child = worker("on", Some("tok"));
    let stderr = BufReader::new(child.stderr.take().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut announced = false;
        for line in stderr.lines().map_while(Result::ok) {
            if let Some(port) = announced_port(&mut announced, &line) {
                let _ = tx.send(port);
            }
        }
    });
    let port = rx.recv_timeout(Duration::from_secs(60));
    let reached = port.as_ref().ok().map(|&p| TcpStream::connect(("127.0.0.1", p)).is_ok());
    drop(child.stdin.take());
    let _ = child.kill();
    let _ = child.wait();
    assert!(port.is_ok(), "the worker never said LISTENING");
    assert_eq!(reached, Some(true), "nothing answered on the announced port");
}

#[test]
fn a_worker_given_no_token_opens_no_port() {
    let mut child = worker("off", None);
    // The live door is set up before the worker reads its first request, so it has run by the time stdin's end lets
    // the worker exit.
    drop(child.stdin.take());
    let out = child.wait_with_output().expect("wait for the engine worker");
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "the worker failed: {:?}\n{said}", out.status);
    assert!(!said.lines().any(|l| l.starts_with("LISTENING")), "the worker opened a port:\n{said}");
    assert!(!said.contains("no live session port"), "the worker tried to open a port:\n{said}");
}

#[test]
fn an_inherited_token_does_not_open_the_door_once_the_switch_is_off() {
    let mut cmd = Command::new("fundacad");
    cmd.env("FUNDACAD_LIVE_TOKEN", "from-the-shell");
    configure_env(&mut cmd, None, None, None);
    let token = cmd.get_envs().find(|(k, _)| *k == "FUNDACAD_LIVE_TOKEN").and_then(|(_, v)| v);
    assert_eq!(token, Some(std::ffi::OsStr::new("")));
}
