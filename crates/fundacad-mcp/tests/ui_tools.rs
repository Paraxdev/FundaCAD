//! The ui tools relay to the harness child (examples/fake_harness.rs here),
//! and exist in standalone mode only.

mod common;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{env, Mcp};
use fundacad_mcp::link::EngineLink;
use fundacad_mcp::server::FundaCad;
use serde_json::{json, Value};

const UI: [&str; 5] = ["ui_open", "ui_do", "ui_read", "ui_shot", "ui_close"];

fn fake() -> PathBuf {
    let exe = std::env::current_exe().expect("a test binary has a path");
    let profile = exe
        .parent()
        .and_then(Path::parent)
        .expect("target/<profile>/deps");
    let fake = profile.join("examples").join(if cfg!(windows) {
        "fake_harness.exe"
    } else {
        "fake_harness"
    });
    assert!(fake.is_file(), "build the example first: {}", fake.display());
    fake
}

fn standalone(extra: &[(&str, &str)]) -> Mcp {
    let python = fake().to_string_lossy().into_owned();
    let mut vars = env(&[
        ("FUNDACAD_MCP_MODE", "standalone"),
        ("FUNDACAD_HARNESS_PYTHON", &python),
    ]);
    for (k, v) in extra {
        vars.insert((*k).into(), (*v).into());
    }
    Mcp::start(&vars, &std::env::temp_dir())
}

fn names(tools: &[Value]) -> Vec<String> {
    tools
        .iter()
        .filter_map(|t| t["name"].as_str().map(String::from))
        .collect()
}

fn pid_in(text: &str) -> u32 {
    text.split("pid ")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or_else(|| panic!("no pid in {text}"))
}

#[test]
fn standalone_lists_the_five_ui_tools_and_auto_does_not() {
    let mut on = standalone(&[]);
    let tools = on.tools();
    for want in UI {
        let tool = tools
            .iter()
            .find(|t| t["name"] == want)
            .unwrap_or_else(|| panic!("{want} is not offered"));
        assert_eq!(tool["inputSchema"]["type"], json!("object"), "{want}");
        assert!(tool["description"].as_str().is_some_and(|d| !d.is_empty()));
    }
    let mut off = Mcp::start(&env(&[]), &std::env::temp_dir());
    let plain = names(&off.tools());
    assert!(UI.iter().all(|u| !plain.iter().any(|n| n == u)), "{plain:?}");
    assert_eq!(names(&tools).len(), plain.len() + UI.len());
}

#[test]
fn only_with_ui_adds_them() {
    let server = FundaCad::with_link(EngineLink::private());
    let plain: Vec<String> = server.tools().iter().map(|t| t.name.to_string()).collect();
    assert!(!plain.iter().any(|n| n.starts_with("ui_")), "{plain:?}");
    let with: Vec<String> = server
        .with_ui()
        .tools()
        .iter()
        .map(|t| t.name.to_string())
        .collect();
    assert_eq!(with.len(), plain.len() + UI.len());
}

#[test]
fn ui_open_starts_the_harness_with_this_servers_engine() {
    let engine = fake().to_string_lossy().into_owned();
    let mut mcp = standalone(&[("FUNDACAD_ENGINE_CMD", &engine)]);
    let open = mcp.call("ui_open", json!({"viewport": "1200x800"}));
    assert!(!open.is_error, "{}", open.text);
    assert!(open.text.contains("private copy"), "{}", open.text);
    assert!(open.text.contains("argv -m fundacad_harness serve"), "{}", open.text);
    assert!(open.text.contains("fake_harness"), "the engine command was not passed: {}", open.text);
    assert!(open.text.contains("1200x800"), "{}", open.text);
    let again = mcp.call("ui_open", json!({}));
    assert_eq!(pid_in(&again.text), pid_in(&open.text), "a second ui_open started another child");
}

