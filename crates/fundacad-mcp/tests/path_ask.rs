//! An assistant's file request over a real engine, with a host loop standing in for the app window, since the
//! asker and the engine must agree on field names that a fake would take on trust.

mod common;

use common::{Host, RealEngine};
use fundacad_mcp::flatpak_folder::{Answer, AskKind, AskUser, EngineAsker, PathAsk};
use fundacad_mcp::link::EngineLink;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const PICKED: &str = "/run/user/1000/doc/ab12/bracket.funda";

fn asker_on(link: Arc<EngineLink>) -> EngineAsker {
    let mut asker = EngineAsker::new(link, "Claude");
    asker.poll = Duration::from_millis(50);
    asker
}

fn link(engine: &RealEngine) -> Arc<EngineLink> {
    Arc::new(EngineLink::attach(engine.port, engine.token.clone()))
}

fn save() -> PathAsk {
    PathAsk::new(AskKind::Save, "doc_save", PathBuf::from("/home/me/bracket.funda"), &["funda"])
}

fn asking(asker: EngineAsker) -> tokio::task::JoinHandle<Result<Answer, String>> {
    tokio::spawn(async move { asker.ask(save()).await })
}

async fn handed(host: &mut Host) -> Value {
    for _ in 0..100 {
        host.tick().await;
        if let Some(ask) = host.asks.pop() {
            return ask;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("the engine never handed the request to the window");
}

async fn answer(host: &mut Host, ask: &Value, path: Value) -> Value {
    let reply = host.call("session_answer", json!({"askId": ask["askId"], "path": path})).await;
    reply.get("result").cloned().unwrap_or_else(|| json!({}))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_window_shows_the_request_and_the_users_pick_comes_back() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.tick().await;
    let pending = asking(asker_on(link(&engine)));

    let ask = handed(&mut host).await;
    assert_eq!(ask["kind"], json!("save"), "{ask}");
    assert_eq!(ask["tool"], json!("doc_save"), "{ask}");
    assert_eq!(ask["path"], json!("/home/me/bracket.funda"), "{ask}");
    assert_eq!(ask["exts"], json!(["funda"]), "{ask}");
    assert_eq!(ask["name"], json!("Claude"), "{ask}");
    assert_eq!(answer(&mut host, &ask, json!(PICKED)).await["ok"], json!(true));

    assert_eq!(pending.await.unwrap(), Ok(Answer::Picked(PathBuf::from(PICKED))));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_in_the_window_is_the_user_declining() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.tick().await;
    let pending = asking(asker_on(link(&engine)));

    let ask = handed(&mut host).await;
    assert_eq!(answer(&mut host, &ask, Value::Null).await["ok"], json!(true));

    assert_eq!(pending.await.unwrap(), Ok(Answer::Declined));
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_window_hosting_the_assistant_hears_so_at_once() {
    let engine = RealEngine::start();
    let started = std::time::Instant::now();

    assert_eq!(asker_on(link(&engine)).ask(save()).await, Ok(Answer::NoWindow));
    assert!(started.elapsed() < Duration::from_secs(5), "it waited for a window that was never there");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_that_stops_sharing_ends_the_wait() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.tick().await;
    let pending = asking(asker_on(link(&engine)));

    handed(&mut host).await;
    host.call("session_release", json!({})).await;

    assert_eq!(pending.await.unwrap(), Ok(Answer::NoWindow));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unanswered_request_times_out_and_is_withdrawn() {
    let engine = RealEngine::start();
    let mut host = Host::new(engine.socket().await);
    host.tick().await;
    let shared = link(&engine);
    let mut asker = asker_on(shared.clone());
    asker.timeout = Duration::from_millis(1500);
    let pending = asking(asker);

    let ask = handed(&mut host).await;
    let busy = asker_on(shared.clone()).ask(save()).await;
    assert!(busy.as_ref().is_err_and(|e| e.contains("already being asked")), "{busy:?}");

    let out = pending.await.unwrap();
    assert!(out.as_ref().is_err_and(|e| e.contains("did not answer") && e.contains("nothing was written")), "{out:?}");
    assert_eq!(answer(&mut host, &ask, json!(PICKED)).await["reason"], json!("unknown"), "the request stayed open");

    // The withdrawn request no longer holds the one this assistant may have open.
    let again = asking(asker_on(shared));
    let ask = handed(&mut host).await;
    answer(&mut host, &ask, json!(PICKED)).await;
    assert_eq!(again.await.unwrap(), Ok(Answer::Picked(PathBuf::from(PICKED))));
}
