//! An assistant that attaches while the app is still loading its page waits for the window instead of being told
//! to turn on live editing. A real engine and a real server, with the engine's start grace set per case.

mod common;

use std::time::{Duration, Instant};

use common::{Host, Mcp, RealEngine, ToolReply};
use fundacad_mcp::guide::{NO_WINDOW, OLD_WINDOW};
use fundacad_mcp::live::POLL_INTERVAL;
use serde_json::{json, Value};

/// The tool call blocks its thread, so it runs on one while this side plays the window: silent for `delay`
/// seconds, then publishing for `then`.
async fn call_while_window_loads(
    mut mcp: Mcp,
    host: Option<&mut Host>,
    name: &'static str,
    args: Value,
    delay: f64,
    then: f64,
) -> (Mcp, ToolReply, Duration) {
    let start = Instant::now();
    let handle = tokio::task::spawn_blocking(move || {
        let reply = mcp.call(name, args);
        (mcp, reply, start.elapsed())
    });
    if let Some(host) = host {
        tokio::time::sleep(Duration::from_secs_f64(delay)).await;
        host.pump(then).await;
    }
    handle.await.expect("the tool call thread")
}

fn is_starting_reply(text: &str) -> bool {
    text.contains("still starting") && text.contains("try again") && !text.contains("live editing")
}

fn is_no_window_reply(text: &str) -> bool {
    text.contains("live editing") && !text.contains("still starting")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_made_while_the_window_loads_reads_its_document_once_it_shares() {
    let engine = RealEngine::start_with_grace(30.0);
    let mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let mut host = Host::new(engine.socket().await);
    let (_mcp, out, took) = call_while_window_loads(mcp, Some(&mut host), "doc_get", json!({}), 1.0, 2.0).await;
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("from-the-app"), "not the window's document: {:.200}", out.text);
    assert!(took >= Duration::from_millis(900), "answered before the window shared: {took:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_that_never_loads_is_called_still_starting_not_switched_off() {
    let engine = RealEngine::start_with_grace(1.0);
    let mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let (mut mcp, out, took) = call_while_window_loads(mcp, None, "doc_get", json!({}), 0.0, 0.0).await;
    assert!(out.is_error && is_starting_reply(&out.text), "{}", out.text);
    assert!(took < Duration::from_secs(10), "{took:?}");
    let again = mcp.call("doc_get", json!({}));
    assert!(
        again.is_error && is_no_window_reply(&again.text),
        "the grace is over, so this is the setting: {}",
        again.text
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_app_that_is_not_starting_is_told_to_turn_on_live_editing_at_once() {
    let engine = RealEngine::start_with_grace(0.0);
    let mut mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let start = Instant::now();
    let out = mcp.call("doc_get", json!({}));
    let took = start.elapsed();
    assert!(out.is_error && is_no_window_reply(&out.text), "{}", out.text);
    assert!(took < POLL_INTERVAL * 4, "waited though nothing was starting: {took:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_that_closed_is_not_waited_for_again() {
    let engine = RealEngine::start_with_grace(30.0);
    let mut host = Host::new(engine.socket().await);
    host.tick().await;
    assert_eq!(host.call("session_release", json!({})).await["result"]["ok"], true);
    let mut mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let start = Instant::now();
    let out = mcp.call("doc_get", json!({}));
    assert!(out.is_error && is_no_window_reply(&out.text), "{}", out.text);
    assert!(start.elapsed() < POLL_INTERVAL * 4, "{:?}", start.elapsed());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guide_call_made_while_the_window_loads_goes_through_once_it_shares() {
    let engine = RealEngine::start_with_grace(30.0);
    let mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let mut host = Host::new(engine.socket().await);
    let args = json!({"ui": "pick:fillet", "caption": "Open Fillet"});
    let (_mcp, out, _) = call_while_window_loads(mcp, Some(&mut host), "guide_highlight", args, 1.0, 5.0).await;
    // This host never answers the guide, which is how an old window looks, and only a call that reached it says so.
    assert!(out.is_error && out.text.starts_with(OLD_WINDOW), "{}", out.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guide_call_to_a_window_that_never_loads_says_still_starting() {
    let engine = RealEngine::start_with_grace(1.0);
    let mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let args = json!({"ui": "pick:fillet", "caption": "Open Fillet"});
    let (mut mcp, out, _) = call_while_window_loads(mcp, None, "guide_highlight", args.clone(), 0.0, 0.0).await;
    assert!(out.is_error && is_starting_reply(&out.text), "{}", out.text);
    let again = mcp.call("guide_highlight", args);
    assert!(again.is_error && again.text.starts_with(NO_WINDOW), "{}", again.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guide_call_with_nothing_starting_is_refused_at_once() {
    let engine = RealEngine::start_with_grace(0.0);
    let mut mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    let start = Instant::now();
    let out = mcp.call("guide_highlight", json!({"ui": "pick:fillet", "caption": "Open Fillet"}));
    assert!(out.is_error && out.text.starts_with(NO_WINDOW), "{}", out.text);
    assert!(start.elapsed() < POLL_INTERVAL * 4, "{:?}", start.elapsed());
}
