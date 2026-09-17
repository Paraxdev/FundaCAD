use super::*;
use crate::JobContext;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use tungstenite::client::IntoClientRequest;

const TOKEN: &str = "t0k/en+x";

/// Rebuilds take a while and count how many run at once.
struct Slow {
    now: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

impl Jobs for Slow {
    fn rebuild(
        &mut self,
        _doc: &Value,
        _t: f64,
        _known: &Map<String, Value>,
        _fresh: bool,
        ctx: &JobContext,
    ) -> JobResult {
        let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(n, Ordering::SeqCst);
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_millis(300) && !ctx.cancel.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        self.now.fetch_sub(1, Ordering::SeqCst);
        let mut m = Map::new();
        m.insert("bodies".into(), json!([]));
        JobResult::Json(m)
    }
}

struct Running {
    port: u16,
    peak: Arc<AtomicUsize>,
}

fn start(extra_origins: &str, max_message: Option<usize>) -> Running {
    let peak = Arc::new(AtomicUsize::new(0));
    let jobs = Slow {
        now: Arc::default(),
        peak: peak.clone(),
    };
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let mut server = Server::bind(jobs, addr, Gate::new(TOKEN, extra_origins)).unwrap();
    if let Some(n) = max_message {
        server = server.with_max_message(n);
    }
    let port = server.port();
    std::thread::spawn(move || server.serve());
    Running { port, peak }
}

fn connect(port: u16, query: &str, origin: Option<&str>) -> Socket {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut req = format!("ws://127.0.0.1:{port}/?{query}")
        .into_client_request()
        .unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("Origin", o.parse().unwrap());
    }
    tungstenite::client::client(req, stream).unwrap().0
}

fn good_query() -> String {
    "token=t0k%2Fen%2Bx".to_string()
}

