//! Does the server notice FundaCAD opening after it started? A port of
//! the Python MCP server's `test_reattach.py`.
//!
//! `attach` asks "is the app open?" exactly once, at start-up, and start-up is
//! not a moment the user controls: an MCP host launches its servers when the
//! HOST launches, not when a conversation begins. So the question was asked
//! before the person had any reason to have opened the app, and answering no
//! meant a private engine for the rest of the host's session. Opening the app
//! afterwards changed nothing, which reads as the connector refusing to use the
//! app that is right there in front of them.
//!
//! So the question gets asked again. Every test here is one of the ways that
//! could go wrong, and the controls matter more than the happy path: re-probing
//! REPLACES the document in hand, so the cases where it must not happen are the
//! ones that make it safe to have at all.
//!
//! The Python suite patched module names. Here the probe is a real session file
//! and a real socket, so the stub is an engine that answers, which puts
//! discovery itself under test as well.

mod common;

use std::path::PathBuf;
use std::time::Duration;

use common::FakeEngine;
use fundacad_mcp::server::FundaCad;
use serde_json::json;

/// `FUNDACAD_SESSION_FILE` and `FUNDACAD_MCP_MODE` are the process's, so these
/// run one at a time.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

struct Session(PathBuf);

impl Session {
    /// Publish a session file naming `engine`, as the app does while it runs.
    fn published(engine: &FakeEngine) -> Session {
        let path = std::env::temp_dir().join(format!(
            "fundacad-test-session-{}-{}.json",
            std::process::id(),
            engine.port
        ));
        std::fs::write(
            &path,
            json!({"port": engine.port, "token": engine.token, "pid": 4242}).to_string(),
        )
        .expect("a temp file");
        std::env::set_var("FUNDACAD_SESSION_FILE", &path);
        Session(path)
    }

    /// No app has ever run on this machine, as far as discovery can tell.
    fn none() -> Session {
        let path = std::env::temp_dir().join("fundacad-test-no-session.json");
        let _ = std::fs::remove_file(&path);
        std::env::set_var("FUNDACAD_SESSION_FILE", &path);
        Session(path)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        std::env::remove_var("FUNDACAD_SESSION_FILE");
        std::env::remove_var("FUNDACAD_MCP_MODE");
    }
}

/// The document a window has open, and an engine that shares it.
fn sharing_engine() -> FakeEngine {
    FakeEngine::start(|op, _req| match op {
        "ping" => json!({"ok": true, "result": {"pong": true}}),
        "session_state" => json!({"ok": true, "result": {
            "attached": true, "revision": 7, "title": "the user's part",
            "status": {"canEdit": true, "applied": []},
            "document": {"features": [{"id": "f1", "type": "sketch"}], "parameters": {}}}}),
        _ => json!({"ok": true, "result": {}}),
    })
}

/// The app's engine, with live editing turned off in the window's settings.
fn silent_engine() -> FakeEngine {
    FakeEngine::start(|op, _req| match op {
        "ping" => json!({"ok": true, "result": {"pong": true}}),
        "session_state" => json!({"ok": true, "result": {"attached": false}}),
        _ => json!({"ok": true, "result": {}}),
    })
}

/// A server as it is a moment after start-up with no app open: private, and
/// nothing built in it yet.
fn fresh() -> (FundaCad, FakeEngine) {
    let private = FakeEngine::always(json!({"ok": true, "result": {}}));
    (FundaCad::with_link(private.link()), private)
}

