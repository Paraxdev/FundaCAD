//! One document an app and an agent both work on. Exactly one host (the running app) owns it and alone raises its
//! revision; guests read it and propose replacements, which the host collects on its next publish.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

/// Seconds a guest counts as present after its last call.
pub const GUEST_TTL: f64 = 45.0;
/// Proposals waiting for the host before a guest is told `backlog`.
pub const MAX_PENDING: usize = 8;
/// Characters of a guest's note kept; it is shown to the user.
pub const MAX_NOTE: usize = 400;
/// Characters of a guide caption kept.
pub const MAX_CAPTION: usize = 600;
/// Refusals of the engine's own kept for guests, as many as the app keeps of its own.
pub const MAX_REFUSED: usize = 16;

pub type Clock = Box<dyn Fn() -> f64 + Send>;

pub struct LiveSession {
    clock: Clock,
    host_id: Option<String>,
    /// The host's open document session, null for a host that names none. Proposals are only ever for it.
    doc: Value,
    document: Value,
    revision: i64,
    title: Value,
    status: Value,
    /// id to (name, last seen).
    guests: HashMap<String, (Value, f64)>,
    pending: Vec<Map<String, Value>>,
    /// Proposals whose base the host moved past before collecting them, shown to guests beside the host's refusals.
    refused: Vec<Value>,
    next_proposal: u64,
    /// What the host's guide shows, stored as the host sent it.
    guide_state: Value,
    /// At most one step (highlight or clear) and one wait, the newest of each.
    guide_step: Option<Map<String, Value>>,
    guide_wait: Option<Map<String, Value>>,
    next_guide_seq: i64,
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
            doc: Value::Null,
            document: Value::Null,
            revision: 0,
            title: Value::Null,
            status: json!({}),
            guests: HashMap::new(),
            pending: Vec::new(),
            refused: Vec::new(),
            next_proposal: 0,
            guide_state: Value::Null,
            guide_step: None,
            guide_wait: None,
            next_guide_seq: 0,
        }
    }

    /// A session on a monotonic clock started now.
    pub fn monotonic() -> LiveSession {
        let start = std::time::Instant::now();
        LiveSession::new(Box::new(move || start.elapsed().as_secs_f64()))
    }

    fn reset(&mut self) {
        self.host_id = None;
        self.doc = Value::Null;
        self.document = Value::Null;
        self.revision = 0;
        self.title = Value::Null;
        self.status = json!({});
        self.guests.clear();
        self.pending.clear();
        self.refused.clear();
        self.next_proposal = 0;
        self.reset_guide();
    }

    fn reset_guide(&mut self) {
        self.guide_state = Value::Null;
        self.guide_step = None;
        self.guide_wait = None;
    }

    fn drop_guide_of(&mut self, guest_id: &str) {
        let mine = |c: &Option<Map<String, Value>>| {
            c.as_ref().and_then(|c| c.get("guest")).and_then(Value::as_str) == Some(guest_id)
        };
        if mine(&self.guide_step) {
            self.guide_step = None;
        }
        if mine(&self.guide_wait) {
            self.guide_wait = None;
        }
    }

    /// `publish`: the host says what it has and collects what guests asked for. Proposals and guide commands made
    /// for another host or another of its documents are dropped, never handed to the document open now.
    pub fn publish(&mut self, host_id: &str, document: Value, revision: i64, title: Value, status: Value) -> Value {
        self.publish_doc(host_id, Value::Null, document, revision, title, status)
    }

    /// [`Self::publish`] by a host that names its open document session.
    pub fn publish_doc(
        &mut self,
        host_id: &str,
        doc: Value,
        document: Value,
        revision: i64,
        title: Value,
        status: Value,
    ) -> Value {
        if self.host_id.as_deref() != Some(host_id) || self.doc != doc {
            self.host_id = Some(host_id.to_owned());
            self.doc = doc;
            self.pending.clear();
            self.refused.clear();
            self.reset_guide();
        }
        self.document = document;
        self.revision = revision;
        self.title = title;
        self.status = if truthy(Some(&status)) { status } else { json!({}) };
        // Expire first, then take, or a dead guest's proposal is handed over on its way out.
        let guests = self.guest_names();
        // An edit or import that landed since the guest read would be wiped by handing it over.
        let (taken, stale): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|p| p.get("baseRevision").and_then(Value::as_i64) == Some(revision));
        for p in stale {
            let base = p.get("baseRevision").cloned().unwrap_or(Value::Null);
            let message = format!(
                "the document in the app changed before it took this edit (revision {base} -> {revision}), \
                 nothing was applied; read it again with doc_get and retry"
            );
            self.refused.push(json!({"id": p.get("id").cloned().unwrap_or(Value::Null), "message": message}));
        }
        let over = self.refused.len().saturating_sub(MAX_REFUSED);
        self.refused.drain(..over);
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
        let mut st = json!({
            "attached": self.host_id.is_some(),
            "revision": self.revision,
            "title": self.title,
            "status": self.status_with_refusals(),
            "document": self.document,
            "guests": self.guest_names(),
        });
        if !self.doc.is_null() {
            st["doc"] = self.doc.clone();
        }
        st
    }

    fn status_with_refusals(&self) -> Value {
        let mut status = self.status.clone();
        if self.refused.is_empty() {
            return status;
        }
        let Some(obj) = status.as_object_mut() else { return status };
        let mut refused = obj.get("refused").and_then(Value::as_array).cloned().unwrap_or_default();
        refused.extend(self.refused.iter().cloned());
        obj.insert("refused".into(), Value::Array(refused));
        status
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
        self.propose_doc(guest_id, document, base_revision, None, note, name)
    }

    /// [`Self::propose_doc`] for a whole other document (a guest's `doc_new`, `doc_open` or `doc_set`), marked so
    /// the app can refuse it while an import it would swallow is still being read.
    #[allow(clippy::too_many_arguments)]
    pub fn propose_replacing(
        &mut self,
        guest_id: &str,
        document: Value,
        base_revision: i64,
        doc: Option<&Value>,
        note: Option<&Value>,
        name: Option<&Value>,
        replaces: bool,
    ) -> Value {
        let out = self.propose_doc(guest_id, document, base_revision, doc, note, name);
        if replaces && out.get("ok") == Some(&json!(true)) {
            if let Some(p) = self.pending.last_mut() {
                p.insert("replaces".into(), json!(true));
            }
        }
        out
    }

    /// [`Self::propose`] for the document session `doc` the guest read, refused once the host has another open.
    pub fn propose_doc(
        &mut self,
        guest_id: &str,
        document: Value,
        base_revision: i64,
        doc: Option<&Value>,
        note: Option<&Value>,
        name: Option<&Value>,
    ) -> Value {
        self.touch(guest_id, name);
        if self.host_id.is_none() {
            return json!({"ok": false, "reason": "no-host",
                "message": "no FundaCAD window is sharing a document"});
        }
        if doc.is_some_and(|d| !d.is_null() && *d != self.doc) {
            return json!({"ok": false, "reason": "doc-changed",
                "message": "the document in the app changed, nothing was applied"});
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
        if !self.doc.is_null() {
            p.insert("doc".into(), self.doc.clone());
        }
        p.insert("document".into(), document);
        p.insert("at".into(), json!((self.clock)()));
        self.pending.push(p);
        json!({"ok": true, "proposal": pid, "revision": self.revision})
    }

    pub fn leave(&mut self, guest_id: &str) -> Value {
        self.guests.remove(guest_id);
        self.pending.retain(|p| p.get("guest").and_then(Value::as_str) != Some(guest_id));
        self.drop_guide_of(guest_id);
        json!({"ok": true})
    }

    /// `guide` from the host: store what its guide shows and hand over the commands, oldest first.
    pub fn guide_host(&mut self, host_id: &str, state: Value) -> Value {
        if self.host_id.as_deref() != Some(host_id) {
            return json!({"ok": false, "reason": "not the host"});
        }
        self.guest_names();
        self.guide_state = state;
        let mut commands: Vec<Map<String, Value>> =
            self.guide_step.take().into_iter().chain(self.guide_wait.take()).collect();
        commands.sort_by_key(|c| c.get("seq").and_then(Value::as_i64).unwrap_or(0));
        json!({"ok": true, "commands": commands})
    }

    /// `guide` from a guest: its heartbeat, an optional command, and what the host's guide shows.
    pub fn guide_guest(&mut self, guest_id: &str, command: Option<&Value>, name: Option<&Value>) -> Value {
        self.touch(guest_id, name);
        if self.host_id.is_none() {
            return json!({"ok": false, "reason": "no-host",
                "message": "no FundaCAD window is sharing a document"});
        }
        let Some(Value::Object(cmd)) = command else {
            return json!({"ok": true, "attached": true, "seq": null, "guide": self.guide_state});
        };
        let mut cmd = cmd.clone();
        if let Some(Value::String(c)) = cmd.get("caption") {
            let capped: String = c.chars().take(MAX_CAPTION).collect();
            cmd.insert("caption".into(), json!(capped));
        }
        self.next_guide_seq += 1;
        let seq = self.next_guide_seq;
        cmd.insert("seq".into(), json!(seq));
        cmd.insert("guest".into(), json!(guest_id));
        if cmd.get("kind").and_then(Value::as_str) == Some("wait") {
            self.guide_wait = Some(cmd);
        } else {
            self.guide_step = Some(cmd);
        }
        json!({"ok": true, "attached": true, "seq": seq, "guide": self.guide_state})
    }

    /// Who is attached right now, expired guests dropped with their proposals.
    pub fn guest_names(&mut self) -> Vec<String> {
        let now = (self.clock)();
        let expired: Vec<String> =
            self.guests.iter().filter(|(_, (_, seen))| now - seen > GUEST_TTL).map(|(g, _)| g.clone()).collect();
        for g in expired {
            self.guests.remove(&g);
            self.pending.retain(|p| p.get("guest").and_then(Value::as_str) != Some(g.as_str()));
            self.drop_guide_of(&g);
        }
        let mut names: Vec<String> = self.guests.values().map(|(n, _)| name_text(n)).collect();
        names.sort();
        names
    }

    /// Who the connection `id` is to another client waiting behind its job:
    /// the app hosting the document, an assistant working on it, or neither.
    pub fn role_of(&self, id: &str) -> Value {
        if self.host_id.as_deref() == Some(id) {
            return json!({"who": "app"});
        }
        match self.guests.get(id) {
            Some((name, _)) => json!({"who": "assistant", "name": name_text(name)}),
            None => json!({"who": "session"}),
        }
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

/// The six `session_*` ops for the connection `who`. `Err` is the error message for the reply envelope.
pub fn session_reply(live: &mut LiveSession, who: &str, op: &str, req: &Map<String, Value>) -> Result<Value, String> {
    let get = |k: &str| req.get(k).cloned().unwrap_or(Value::Null);
    let revision = |k: &str| -> Result<i64, String> {
        match req.get(k).filter(|v| truthy(Some(v))) {
            None => Ok(0),
            Some(v) => py_int(v).ok_or_else(|| format!("invalid literal for int(): {v}")),
        }
    };
    Ok(match op {
        "session_host" => {
            live.publish_doc(who, get("doc"), get("document"), revision("revision")?, get("title"), get("status"))
        }
        "session_release" => live.release(who),
        "session_state" => live.state(Some(who), req.get("name")),
        "session_propose" => {
            let base = revision("baseRevision")?;
            let replaces = truthy(req.get("replaces"));
            live.propose_replacing(
                who,
                get("document"),
                base,
                req.get("doc"),
                req.get("note"),
                req.get("name"),
                replaces,
            )
        }
        "session_leave" => live.leave(who),
        "session_guide" => {
            if live.host_id.as_deref() == Some(who) {
                live.guide_host(who, get("state"))
            } else if req.contains_key("state") {
                json!({"ok": false, "reason": "not the host"})
            } else {
                live.guide_guest(who, req.get("command"), req.get("name"))
            }
        }
        other => return Err(format!("unknown session op: {other}")),
    })
}

pub fn is_session_op(op: &str) -> bool {
    matches!(
        op,
        "session_host" | "session_release" | "session_state" | "session_propose" | "session_leave" | "session_guide"
    )
}
