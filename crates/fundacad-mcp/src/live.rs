//! The agent's side of a live session. A guest may only propose a replacement document, so `pull`
//! mirrors the app's before a tool and `push` waits until the app adopts or refuses the result.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::link::{args, EngineLink};
use crate::model::Doc;

/// The app collects on its own publish loop, so this is measured in polls, not in build time.
pub const ADOPT_TIMEOUT: Duration = Duration::from_secs(30);

/// Loopback and a map lookup on the other end: the cost is the message, not the work.
pub const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Each variant is a different answer for the user, which is why they are not one error.
#[derive(Debug, Clone)]
pub enum LiveError {
    /// No window shares a document. Unlike a transport failure, the caller does something else next.
    NoAppOpen(String),
    /// The window is sharing, but not accepting edits.
    ReadOnly(String),
    /// The document moved while the edit was in flight.
    Stale(String),
    Timeout(String),
    /// The engine refused, or something else went wrong that is not transport.
    Refused(String),
    /// The socket went away: the window closed, or the engine was restarted.
    Lost(String),
}

impl LiveError {
    pub fn message(&self) -> &str {
        match self {
            LiveError::NoAppOpen(m)
            | LiveError::ReadOnly(m)
            | LiveError::Stale(m)
            | LiveError::Timeout(m)
            | LiveError::Refused(m)
            | LiveError::Lost(m) => m,
        }
    }

    /// The engine itself went away, so the server falls back to a private copy instead of reporting a refusal.
    pub fn is_lost(&self) -> bool {
        matches!(self, LiveError::Lost(_))
    }
}

impl std::fmt::Display for LiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

fn lost(e: std::io::Error) -> LiveError {
    LiveError::Lost(e.to_string())
}

/// One agent's view of the document a running app has open.
pub struct LiveLink {
    /// Shown to the user beside the attached indicator, which is why it is a readable phrase and not a uuid.
    pub name: String,
    /// None means nothing has been pulled yet, which is not the same as revision 0.
    pub base: Option<i64>,
    pub title: Option<String>,
    pub status: Value,
}

impl Default for LiveLink {
    fn default() -> Self {
        LiveLink { name: "an assistant".into(), base: None, title: None, status: json!({}) }
    }
}

impl LiveLink {
    pub fn new() -> LiveLink {
        LiveLink::default()
    }

    pub async fn state(&self, link: &EngineLink) -> Result<Value, LiveError> {
        let reply = link.call("session_state", args([("name", json!(self.name))])).await.map_err(lost)?;
        if reply.get("ok") == Some(&json!(true)) {
            Ok(reply.get("result").cloned().unwrap_or_else(|| json!({})))
        } else {
            Ok(json!({}))
        }
    }

    /// Refuses rather than returning nothing when no app is hosting,
    /// since a caller that forgot to check would edit nothing.
    pub async fn pull(&mut self, link: &EngineLink) -> Result<Option<Doc>, LiveError> {
        let st = self.state(link).await?;
        if st.get("attached") != Some(&json!(true)) {
            return Err(LiveError::NoAppOpen(
                "no FundaCAD window is sharing a document, open one, or turn on live editing \
                 in its settings"
                    .into(),
            ));
        }
        self.base = Some(st.get("revision").and_then(Value::as_i64).unwrap_or(0));
        self.title = st.get("title").and_then(Value::as_str).map(str::to_string);
        self.status = st.get("status").cloned().unwrap_or_else(|| json!({}));
        Ok(st.get("document").and_then(Value::as_object).cloned())
    }

    /// Waits for the app to take `document` and returns the revision it landed on.
    pub async fn push(&mut self, link: &EngineLink, document: &Doc, note: &str) -> Result<i64, LiveError> {
        if self.base.is_none() {
            self.pull(link).await?;
        }
        if self.status.get("canEdit") == Some(&json!(false)) {
            // Said here, not found by waiting out the adoption timeout, which looks the same from this side
            // but leaves the user nothing to act on.
            return Err(LiveError::ReadOnly(
                "that FundaCAD window is sharing its document read-only, set live editing to \
                 \"Read and edit\" in its preferences to let an assistant change it"
                    .into(),
            ));
        }
        let reply = link
            .call(
                "session_propose",
                args([
                    ("document", Value::Object(document.clone())),
                    ("baseRevision", json!(self.base)),
                    ("note", json!(note)),
                    ("name", json!(self.name)),
                ]),
            )
            .await
            .map_err(lost)?;
        if reply.get("ok") != Some(&json!(true)) {
            let message = reply
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("the engine refused the edit");
            return Err(LiveError::Refused(message.into()));
        }
        let res = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        if res.get("ok") == Some(&json!(true)) {
            let proposal = res.get("proposal").and_then(Value::as_str).unwrap_or_default().to_string();
            return self.await_adoption(link, &proposal).await;
        }
        let message = res.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
        match res.get("reason").and_then(Value::as_str) {
            Some("no-host") => Err(LiveError::NoAppOpen(if message.is_empty() {
                "no FundaCAD window is open".into()
            } else {
                message
            })),
            // Its own kind: the caller re-reads and decides again rather than reporting a failure.
            Some("stale") => {
                Err(LiveError::Stale(if message.is_empty() { "the document moved on".into() } else { message }))
            }
            reason => Err(LiveError::Refused(if message.is_empty() {
                format!("the edit was refused ({})", reason.unwrap_or("unknown"))
            } else {
                message
            })),
        }
    }

    /// Blocks until the app has taken THIS edit, acknowledged by the proposal ids it publishes. The revision
    /// moves for the user's edits too, and the app normalises what it adopts, so neither can stand in.
    async fn await_adoption(&mut self, link: &EngineLink, proposal: &str) -> Result<i64, LiveError> {
        let deadline = Instant::now() + ADOPT_TIMEOUT;
        while Instant::now() < deadline {
            tokio::time::sleep(POLL_INTERVAL).await;
            let st = self.state(link).await?;
            if st.get("attached") != Some(&json!(true)) {
                return Err(LiveError::NoAppOpen("the FundaCAD window closed before the edit was applied".into()));
            }
            let status = st.get("status").cloned().unwrap_or_else(|| json!({}));
            let applied = status
                .get("applied")
                .and_then(Value::as_array)
                .map(|a| a.iter().any(|v| v.as_str() == Some(proposal)))
                .unwrap_or(false);
            if applied {
                self.base = Some(st.get("revision").and_then(Value::as_i64).unwrap_or(0));
                self.title = st.get("title").and_then(Value::as_str).map(str::to_string);
                self.status = status;
                return Ok(self.base.unwrap_or(0));
            }
        }
        Err(LiveError::Timeout(format!(
            "the FundaCAD window did not apply the edit within {}s, it may be busy, or live \
             editing may be turned off in its settings",
            ADOPT_TIMEOUT.as_secs()
        )))
    }

    /// Give up the lease so the app stops showing an assistant attached.
    pub async fn leave(&self, link: &EngineLink) {
        // On the way out. A lease left behind expires on its own.
        let _ = link.call("session_leave", json!({})).await;
    }
}
