//! One document, an app and an agent both working on it, sidecar/live_session.py.
//!
//! Exactly one HOST (the running app) owns the document and is the only thing
//! that may raise its revision. Any number of GUESTS read it and PROPOSE a
//! replacement, which the host collects on its next publish. A state machine
//! with the clock injected, answered on the read path.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

/// Seconds a guest counts as present after its last call.
pub const GUEST_TTL: f64 = 45.0;
/// Proposals waiting for the host before a guest is told `backlog`.
pub const MAX_PENDING: usize = 8;
/// Characters of a guest's note kept; it is shown to the user.
pub const MAX_NOTE: usize = 400;

pub type Clock = Box<dyn Fn() -> f64 + Send>;

pub struct LiveSession {
    clock: Clock,
    host_id: Option<String>,
    document: Value,
    revision: i64,
    title: Value,
    status: Value,
    /// id to (name, last seen).
    guests: HashMap<String, (Value, f64)>,
    pending: Vec<Map<String, Value>>,
    next_proposal: u64,
}

fn truthy(v: Option<&Value>) -> bool {
    fundacad_protocol::pyjson::truthy(v)
}

/// Python `int()` of a JSON revision, `None` where it would raise.
fn py_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn name_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

impl LiveSession {
    pub fn new(clock: Clock) -> LiveSession {
        LiveSession {
            clock,
            host_id: None,
            document: Value::Null,
            revision: 0,
            title: Value::Null,
            status: json!({}),
            guests: HashMap::new(),
            pending: Vec::new(),
            next_proposal: 0,
        }
    }

    /// A session on a monotonic clock started now.
    pub fn monotonic() -> LiveSession {
        let start = std::time::Instant::now();
        LiveSession::new(Box::new(move || start.elapsed().as_secs_f64()))
    }

    fn reset(&mut self) {
        self.host_id = None;
        self.document = Value::Null;
        self.revision = 0;
        self.title = Value::Null;
        self.status = json!({});
        self.guests.clear();
        self.pending.clear();
        self.next_proposal = 0;
    }

    /// `publish`: the host says what it has and collects what guests asked for.
    pub fn publish(&mut self, host_id: &str, document: Value, revision: i64, title: Value, status: Value) -> Value {
        if self.host_id.as_deref() != Some(host_id) {
            self.host_id = Some(host_id.to_owned());
            self.pending.clear();
        }
        self.document = document;
        self.revision = revision;
        self.title = title;
        self.status = if truthy(Some(&status)) { status } else { json!({}) };
        // Expire first, then take, or a dead guest's proposal is handed over on its way out.
        let guests = self.guest_names();
        let taken = std::mem::take(&mut self.pending);
        json!({"ok": true, "guests": guests, "proposals": taken})
    }

    /// `release`: only the host ends the session, and the document goes with it.
    pub fn release(&mut self, host_id: &str) -> Value {
        if self.host_id.as_deref() != Some(host_id) {
            return json!({"ok": false, "reason": "not the host"});
        }
        self.reset();
        json!({"ok": true})
    }

    /// `state`: what a guest sees, and its heartbeat.
    pub fn state(&mut self, guest_id: Option<&str>, name: Option<&Value>) -> Value {
        if let Some(g) = guest_id {
            self.touch(g, name);
        }
        json!({
            "attached": self.host_id.is_some(),
            "revision": self.revision,
            "title": self.title,
            "status": self.status,
            "document": self.document,
            "guests": self.guest_names(),
        })
    }

    /// `propose`: an offered replacement, or which of three things went wrong.
    pub fn propose(
        &mut self,
        guest_id: &str,
        document: Value,
        base_revision: i64,
        note: Option<&Value>,
        name: Option<&Value>,
    ) -> Value {
        self.touch(guest_id, name);
        if self.host_id.is_none() {
            return json!({"ok": false, "reason": "no-host",
                "message": "no FundaCAD window is sharing a document"});
        }
        if base_revision != self.revision {
            return json!({"ok": false, "reason": "stale", "revision": self.revision,
                "message": format!(
                    "the document moved on while that edit was being written (revision {base_revision} -> {}); read it again and re-apply",
                    self.revision
                )});
        }
        if self.pending.len() >= MAX_PENDING {
            return json!({"ok": false, "reason": "backlog",
                "message": "the app has not collected the last edits yet"});
        }
        self.next_proposal += 1;
        let pid = format!("p{}", self.next_proposal);
        let note = note
            .filter(|n| truthy(Some(n)))
            .map(|n| Value::String(name_text(n).chars().take(MAX_NOTE).collect()))
            .unwrap_or(Value::Null);
        let shown = name.filter(|n| truthy(Some(n))).cloned().unwrap_or_else(|| json!(guest_id));
        let mut p = Map::new();
        p.insert("id".into(), json!(pid));
        p.insert("guest".into(), json!(guest_id));
        p.insert("name".into(), shown);
        p.insert("note".into(), note);
        p.insert("baseRevision".into(), json!(base_revision));
        p.insert("document".into(), document);
        p.insert("at".into(), json!((self.clock)()));
        self.pending.push(p);
        json!({"ok": true, "proposal": pid, "revision": self.revision})
    }

