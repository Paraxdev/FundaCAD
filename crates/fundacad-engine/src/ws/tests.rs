use super::*;
use crate::JobContext;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

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

#[test]
fn the_default_message_cap_is_the_protocol_frame_cap() {
    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let jobs = Slow { now: Arc::default(), peak: Arc::default() };
    let server = Server::bind(jobs, addr, Gate::new(TOKEN, "")).unwrap();
    assert_eq!(server.shared.max_message, MAX_FRAME);
}
