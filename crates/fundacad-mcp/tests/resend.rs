//! A request whose reply never came may still have been applied, so only ops that cannot apply twice are sent again.

use std::sync::{Arc, Mutex};

use fundacad_mcp::link::EngineLink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// Hangs up on the first request it reads without replying, answers every later one.
async fn engine_that_drops_the_first_reply() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("a loopback port");
    let port = listener.local_addr().expect("bound").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let log = log.clone();
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let req: Value = serde_json::from_str(&text).expect("json");
                    let first = {
                        let mut log = log.lock().expect("no panics here");
                        log.push(req["op"].as_str().unwrap_or_default().to_string());
                        log.len() == 1
                    };
                    if first {
                        return;
                    }
                    let reply = json!({"id": req["id"], "ok": true, "result": {}});
                    if ws.send(Message::Text(reply.to_string().into())).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (port, seen)
}

#[tokio::test]
async fn a_proposal_whose_reply_was_lost_is_not_sent_again() {
    let (port, seen) = engine_that_drops_the_first_reply().await;
    let link = EngineLink::attach(port, "t");
    let reply = link.call("session_propose", json!({"note": "one"})).await;
    assert!(reply.is_err(), "a lost reply is reported, not papered over: {reply:?}");
    assert_eq!(*seen.lock().unwrap(), vec!["session_propose"]);
    let next = link.call("session_state", json!({})).await;
    assert!(next.is_ok(), "the next call connects again: {next:?}");
}

#[tokio::test]
async fn a_read_only_op_whose_reply_was_lost_is_asked_again() {
    let (port, seen) = engine_that_drops_the_first_reply().await;
    let link = EngineLink::attach(port, "t");
    let reply = link.call("inspect", json!({})).await;
    assert!(reply.is_ok(), "one silent reconnect for an op that changes nothing: {reply:?}");
    assert_eq!(*seen.lock().unwrap(), vec!["inspect", "inspect"]);
}

#[tokio::test]
async fn a_blob_transfer_whose_reply_was_lost_is_asked_again() {
    for op in ["blobHas", "blobRead", "blobWrite"] {
        let (port, seen) = engine_that_drops_the_first_reply().await;
        let link = EngineLink::attach(port, "t");
        let reply = link.call(op, json!({})).await;
        assert!(reply.is_ok(), "{op} reconnects once: {reply:?}");
        assert_eq!(*seen.lock().unwrap(), vec![op, op]);
    }
}
