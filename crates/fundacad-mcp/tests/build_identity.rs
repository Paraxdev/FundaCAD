//! Which build an engine is.
//!
//! The same document once built differently through the MCP server than in the
//! app, because the engine the server started was three days older than the
//! app's, and nothing said so. An engine now names the source it was built
//! from in its `ping` reply, and the server compares the two it can reach.

mod common;

use serde_json::json;

fn head_commit() -> String {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("git runs");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_engine_says_which_commit_it_was_built_from() {
    let engine = common::RealEngine::start();
    engine.hide();
    let mut socket = engine.socket().await;
    let reply = socket
        .request("p", &json!({"op": "ping"}))
        .await
        .expect("a reply");
    let _ = socket.close().await;
    assert_eq!(reply["result"]["pong"], json!(true), "{reply}");
    assert_eq!(
        reply["result"]["build"]["commit"],
        json!(head_commit()),
        "the engine did not say which commit it was built from: {reply}"
    );
}

#[test]
fn only_two_builds_that_both_say_and_differ_are_called_different() {
    use fundacad_mcp::link::build_mismatch;
    let at = |commit: &str, changes: Option<&str>| {
        let mut b = json!({"commit": commit, "commitDate": "2026-10-11"});
        if let Some(c) = changes {
            b["changes"] = json!(c);
        }
        b
    };
    let a = "6c15cdcdceab2b9b49d0b09c7a6791b15fb4c52a";
    let b = "878788837018a50fe76e4794cb3cf24fabc1898d";
    assert_eq!(build_mismatch(&at(a, None), &at(a, None)), None);
    assert_eq!(build_mismatch(&at(a, Some("43318c0d")), &at(a, Some("43318c0d"))), None);
    // An engine from before builds were named, or built without git, cannot be compared.
    assert_eq!(build_mismatch(&json!({}), &at(a, None)), None);
    assert_eq!(build_mismatch(&at(a, None), &json!({})), None);

    let other = build_mismatch(&at(a, None), &at(b, None)).expect("two commits differ");
    assert!(other.contains("This engine is commit 878788837018 of 2026-10-11"), "{other}");
    assert!(other.contains("FundaCAD's is commit 6c15cdcdceab"), "{other}");
    let edited = build_mismatch(&at(a, None), &at(a, Some("43318c0d4439036b"))).expect("uncommitted changes differ");
    assert!(edited.contains("with uncommitted changes 43318c0d"), "{edited}");
}
