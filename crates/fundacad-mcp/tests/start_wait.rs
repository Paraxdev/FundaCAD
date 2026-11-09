//! An assistant that attaches while the app is still loading its page waits for the window instead of being told
//! to turn on live editing. A real engine and a real server, with the engine's start grace set per case.

mod common;

use std::time::{Duration, Instant};

use common::{FakeEngine, Host, Mcp, RealEngine, ToolReply};
use fundacad_mcp::guide::{NO_WINDOW, OLD_WINDOW};
use fundacad_mcp::live::{LiveError, LiveLink, POLL_INTERVAL};
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

/// scripts/bundle-smoke.py keeps retrying while a reply says no window is sharing a document.
fn is_starting_reply(text: &str) -> bool {
    text.contains("still starting")
        && text.contains("try again")
        && text.contains("no FundaCAD window is sharing a document")
        && !text.contains("live editing")
}

fn is_no_window_reply(text: &str) -> bool {
    text.contains("no FundaCAD window is sharing a document")
        && text.contains("turn on live editing in its settings")
        && !text.contains("still starting")
}

fn state_reads(engine: &FakeEngine) -> usize {
    engine.ops().iter().filter(|o| *o == "session_state").count()
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
    let engine = RealEngine::start_with_grace(5.0);
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
    let engine = RealEngine::start_with_grace(5.0);
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

#[tokio::test(flavor = "multi_thread")]
async fn an_engine_that_says_starting_forever_is_waited_on_no_longer_than_the_cap() {
    let engine = FakeEngine::always(json!({"ok": true, "result": {"attached": false, "starting": true}}));
    let cap = Duration::from_millis(700);
    let mut live = LiveLink { start_wait: cap, ..LiveLink::new() };
    let start = Instant::now();
    let err = live.pull(&engine.link()).await.expect_err("no window shares");
    let took = start.elapsed();
    assert!(matches!(err, LiveError::NoAppOpen(_)) && is_starting_reply(err.message()), "{err:?}");
    assert!(took >= cap && took < cap + POLL_INTERVAL * 3, "{took:?}");
    assert!(state_reads(&engine) >= 4, "{:?}", engine.ops());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_engine_that_sends_no_starting_gets_the_no_window_reply_at_once() {
    let engine = FakeEngine::always(json!({"ok": true, "result": {"attached": false, "revision": 3}}));
    let mut live = LiveLink::new();
    let start = Instant::now();
    let err = live.pull(&engine.link()).await.expect_err("no window shares");
    assert!(matches!(err, LiveError::NoAppOpen(_)) && is_no_window_reply(err.message()), "{err:?}");
    assert!(start.elapsed() < POLL_INTERVAL * 2, "{:?}", start.elapsed());
    assert_eq!(state_reads(&engine), 1);
}