    pub fn leave(&mut self, guest_id: &str) -> Value {
        self.guests.remove(guest_id);
        self.pending.retain(|p| p.get("guest").and_then(Value::as_str) != Some(guest_id));
        json!({"ok": true})
    }

    /// Who is attached right now, expired guests dropped with their proposals.
    pub fn guest_names(&mut self) -> Vec<String> {
        let now = (self.clock)();
        let expired: Vec<String> = self
            .guests
            .iter()
            .filter(|(_, (_, seen))| now - seen > GUEST_TTL)
            .map(|(g, _)| g.clone())
            .collect();
        for g in expired {
            self.guests.remove(&g);
            self.pending.retain(|p| p.get("guest").and_then(Value::as_str) != Some(g.as_str()));
        }
        let mut names: Vec<String> = self.guests.values().map(|(n, _)| name_text(n)).collect();
        names.sort();
        names
    }

    fn touch(&mut self, guest_id: &str, name: Option<&Value>) {
        let kept = match name.filter(|n| truthy(Some(n))) {
            Some(n) => n.clone(),
            None => self.guests.get(guest_id).map_or_else(|| json!(guest_id), |(n, _)| n.clone()),
        };
        let now = (self.clock)();
        self.guests.insert(guest_id.to_owned(), (kept, now));
    }
}

/// The five `session_*` ops, server.py `_session_reply`, answered for the
/// connection `who`. `Err` is the error message for the reply envelope.
pub fn session_reply(live: &mut LiveSession, who: &str, op: &str, req: &Map<String, Value>) -> Result<Value, String> {
    let get = |k: &str| req.get(k).cloned().unwrap_or(Value::Null);
    let revision = |k: &str| -> Result<i64, String> {
        match req.get(k).filter(|v| truthy(Some(v))) {
            None => Ok(0),
            Some(v) => py_int(v).ok_or_else(|| format!("invalid literal for int(): {v}")),
        }
    };
    Ok(match op {
        "session_host" => live.publish(who, get("document"), revision("revision")?, get("title"), get("status")),
        "session_release" => live.release(who),
        "session_state" => live.state(Some(who), req.get("name")),
        "session_propose" => {
            let base = revision("baseRevision")?;
            live.propose(who, get("document"), base, req.get("note"), req.get("name"))
        }
        "session_leave" => live.leave(who),
        other => return Err(format!("unknown session op: {other}")),
    })
}

