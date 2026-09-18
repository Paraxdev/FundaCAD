//! Three processes, one document. A port of
//! the Python MCP server's `test_live_session.py`.
//!
//! Everything else about the live session is tested with the other side stubbed
//! out: `fundacad-engine`'s own suite holds the rules with no socket, and
//! `tests/live/liveSession.test.ts` holds the window's loop with no engine.
//! Both would still pass if the two halves had agreed on different field names,
//! or if discovery never found a running app at all.
//!
//! So this one stubs nothing that carries a message. It starts a real engine,
//! writes a real session file, runs a host loop that does what
//! `src/live/liveSession.ts` does (publish, collect, apply, raise the revision),
//! and drives `fundacad-mcp` over its actual stdio protocol.
//!
//! The controls are the point, and each is a way this could pass while being
//! useless:
//!
//!   * with no session file, the agent must work on a PRIVATE document. Without
//!     this, an "attached" result proves nothing: a server that ignored the
//!     whole mechanism and always spawned its own engine would look identical as
//!     long as nobody checked whose document it was reading.
//!   * an edit against a stale revision must be refused. This is the rule that
//!     stops an agent overwriting what a person did while it was thinking.
//!   * a window sharing read-only must refuse the edit BY NAME. A refusal that
//!     arrived as a timeout would be indistinguishable from a hung app.

mod common;

use common::{a_document, Host, Mcp, RealEngine, ToolReply};
use serde_json::{json, Value};

/// Run one tool call while the host loop keeps publishing, because the call
/// does not return until the app has adopted the edit and the app only adopts
/// on its own loop. That is what the app does; here it means a thread.
async fn while_pumping(
    mut mcp: Mcp,
    host: &mut Host,
    name: &'static str,
    args: Value,
    seconds: f64,
) -> (Mcp, ToolReply) {
    let handle = tokio::task::spawn_blocking(move || {
        let reply = mcp.call(name, args);
        (mcp, reply)
    });
    host.pump(seconds).await;
    handle.await.expect("the tool call thread")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_reads_and_edits_the_document_the_app_has_open() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.tick().await;

    let mut mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let read = mcp.call("doc_get", json!({}));
    assert!(!read.is_error, "{}", read.text);
    assert!(
        read.text.contains("from-the-app"),
        "the agent did not read the app's document: {:.200}",
        read.text
    );

    let (_mcp, out) = while_pumping(
        mcp,
        &mut host,
        "feature_add",
        json!({"feature": {"id": "hole1", "type": "cylinder", "radius": 3, "height": 40,
                           "operation": "cut", "name": "from-the-agent"}}),
        10.0,
    )
    .await;

    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("applied in FundaCAD"), "{}", out.text);
    let names = host.feature_names();
    assert!(
        names.iter().any(|n| n == "from-the-agent"),
        "the edit never reached the app: {names:?}"
    );
    assert!(
        names.iter().any(|n| n == "from-the-app"),
        "the edit replaced the app's own work: {names:?}"
    );
    assert_eq!(host.rev, 2, "the app did not raise the revision");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_edit_against_a_stale_revision_is_refused() {
    // Driven at the wire rather than through a tool, because the MCP path
    // re-reads before every call and so can never itself be stale, which is the
    // design working, and is exactly why the refusal underneath it has to be
    // proven separately.
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.tick().await;
    host.doc = a_document(4, "the-user-moved-it");
    host.rev += 1;
    host.tick().await;

    let reply = host
        .call(
            "session_propose",
            json!({"document": a_document(9, "stale"), "baseRevision": 1,
                   "name": "a slow agent"}),
        )
        .await;
    let res = reply.get("result").cloned().unwrap_or_else(|| json!({}));
    assert_eq!(res["ok"], json!(false), "{res}");
    assert_eq!(res["reason"], json!("stale"), "{res}");
    assert!(
        res["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&host.rev.to_string()),
        "{res}"
    );

    host.tick().await;
    let names = host.feature_names();
    assert!(
        !names.iter().any(|n| n == "stale"),
        "a stale edit was applied anyway: {names:?}"
    );

    // The control: the SAME edit against the current revision goes through, or
    // "stale" would just be a word for "no".
    let ok = host
        .call(
            "session_propose",
            json!({"document": a_document(9, "fresh"), "baseRevision": host.rev,
                   "name": "a slow agent"}),
        )
        .await;
    assert_eq!(ok["result"]["ok"], json!(true), "{ok}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_only_window_refuses_by_name_rather_than_by_timeout() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.can_edit = false;
    host.tick().await;

    let mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let (_mcp, out) = while_pumping(
        mcp,
        &mut host,
        "feature_add",
        json!({"feature": {"id": "s1", "type": "sphere", "radius": 4}}),
        5.0,
    )
    .await;
    assert!(out.is_error, "a read-only window accepted an edit: {}", out.text);
    assert!(out.text.to_lowercase().contains("read-only"), "{}", out.text);
    assert!(
        !out.text.contains("did not apply"),
        "refused as a timeout: {}",
        out.text
    );
    assert_eq!(
        host.doc["features"].as_array().map(Vec::len),
        Some(1),
        "{}",
        host.doc["features"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_app_advertised_the_agent_works_on_its_own_copy() {
    // The control for the whole file. Without it, every assertion above could
    // be satisfied by a server that ignored discovery entirely.
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.tick().await;

    let mut mcp = Mcp::start(&engine.mcp_env("auto", false), &std::env::temp_dir());
    let out = mcp.call("doc_get", json!({}));
    assert!(!out.is_error, "{}", out.text);
    assert!(
        !out.text.contains("from-the-app"),
        "it found a session it was not told about: {:.200}",
        out.text
    );
    let doc: Value = serde_json::from_str(&out.text).expect("doc_get is JSON");
    assert_eq!(doc["features"], json!([]), "{}", out.text);
}

#[test]
fn attach_mode_refuses_to_start_rather_than_working_on_a_copy() {
    // `attach` exists for a host configured to work on the open document and
    // nothing else. Falling back quietly there would look like the edits are
    // being ignored, which is the failure hardest to diagnose from the outside.
    let engine = RealEngine::start();
    let env = engine.mcp_env("attach", false);
    let mut cmd = std::process::Command::new(common::mcp_binary());
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let out = cmd
        .stdin(std::process::Stdio::piped())
        .output()
        .expect("the MCP binary is built");
    assert!(
        !out.status.success(),
        "attach mode started with no app to attach to"
    );
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("no FundaCAD window is running"), "{said}");
}