#[test]
fn ui_do_relays_steps_and_a_failing_step_is_an_error() {
    let mut mcp = standalone(&[]);
    let before = mcp.call("ui_do", json!({"steps": [{"do": "undo"}]}));
    assert!(before.is_error && before.text.contains("ui_open"), "{}", before.text);
    mcp.call("ui_open", json!({}));
    let ok = mcp.call(
        "ui_do",
        json!({"steps": [{"do": "click", "target": "Extrude"}, {"do": "press", "keys": "Escape"}]}),
    );
    assert!(!ok.is_error, "{}", ok.text);
    assert!(ok.text.contains("1. did click") && ok.text.contains("2. did press"), "{}", ok.text);
    let bad = mcp.call(
        "ui_do",
        json!({"steps": [{"do": "undo"}, {"do": "fail"}, {"do": "redo"}]}),
    );
    assert!(bad.is_error, "{}", bad.text);
    assert!(bad.text.contains("2. failed") && !bad.text.contains("did redo"), "{}", bad.text);
    let read = mcp.call("ui_read", json!({"what": ["history", "status"]}));
    assert!(!read.is_error && read.text.contains("history"), "{}", read.text);
}

#[test]
fn ui_shot_gives_an_image() {
    let mut mcp = standalone(&[]);
    mcp.call("ui_open", json!({}));
    let shot = mcp.call("ui_shot", json!({"max_px": 99999}));
    assert!(!shot.is_error, "{}", shot.text);
    assert_eq!(shot.images.len(), 1);
    assert!(shot.images[0].starts_with(b"\x89PNG"));
    assert!(shot.text.contains("1600"), "max_px was not capped: {}", shot.text);
}

#[test]
fn an_unknown_argument_is_refused_by_name() {
    let mut mcp = standalone(&[]);
    let reply = mcp.call("ui_open", json!({"headless": true}));
    assert!(reply.is_error, "{}", reply.text);
    assert!(reply.text.contains("'headless'"), "{}", reply.text);
}

#[test]
fn a_missing_python_or_package_gives_the_install_hint() {
    let nowhere = std::env::temp_dir().join("no-such-python-here").join("python.exe");
    let mut vars = env(&[("FUNDACAD_MCP_MODE", "standalone")]);
    vars.insert("FUNDACAD_HARNESS_PYTHON".into(), nowhere.to_string_lossy().into_owned());
    let mut mcp = Mcp::start(&vars, &std::env::temp_dir());
    let reply = mcp.call("ui_open", json!({}));
    assert!(reply.is_error, "{}", reply.text);
    assert!(reply.text.contains("pip install -e tools/harness"), "{}", reply.text);
    assert!(mcp.call("schema", json!({})).text.contains("box"), "the server did not survive");

    let mut mcp = standalone(&[("FAKE_HARNESS_MISSING", "1")]);
    let reply = mcp.call("ui_open", json!({}));
    assert!(reply.is_error, "{}", reply.text);
    assert!(reply.text.contains("not installed"), "{}", reply.text);
    assert!(reply.text.contains("pip install -e tools/harness"), "{}", reply.text);
}

#[test]
fn ui_close_stops_the_child() {
    let mut mcp = standalone(&[]);
    assert_eq!(mcp.call("ui_close", json!({})).text, "nothing was open.");
    let pid = pid_in(&mcp.call("ui_open", json!({})).text);
    let closed = mcp.call("ui_close", json!({}));
    assert!(!closed.is_error && closed.text.contains("closed"), "{}", closed.text);
    assert!(wait_gone(pid), "{pid} outlived ui_close");
    assert!(mcp.call("ui_read", json!({})).is_error);
    let reopened = mcp.call("ui_open", json!({}));
    assert_ne!(pid_in(&reopened.text), pid);
}

#[test]
fn the_child_dies_with_the_server() {
    // On Windows it only goes because the job object holds it, the fake
    // ignores the end of its stdin there.
    let hold = if cfg!(windows) { "1" } else { "0" };
    let mut mcp = standalone(&[("FAKE_HARNESS_HOLD", hold)]);
    let pid = pid_in(&mcp.call("ui_open", json!({})).text);
    assert!(alive(pid));
    mcp.kill_hard();
    if !wait_gone(pid) {
        kill(pid);
        panic!("{pid} outlived the server");
    }
}

fn wait_gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist is on Windows");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    } else {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        !stat.is_empty() && !stat.contains(") Z ")
    }
}

fn kill(pid: u32) {
    let _ = if cfg!(windows) {
        std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output()
    } else {
        std::process::Command::new("kill").args(["-9", &pid.to_string()]).output()
    };
}
