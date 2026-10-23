//! Three processes, one document: a real engine, a real session file, a host loop doing what
//! `src/live/liveSession.ts` does, and `fundacad-mcp` over stdio, since the stubbed suites pass even if
//! the halves disagree on field names. Each case has a control, so none can pass vacuously.

mod common;

use common::{a_document, Host, Mcp, RealEngine, ToolReply};
use serde_json::{json, Value};

/// The call returns only once the app adopts the edit, which it does on its own loop, here a thread.
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
    assert!(read.text.contains("from-the-app"), "the agent did not read the app's document: {:.200}", read.text);

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
    assert!(names.iter().any(|n| n == "from-the-agent"), "the edit never reached the app: {names:?}");
    assert!(names.iter().any(|n| n == "from-the-app"), "the edit replaced the app's own work: {names:?}");
    assert_eq!(host.rev, 2, "the app did not raise the revision");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_edit_against_a_stale_revision_is_refused() {
    // At the wire, not through a tool: the MCP path re-reads before every call and so can never be stale itself.
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
    assert!(res["message"].as_str().unwrap_or_default().contains(&host.rev.to_string()), "{res}");

    host.tick().await;
    let names = host.feature_names();
    assert!(!names.iter().any(|n| n == "stale"), "a stale edit was applied anyway: {names:?}");

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
    assert!(!out.text.contains("did not apply"), "refused as a timeout: {}", out.text);
    assert_eq!(host.doc["features"].as_array().map(Vec::len), Some(1), "{}", host.doc["features"]);
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
    assert!(!out.text.contains("from-the-app"), "it found a session it was not told about: {:.200}", out.text);
    let doc: Value = serde_json::from_str(&out.text).expect("doc_get is JSON");
    assert_eq!(doc["features"], json!([]), "{}", out.text);
}

#[test]
fn attach_mode_refuses_to_start_rather_than_working_on_a_copy() {
    // `attach` is for a host meant for the open document only, where a quiet fallback would look like ignored edits.
    let engine = RealEngine::start();
    let env = engine.mcp_env("attach", false);
    let mut cmd = std::process::Command::new(common::mcp_binary());
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let out = cmd.stdin(std::process::Stdio::piped()).output().expect("the MCP binary is built");
    assert!(!out.status.success(), "attach mode started with no app to attach to");
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("no FundaCAD window is running"), "{said}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_folder_of_the_file_the_app_has_open_is_one_the_agent_may_write() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    let own = tempfile::Builder::new().prefix("live-own-").tempdir().unwrap();
    let work = tempfile::Builder::new().prefix("live-work-").tempdir().unwrap();
    let parts = work.path().join("parts");
    let elsewhere = work.path().join("elsewhere");
    std::fs::create_dir_all(&parts).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    host.title = parts.join("part.funda").to_string_lossy().into_owned();
    host.tick().await;

    let mut env = engine.mcp_env("auto", true);
    let tmp = own.path().to_string_lossy().into_owned();
    for k in ["TMP", "TEMP", "TMPDIR"] {
        env.insert(k.into(), tmp.clone());
    }
    // By default every plain folder is reached; strict is where the open
    // document's folder matters.
    env.insert("FUNDACAD_MCP_STRICT".into(), "1".into());
    let mcp = Mcp::start(&env, own.path());
    let beside = parts.join("from-the-agent.funda");
    let (mcp, out) = while_pumping(mcp, &mut host, "doc_save", json!({"path": beside.to_string_lossy()}), 5.0).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(beside.exists());
    let (_mcp, out) =
        while_pumping(mcp, &mut host, "doc_save", json!({"path": elsewhere.join("a.funda").to_string_lossy()}), 5.0)
            .await;
    assert!(out.is_error && out.text.contains("outside the folders"), "{}", out.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_document_is_refused_by_name_while_the_app_imports_and_an_edit_is_not() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.importing = true;
    host.tick().await;

    let mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let (mcp, replaced) = while_pumping(mcp, &mut host, "doc_new", json!({}), 5.0).await;
    let kept = host.feature_names();
    let (mcp, edited) = while_pumping(
        mcp,
        &mut host,
        "feature_add",
        json!({"feature": {"id": "s1", "type": "sphere", "radius": 4, "name": "during-the-import"}}),
        5.0,
    )
    .await;
    let after_edit = host.feature_names();

    // The control: once the import has landed, the same doc_new goes through.
    host.importing = false;
    let (_mcp, later) = while_pumping(mcp, &mut host, "doc_new", json!({}), 5.0).await;

    assert!(replaced.is_error, "a new document replaced the one an import is read into: {}", replaced.text);
    assert!(replaced.text.contains("an import is still being read"), "{}", replaced.text);
    assert!(!replaced.text.contains("did not apply"), "refused as a timeout: {}", replaced.text);
    assert_eq!(kept, vec!["from-the-app".to_string()]);
    assert!(!edited.is_error, "{}", edited.text);
    assert_eq!(after_edit, vec!["from-the-app".to_string(), "during-the-import".to_string()]);
    assert!(!later.is_error, "{}", later.text);
    assert_eq!(host.feature_names(), Vec::<String>::new());
}
