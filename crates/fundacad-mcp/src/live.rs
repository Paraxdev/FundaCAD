//! The agent's side of a live session: read the open document, offer an edit.
//! A port of `crates/fundacad-mcp/tools/python-oracle/live_link.py`.
//!
//! `fundacad-engine`'s `live` module holds the rules. This is the half that
//! lives with the agent, and it exists to make one awkward thing invisible to
//! the tools: a guest may not write the document, only propose a replacement
//! that the app applies.
//!
//! So the shape is a mirror. Before a tool runs, `pull` replaces the local
//! document with the app's and remembers the revision it came from. After a
//! tool that changed it, `push` offers the result against that revision and
//! waits for the app to adopt it.
//!
//! WAITING IS THE POINT. `push` does not return until the app has adopted the
//! edit or refused it. An agent that fired and forgot would report "added the
//! hole" and then read a document without one on its next call, with no way to
//! tell that from the app having rejected it.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::link::{args, EngineLink};
use crate::model::Doc;

/// How long to wait for the app to adopt a proposal. The app collects on its
/// own publish loop, so this is measured in polls, not in build time.
pub const ADOPT_TIMEOUT: Duration = Duration::from_secs(30);

/// How often to ask. Loopback and a map lookup on the other end; the cost is
/// the message, not the work.
pub const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Why a live edit did not land. Each variant is a different answer for the
/// user, which is why they are not one error.
#[derive(Debug, Clone)]
pub enum LiveError {
    /// There is no window sharing a document. Distinct from a transport
    /// failure: what the caller should do next is different.
    NoAppOpen(String),
    /// The window is sharing, but not accepting edits.
    ReadOnly(String),
    /// The document moved while the edit was in flight.
    Stale(String),
    /// The app never took it.
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

    /// True when the engine itself went away, which is what makes the server
    /// fall back to a private copy rather than report a refusal.
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
    /// Shown to the user in the app, beside the indicator that says someone is
    /// attached. It is why it is a readable phrase and not a uuid.
    pub name: String,
    /// The revision the local document was pulled from. None means nothing has
    /// been pulled yet, which is not the same as revision 0.
    pub base: Option<i64>,
    pub title: Option<String>,
    pub status: Value,
}

impl Default for LiveLink {
    fn default() -> Self {
        LiveLink {
            name: "an assistant".into(),
            base: None,
            title: None,
            status: json!({}),
        }
    }
}

impl LiveLink {
    pub fn new() -> LiveLink {
        LiveLink::default()
    }

    pub async fn state(&self, link: &EngineLink) -> Result<Value, LiveError> {
        let reply = link
            .call("session_state", args([("name", json!(self.name))]))
            .await
            .map_err(lost)?;
        if reply.get("ok") == Some(&json!(true)) {
            Ok(reply.get("result").cloned().unwrap_or_else(|| json!({})))
        } else {
            Ok(json!({}))
        }
    }

    /// The app's document, and the revision it is at. This refuses rather than
    /// returning nothing when no app is hosting: every caller would otherwise
    /// write the same three lines, and forgetting them means editing nothing.
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
        self.title = st
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string);
        self.status = st.get("status").cloned().unwrap_or_else(|| json!({}));
        Ok(st
            .get("document")
            .and_then(Value::as_object)
            .cloned())
    }

    /// Offer `document` and wait for the app to take it. Returns the revision
    /// the app landed on.
    pub async fn push(
        &mut self,
        link: &EngineLink,
        document: &Doc,
        note: &str,
    ) -> Result<i64, LiveError> {
        if self.base.is_none() {
            self.pull(link).await?;
        }
        if self.status.get("canEdit") == Some(&json!(false)) {
            // Said here rather than discovered by offering an edit and waiting
            // out the adoption timeout, because the two look identical from
            // this side and only one of them has an answer the user can act on.
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
            let proposal = res
                .get("proposal")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            return self.await_adoption(link, &proposal).await;
        }
        let message = res
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match res.get("reason").and_then(Value::as_str) {
            Some("no-host") => Err(LiveError::NoAppOpen(if message.is_empty() {
                "no FundaCAD window is open".into()
            } else {
                message
            })),
            // Its own kind, because the caller's answer to it is different from
            // every other refusal: re-read and decide again, rather than report
            // a failure.
            Some("stale") => Err(LiveError::Stale(if message.is_empty() {
                "the document moved on".into()
            } else {
                message
            })),
            reason => Err(LiveError::Refused(if message.is_empty() {
                format!("the edit was refused ({})", reason.unwrap_or("unknown"))
            } else {
                message
            })),
        }
    }

    /// Block until the app has actually taken THIS edit.
    ///
    /// The app publishes the ids of the proposals it applied, and that is the
    /// acknowledgement. Neither of the two things that look like one will do:
    /// the revision moves for the user's own edits too, and the published
    /// document is never byte-identical to what was offered because the app
    /// migrates and normalises it on the way in.
    async fn await_adoption(&mut self, link: &EngineLink, proposal: &str) -> Result<i64, LiveError> {
        let deadline = Instant::now() + ADOPT_TIMEOUT;
        while Instant::now() < deadline {
            tokio::time::sleep(POLL_INTERVAL).await;
            let st = self.state(link).await?;
            if st.get("attached") != Some(&json!(true)) {
                return Err(LiveError::NoAppOpen(
                    "the FundaCAD window closed before the edit was applied".into(),
                ));
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