fn close_code(ws: &mut Socket) -> Option<(CloseCode, String)> {
    loop {
        match ws.read() {
            Ok(WsMessage::Close(Some(f))) => return Some((f.code, f.reason.as_str().to_owned())),
            Ok(WsMessage::Close(None)) => return None,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

fn call(ws: &mut Socket, req: Value) -> Value {
    let id = req["id"].clone();
    ws.send(WsMessage::text(req.to_string())).unwrap();
    loop {
        match ws.read().unwrap() {
            WsMessage::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["id"] == id && v.get("ok").is_some() {
                    return v;
                }
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}

#[test]
fn a_wrong_or_missing_token_is_closed_with_1008() {
    let s = start("", None);
    for q in ["token=nope", "", "token=", "other=t0k%2Fen%2Bx"] {
        let mut ws = connect(s.port, q, None);
        assert_eq!(
            close_code(&mut ws),
            Some((CloseCode::Policy, "unauthorized".into())),
            "query {q:?}"
        );
    }
}

#[test]
fn a_foreign_origin_is_refused_even_with_the_token() {
    let s = start("http://localhost:4173", None);
    let mut ws = connect(s.port, &good_query(), Some("http://evil.example"));
    assert_eq!(
        close_code(&mut ws),
        Some((CloseCode::Policy, "unauthorized".into()))
    );
    for origin in [
        Some("http://tauri.localhost"),
        Some("http://localhost:4173"),
        None,
    ] {
        let mut ws = connect(s.port, &good_query(), origin);
        let r = call(&mut ws, json!({"id": 1, "op": "ping"}));
        assert_eq!(r["result"]["pong"], true, "origin {origin:?}");
    }
}

#[test]
fn ping_round_trips() {
    let s = start("", None);
    let mut ws = connect(s.port, &good_query(), None);
    assert_eq!(
        call(&mut ws, json!({"id": "p1", "op": "ping"})),
        json!({"id": "p1", "ok": true, "result": {"pong": true}})
    );
    ws.send(WsMessage::text("{not json")).unwrap();
    let WsMessage::Text(t) = ws.read().unwrap() else {
        panic!("expected text")
    };
    assert_eq!(
        serde_json::from_str::<Value>(t.as_str()).unwrap()["ok"],
        false
    );
}

#[test]
fn an_oversize_message_is_closed_with_1009() {
    let s = start("", Some(1024));
    let mut ws = connect(s.port, &good_query(), None);
    assert_eq!(call(&mut ws, json!({"id": 1, "op": "ping"}))["ok"], true);
    ws.send(WsMessage::text("x".repeat(4096))).unwrap();
    let (code, _) = close_code(&mut ws).expect("a close frame");
    assert_eq!(code, CloseCode::Size);
}

#[test]
fn the_default_message_cap_is_the_protocol_frame_cap() {
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let jobs = Slow {
        now: Arc::default(),
        peak: Arc::default(),
    };
    let server = Server::bind(jobs, addr, Gate::new(TOKEN, "")).unwrap();
    assert_eq!(server.shared.max_message, MAX_FRAME);
}

#[test]
fn rejected_connections_give_their_slot_back() {
    let s = start("", None);
    for _ in 0..MAX_CONNS_PER_IP * 2 {
        let mut ws = connect(s.port, "token=wrong", None);
        assert_eq!(close_code(&mut ws).map(|c| c.0), Some(CloseCode::Policy));
    }
    std::thread::sleep(Duration::from_millis(200));
    let mut ws = connect(s.port, &good_query(), None);
    assert_eq!(call(&mut ws, json!({"id": 1, "op": "ping"}))["ok"], true);
}

#[test]
fn past_the_cap_a_connection_is_closed_as_too_many() {
    let s = start("", None);
    let mut held: Vec<Socket> = (0..MAX_CONNS_PER_IP)
        .map(|_| connect(s.port, &good_query(), None))
        .collect();
    for ws in held.iter_mut() {
        assert_eq!(call(ws, json!({"id": 1, "op": "ping"}))["ok"], true);
    }
    let mut extra = connect(s.port, &good_query(), None);
    assert_eq!(
        close_code(&mut extra),
        Some((CloseCode::Policy, "too many connections".into()))
    );
}

#[test]
fn jobs_from_every_connection_share_one_lock_and_cancel_stays_per_connection() {
    let s = start("", None);
    let mut a = connect(s.port, &good_query(), None);
    let mut b = connect(s.port, &good_query(), None);
    let doc = json!({"features": []});
    a.send(WsMessage::text(
        json!({"id": "a", "op": "rebuild", "document": doc}).to_string(),
    ))
    .unwrap();
    b.send(WsMessage::text(
        json!({"id": "b", "op": "rebuild", "document": doc}).to_string(),
    ))
    .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let miss = call(&mut b, json!({"id": "c", "op": "cancel", "target": "a"}));
    assert_eq!(miss["result"]["cancelled"], false);
    let wait = |ws: &mut Socket, id: &str| loop {
        let WsMessage::Text(t) = ws.read().unwrap() else {
            continue;
        };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        if v["id"] == id && v.get("ok").is_some() {
            return v;
        }
    };
    assert_eq!(wait(&mut a, "a")["ok"], true);
    assert_eq!(wait(&mut b, "b")["ok"], true);
    assert_eq!(s.peak.load(Ordering::SeqCst), 1);
}

#[test]
fn the_gate_decodes_the_query_like_parse_qs() {
    let g = Gate::new("a b/c", "");
    assert!(g.authorized(Some("x=1&token=a+b%2fc"), None));
    assert!(g.authorized(Some("token=&token=a%20b/c"), None));
    assert!(!g.authorized(Some("token=a+b%2fc&x"), Some("https://example.org")));
    assert!(!g.authorized(Some("token=a+b%2fcd"), None));
    assert!(!Gate::new("", "").authorized(Some("token="), None));
}

#[test]
fn a_minted_token_looks_like_token_urlsafe_32() {
    let t = mint_token().unwrap();
    assert_eq!(t.len(), 43);
    assert!(t
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    assert_ne!(t, mint_token().unwrap());
}