pub fn is_session_op(op: &str) -> bool {
    matches!(op, "session_host" | "session_release" | "session_state" | "session_propose" | "session_leave")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    const APP: &str = "app";
    const AGENT: &str = "agent";
    const OTHER: &str = "other";

    fn session() -> (LiveSession, Arc<AtomicU64>) {
        let t = Arc::new(AtomicU64::new(1000.0f64.to_bits()));
        let c = t.clone();
        (LiveSession::new(Box::new(move || f64::from_bits(c.load(Ordering::SeqCst)))), t)
    }

    fn advance(t: &AtomicU64, by: f64) {
        t.store((f64::from_bits(t.load(Ordering::SeqCst)) + by).to_bits(), Ordering::SeqCst);
    }

    fn doc(n: usize) -> Value {
        json!({"parameters": {}, "features": (0..n).map(|i| json!({"id": format!("f{i}"), "type": "box"})).collect::<Vec<_>>()})
    }

    fn publish(s: &mut LiveSession, host: &str, d: Value, rev: i64) -> Value {
        s.publish(host, d, rev, Value::Null, Value::Null)
    }

    fn features(v: &Value) -> usize {
        v["features"].as_array().map_or(0, Vec::len)
    }

    #[test]
    fn nothing_is_shared_until_an_app_shares_it() {
        let (mut s, _) = session();
        let st = s.state(Some(AGENT), None);
        assert_eq!(st["attached"], false);
        assert!(st["document"].is_null());
        let r = s.propose(AGENT, doc(1), 0, None, None);
        assert_eq!((r["ok"].clone(), r["reason"].clone()), (json!(false), json!("no-host")));
    }

    #[test]
    fn a_guest_reads_exactly_what_the_app_published() {
        let (mut s, _) = session();
        s.publish(APP, doc(3), 7, json!("spool.funda"), json!({"errors": []}));
        let st = s.state(Some(AGENT), None);
        assert_eq!(st["attached"], true);
        assert_eq!((st["revision"].clone(), st["title"].clone()), (json!(7), json!("spool.funda")));
        assert_eq!(features(&st["document"]), 3);
    }

    #[test]
    fn a_guest_cannot_install_a_document_only_offer_one() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(3), 7);
        let r = s.propose(AGENT, doc(99), 7, Some(&json!("add a hole")), None);
        assert_eq!(r["ok"], true);
        assert_eq!(r["proposal"], "p1");
        let st = s.state(Some(OTHER), None);
        assert_eq!(features(&st["document"]), 3);
        assert_eq!(st["revision"], 7);
    }

    #[test]
    fn the_host_collects_proposals_once() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(3), 7);
        s.propose(AGENT, doc(4), 7, Some(&json!("add a hole")), None);
        let got = publish(&mut s, APP, doc(3), 7);
        let p = &got["proposals"];
        assert_eq!(p.as_array().unwrap().len(), 1);
        assert_eq!(p[0]["note"], "add a hole");
        assert_eq!(features(&p[0]["document"]), 4);
        let keys: Vec<&String> = p[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "guest", "name", "note", "baseRevision", "document", "at"]);
        assert_eq!(publish(&mut s, APP, doc(4), 8)["proposals"], json!([]));
    }

    #[test]
    fn an_edit_against_an_older_document_is_refused() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(3), 7);
        publish(&mut s, APP, doc(5), 8);
        let r = s.propose(AGENT, doc(4), 7, None, None);
        assert_eq!((r["ok"].clone(), r["reason"].clone(), r["revision"].clone()), (json!(false), json!("stale"), json!(8)));
        assert!(r["message"].as_str().unwrap().contains("8"));
        assert_eq!(s.propose(AGENT, doc(4), 8, None, None)["ok"], true);
    }

    #[test]
    fn a_backlog_is_refused_rather_than_grown() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(1), 1);
        for _ in 0..MAX_PENDING {
            assert_eq!(s.propose(AGENT, doc(2), 1, None, None)["ok"], true);
        }
        assert_eq!(s.propose(AGENT, doc(2), 1, None, None)["reason"], "backlog");
    }

    #[test]
    fn a_guest_lease_is_refreshed_by_working_and_expires_by_not() {
        let (mut s, t) = session();
        publish(&mut s, APP, doc(1), 1);
        s.state(Some(AGENT), Some(&json!("an assistant")));
        assert_eq!(s.guest_names(), ["an assistant"]);
        advance(&t, GUEST_TTL - 1.0);
        assert_eq!(s.guest_names(), ["an assistant"]);
        advance(&t, 2.0);
        assert!(s.guest_names().is_empty());
    }

    #[test]
    fn an_expired_guest_takes_its_unread_proposals_with_it() {
        let (mut s, t) = session();
        publish(&mut s, APP, doc(1), 1);
        s.propose(AGENT, doc(2), 1, None, Some(&json!("an assistant")));
        advance(&t, GUEST_TTL + 1.0);
        assert_eq!(publish(&mut s, APP, doc(1), 1)["proposals"], json!([]));
    }

    #[test]
    fn leaving_withdraws_only_that_guests_edits() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(1), 1);
        s.propose(AGENT, doc(2), 1, None, None);
        s.propose(OTHER, doc(3), 1, None, None);
        s.leave(AGENT);
        let got = publish(&mut s, APP, doc(1), 1);
        assert_eq!(got["proposals"].as_array().unwrap().len(), 1);
        assert_eq!(got["proposals"][0]["guest"], OTHER);
    }

    #[test]
    fn a_new_host_takes_over_and_inherits_no_edits() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(3), 7);
        s.propose(AGENT, doc(4), 7, None, None);
        assert_eq!(publish(&mut s, "app2", doc(9), 1)["proposals"], json!([]));
        assert_eq!(s.state(None, None)["revision"], 1);
    }

    #[test]
    fn only_the_host_can_end_the_session() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(3), 7);
        assert_eq!(s.release(AGENT)["ok"], false);
        assert_eq!(s.state(None, None)["attached"], true);
        assert_eq!(s.release(APP)["ok"], true);
        let st = s.state(None, None);
        assert_eq!(st["attached"], false);
        assert!(st["document"].is_null());
    }

    #[test]
    fn a_guest_note_is_capped() {
        let (mut s, _) = session();
        publish(&mut s, APP, doc(1), 1);
        s.propose(AGENT, doc(2), 1, Some(&json!("x".repeat(10_000))), None);
        let note = publish(&mut s, APP, doc(1), 1)["proposals"][0]["note"].as_str().unwrap().len();
        assert_eq!(note, MAX_NOTE);
    }

    #[test]
    fn the_wire_ops_read_revisions_like_python() {
        let (mut s, _) = session();
        let req = |v: Value| v.as_object().unwrap().clone();
        let r = session_reply(&mut s, "c1", "session_host", &req(json!({"document": doc(1), "revision": 3.0, "title": "t"}))).unwrap();
        assert_eq!(r, json!({"ok": true, "guests": [], "proposals": []}));
        let r = session_reply(&mut s, "c2", "session_propose", &req(json!({"document": doc(2), "baseRevision": 3}))).unwrap();
        assert_eq!(r, json!({"ok": true, "proposal": "p1", "revision": 3}));
        let st = session_reply(&mut s, "c2", "session_state", &req(json!({}))).unwrap();
        assert_eq!(st["guests"], json!(["c2"]));
        assert!(session_reply(&mut s, "c2", "session_nope", &req(json!({}))).is_err());
    }
}