fn pings(engine: &FakeEngine) -> usize {
    engine.ops().iter().filter(|o| *o == "ping").count()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_opening_later_is_noticed() {
    let _serial = serial();
    let app = sharing_engine();
    let _session = Session::published(&app);
    let (srv, _private) = fresh();
    srv.probe_for_the_app().await;
    assert!(srv.is_live().await, "still private after the app appeared");
    let doc = srv.document().await;
    assert_eq!(doc["features"][0]["id"], json!("f1"), "{doc:?}");
    assert_eq!(srv.engine_port().await, app.port);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_private_engine_is_let_go_of() {
    // It holds a worker nothing will ask for again, and this process is the
    // only thing keeping it alive.
    let _serial = serial();
    let app = sharing_engine();
    let _session = Session::published(&app);
    let (srv, private) = fresh();
    let private_port = private.port;
    srv.probe_for_the_app().await;
    assert_ne!(
        srv.engine_port().await,
        private_port,
        "the private engine was kept"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_happens_when_no_app_is_open() {
    // The control for everything above: the ordinary case is that the probe
    // finds nothing, and it must cost the caller nothing but a look.
    let _serial = serial();
    let _session = Session::none();
    let (srv, _private) = fresh();
    srv.probe_for_the_app().await;
    assert!(!srv.is_live().await);
    assert_eq!(
        srv.document().await["features"].as_array().map(Vec::len),
        Some(0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn work_already_done_here_is_not_thrown_away() {
    // THE control. Adopting replaces the document, so a server that has built
    // something privately must stay where it is: a user who opens the app to
    // look at something else has not asked for the agent's work to be discarded.
    let _serial = serial();
    let app = sharing_engine();
    let _session = Session::published(&app);
    let (srv, _private) = fresh();
    srv.set_private_edits(true).await;
    srv.probe_for_the_app().await;
    assert!(!srv.is_live().await, "adopted over work already done");
    assert_eq!(
        pings(&app),
        0,
        "probed at all, when the answer could not be acted on"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn standalone_is_left_alone() {
    // Configured to stay private on purpose. Going looking would make the
    // setting mean nothing.
    let _serial = serial();
    let app = sharing_engine();
    let _session = Session::published(&app);
    std::env::set_var("FUNDACAD_MCP_MODE", "standalone");
    let (srv, _private) = fresh();
    srv.probe_for_the_app().await;
    std::env::remove_var("FUNDACAD_MCP_MODE");
    assert!(!srv.is_live().await);
    assert_eq!(pings(&app), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_that_is_not_sharing_leaves_a_working_session() {
    // The engine is the app's but live editing is off in its settings. Half a
    // switch is worse than none: the server must not end up with a live session
    // it cannot pull from, nor with its private engine already stopped.
    let _serial = serial();
    let app = silent_engine();
    let _session = Session::published(&app);
    let (srv, private) = fresh();
    srv.probe_for_the_app().await;
    assert!(!srv.is_live().await, "kept a live session that cannot be read");
    assert_eq!(
        srv.engine_port().await,
        private.port,
        "swapped the link anyway"
    );
    // and the private engine still answers, which is the half-switch bug
    let out = srv.t_schema(Default::default()).await;
    assert!(out.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_app_is_not_re_probed_on_every_call() {
    // A probe is a file read when there is no session file, and a connect that
    // waits out its timeout when there is a STALE one. The second is the case
    // this bounds: without it, every tool call in a session pays that timeout.
    let _serial = serial();
    let app = silent_engine();
    let _session = Session::published(&app);
    let (srv, _private) = fresh();
    for _ in 0..20 {
        srv.probe_for_the_app().await;
    }
    assert_eq!(pings(&app), 1, "{:?}", app.ops());
    srv.age_probe(fundacad_mcp::server::REPROBE + Duration::from_secs(1))
        .await; // time passes
    srv.probe_for_the_app().await;
    assert_eq!(pings(&app), 2, "{:?}", app.ops());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_attached_server_stops_asking() {
    let _serial = serial();
    let app = sharing_engine();
    let _session = Session::published(&app);
    let (srv, _private) = fresh();
    srv.probe_for_the_app().await;
    assert!(srv.is_live().await);
    let before = pings(&app);
    for _ in 0..5 {
        srv.age_probe(fundacad_mcp::server::REPROBE + Duration::from_secs(1))
            .await;
        srv.probe_for_the_app().await;
    }
    assert_eq!(
        pings(&app),
        before,
        "kept probing after it was already attached"
    );
}

// --- the app going away under a live session ---------------------------------
//
// These drive the real binary, because the fall-back lives in `call_tool`: it
// is the thing that runs a tool against the app's document, notices the engine
// has gone, and runs it again privately.

fn attached_process(session: &std::path::Path) -> common::Mcp {
    let mut env = std::collections::BTreeMap::new();
    env.insert(
        "FUNDACAD_SESSION_FILE".to_string(),
        session.to_string_lossy().into_owned(),
    );
    common::Mcp::start(&env, &std::env::temp_dir())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_app_falls_back_to_a_private_engine() {
    // The window closed under a live session. Every call used to fail the same
    // way until the host restarted this server.
    let _serial = serial();
    let app = sharing_engine();
    let session = Session::published(&app);
    let mut mcp = attached_process(&session.0);

    let live = mcp.call("doc_get", json!({}));
    assert!(
        live.text.contains("f1"),
        "did not read the app's document: {}",
        live.text
    );

    app.die();
    let _ = std::fs::remove_file(&session.0);
    let after = mcp.call("doc_get", json!({}));
    assert!(
        !after.is_error,
        "kept failing after the window closed: {}",
        after.text
    );
    assert!(
        mcp.log().contains("working on a private copy"),
        "never said it had lost the app: {}",
        mcp.log()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_coming_back_is_found_again() {
    let _serial = serial();
    let app = sharing_engine();
    let session = Session::published(&app);
    let mut mcp = attached_process(&session.0);
    assert!(mcp.call("doc_get", json!({})).text.contains("f1"));

    app.die();
    let _ = std::fs::remove_file(&session.0);
    mcp.call("doc_get", json!({}));

    // A second window, on its own port, publishing the same session file.
    let again = sharing_engine();
    std::fs::write(
        &session.0,
        json!({"port": again.port, "token": again.token, "pid": 77}).to_string(),
    )
    .expect("a temp file");
    // The re-probe is rate limited, so give it the interval it asks for.
    std::thread::sleep(fundacad_mcp::server::REPROBE + Duration::from_millis(250));
    let back = mcp.call("doc_get", json!({}));
    assert!(
        back.text.contains("f1"),
        "did not re-attach once the app was back: {}",
        back.text
    );
    assert!(
        again.ops().iter().any(|o| o == "session_state"),
        "never reached the new window: {:?}",
        again.ops()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_not_sharing_is_not_mistaken_for_a_lost_engine() {
    // The control: a window sharing nothing is a setting the user can flip, and
    // it must keep saying so rather than silently going private.
    let _serial = serial();
    let app = silent_engine();
    let session = Session::published(&app);
    let mut mcp = attached_process(&session.0);
    let out = mcp.call("doc_get", json!({}));
    assert!(out.is_error, "{}", out.text);
    assert!(
        out.text.contains("sharing") || out.text.contains("live editing"),
        "{}",
        out.text
    );
    assert!(
        !mcp.log().contains("working on a private copy"),
        "went private over a setting the user can flip: {}",
        mcp.log()
    );
}

#[test]
fn the_session_file_is_read_and_a_broken_one_is_not_believed() {
    let _serial = serial();
    let path = std::env::temp_dir().join("fundacad-test-session-shapes.json");
    let cases: &[(&str, bool)] = &[
        (r#"{"port": 8765, "token": "t", "pid": 1}"#, true),
        (r#"{"port": 0, "token": "t"}"#, false),
        (r#"{"port": 8765, "token": ""}"#, false),
        (r#"{"port": "8765", "token": "t"}"#, false),
        ("not json at all", false),
    ];
    for (body, want) in cases {
        std::fs::write(&path, body).expect("a temp file");
        let read = fundacad_mcp::app_session::read_session_file(Some(&path));
        assert_eq!(read.is_some(), *want, "{body}");
    }
    let _ = std::fs::remove_file(&path);
    assert!(
        fundacad_mcp::app_session::read_session_file(Some(&path)).is_none(),
        "a file that is not there is not an app"
    );
}

#[test]
fn the_app_data_directory_is_the_one_tauri_derives() {
    // Tauri joins the bundle identifier onto the platform data directory, and
    // this re-derives it. Getting it wrong means never finding a running app on
    // that platform, silently.
    let _serial = serial();
    let dir = fundacad_mcp::app_session::app_data_dir();
    assert!(
        dir.ends_with(fundacad_mcp::app_session::APP_IDENTIFIER),
        "{}",
        dir.display()
    );
}

