//! Guide mode: the assistant points at controls and model areas in the user's
//! open FundaCAD window, one step at a time, and waits for the user. It rides the
//! live session (`session_guide`, docs/PROTOCOL.md), so it needs a window that
//! shares its document and refuses everywhere else.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::{CallToolResult, JsonObject};
use rmcp::{tool, tool_router, ErrorData as McpError};
use serde_json::{json, Map, Value};

use crate::link::{mode_from_env, EngineLink, Mode};
use crate::server::{failure, text, FundaCad};

pub const GUIDE_TOOLS: &[&str] = &["guide_highlight", "guide_wait", "guide_clear"];

/// How long a step may go unacknowledged before the window is called too old.
/// The window polls every 200 ms while a guide is up and every 700 ms otherwise.
pub const ACK_TIMEOUT: Duration = Duration::from_secs(3);
const ACK_POLL: Duration = Duration::from_millis(150);
/// Also the guest's heartbeat while it waits, well inside the engine's 45 s lease.
const WAIT_POLL: Duration = Duration::from_millis(200);
pub const WAIT_DEFAULT_S: u64 = 60;
/// `guide_stops` before this server first read the window's guide.
pub const UNSEEN: i64 = -1;
pub const WAIT_MAX_S: u64 = 120;

pub const STANDALONE: &str = "guide mode shows steps in the open FundaCAD window, and \
    FUNDACAD_MCP_MODE=standalone never attaches to one. Use auto or attach.";
pub const NO_WINDOW: &str = "no FundaCAD window is sharing its document, so there is nowhere to \
    show the guide. Open FundaCAD and set Live document to Share.";
const PRIVATE_NOTE: &str = " This conversation has been working on a private copy, so it will \
    not attach until the server restarts.";
pub const OLD_ENGINE: &str = "FundaCAD's engine is older than guide mode, update FundaCAD.";
pub const OLD_WINDOW: &str = "the FundaCAD window did not take the step within 3 s, it is \
    probably older than guide mode. Update FundaCAD.";

const WAIT_KINDS: &[&str] = &["next", "tool", "feature", "selection", "value"];

fn obj(v: Value) -> JsonObject {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub fn guide_highlight_schema() -> JsonObject {
    obj(json!({
        "type": "object",
        "properties": {
            "ui": {"type": "string", "description": "a control id as the harness names it: \
                #browser, action:undo, family:cat:MODIFY, pick:fillet (rings Modify while Fillet \
                is folded inside it), field:radius, prop:radius, feature:f1, item:body1, \
                menu:File/Open..."},
            "model": {"type": "string", "description": "a model area, harness selectors: \
                body1:top, body1:index=3, body1:between top front (an edge), body1:near=10,0,5, \
                or a body id. Not inspect's selectors"},
            "region": {"type": "object", "description": "a part of the view as fractions of \
                it, 0 to 1", "properties": {"x": {"type": "number"}, "y": {"type": "number"},
                "w": {"type": "number"}, "h": {"type": "number"}}, "required": ["x", "y", "w", "h"]},
            "caption": {"type": "string", "description": "what the user should do, one or two short sentences"},
            "step": {"type": "integer", "minimum": 1},
            "of": {"type": "integer", "minimum": 1}
        },
        "required": ["caption"]
    }))
}

pub fn guide_wait_schema() -> JsonObject {
    obj(json!({
        "type": "object",
        "properties": {
            "until": {"description": "what to wait for, one or a list: next (the user pressed \
                Next), tool (a tool started), feature (a feature was added), selection, value \
                (typed in the value box)",
                "anyOf": [{"type": "string", "enum": WAIT_KINDS},
                          {"type": "array", "items": {"type": "string", "enum": WAIT_KINDS}}]},
            "tool": {"type": "string", "description": "only this tool or feature type, such as fillet"},
            "field": {"type": "string", "description": "only this value box field, such as radius"},
            "timeout_s": {"type": "integer", "minimum": 1, "maximum": WAIT_MAX_S,
                "description": "default 60"}
        },
        "required": []
    }))
}

pub fn guide_clear_schema() -> JsonObject {
    obj(json!({"type": "object", "properties": {}, "required": []}))
}

fn stopped_text(stopped: &Value) -> String {
    let (step, of) = (stopped["step"].as_i64().unwrap_or(0), stopped["of"].as_i64().unwrap_or(0));
    if of > 0 {
        format!("the user stopped the guide at step {step} of {of}, everything is cleared")
    } else {
        "the user stopped the guide, everything is cleared".into()
    }
}

impl FundaCad {
    /// The link to the user's window, or the reason there is none.
    async fn guide_link(&self) -> Result<(Arc<EngineLink>, String), CallToolResult> {
        if mode_from_env() == Mode::Standalone {
            return Err(failure(STANDALONE));
        }
        let (link, live, private) = self.guide_parts().await;
        match live {
            Some(name) => Ok((link, name)),
            None => Err(failure(format!("{NO_WINDOW}{}", if private { PRIVATE_NOTE } else { "" }))),
        }
    }

    /// One `session_guide`, its reply's result, or the failure to hand back.
    async fn guide_call(&self, link: &EngineLink, name: &str, command: Option<Value>) -> Result<Value, CallToolResult> {
        let mut payload = json!({"name": name});
        if let Some(c) = command {
            payload["command"] = c;
        }
        let reply = link
            .call("session_guide", payload)
            .await
            .map_err(|e| failure(format!("FundaCAD's engine went away: {e}")))?;
        if reply.get("ok") != Some(&json!(true)) {
            let why = reply["error"]["message"].as_str().unwrap_or("").to_owned();
            if why.contains("session_guide") && why.contains("unknown") {
                return Err(failure(OLD_ENGINE));
            }
            return Err(failure(format!("the engine refused the guide: {why}")));
        }
        let res = reply.get("result").cloned().unwrap_or(Value::Null);
        if res.get("ok") != Some(&json!(true)) {
            return Err(failure(NO_WINDOW));
        }
        Ok(res)
    }

    /// A Stop the assistant has not been told about yet, as its sentence.
    fn unreported_stop(&self, guide: &Value) -> Option<String> {
        let stopped = guide.get("stopped").filter(|s| s.is_object());
        let n = stopped.and_then(|s| s["n"].as_i64()).unwrap_or(0);
        let seen = self.guide_stops.swap(n, Ordering::SeqCst);
        // Unknown until the first look: a Stop from before this server started was
        // someone else's guide. A smaller count is a new window, whose stops start again.
        if seen == UNSEEN || n <= seen {
            return None;
        }
        stopped.map(stopped_text)
    }

    /// Send a command and wait for the window to take it.
    async fn guide_send(&self, command: Value) -> Result<(Value, i64), CallToolResult> {
        let (link, name) = self.guide_link().await?;
        let first = self.guide_call(&link, &name, None).await?;
        if let Some(stop) = self.unreported_stop(&first["guide"]) {
            return Err(text(format!("{stop}. Nothing new was shown; call again to start a new guide.")));
        }
        let sent = self.guide_call(&link, &name, Some(command)).await?;
        let seq = sent["seq"].as_i64().unwrap_or(i64::MAX);
        let until = Instant::now() + ACK_TIMEOUT;
        loop {
            let res = self.guide_call(&link, &name, None).await?;
            let g = &res["guide"];
            if g["ack"].as_i64().is_some_and(|a| a >= seq) {
                return Ok((g.clone(), seq));
            }
            if Instant::now() >= until {
                return Err(failure(OLD_WINDOW));
            }
            tokio::time::sleep(ACK_POLL).await;
        }
    }
}

fn step_reply(guide: &Value, asked: &str) -> CallToolResult {
    let st = &guide["step"];
    let at = match (st["step"].as_i64(), st["of"].as_i64()) {
        (Some(s), Some(o)) if o > 1 => format!("step {s} of {o}"),
        _ => "the step".into(),
    };
    if st["found"] == json!(true) {
        match st["via"].as_str() {
            Some(via) => text(format!(
                "{at} is up on {via}: {asked} is folded inside it, the ring moves there once the user opens it"
            )),
            None => text(format!("{at} is up on {asked}")),
        }
    } else {
        let mut why = st["missing"].as_str().unwrap_or("not found").to_owned();
        if let Some(near) = st["near"].as_array().filter(|n| !n.is_empty()) {
            let near: Vec<&str> = near.iter().filter_map(Value::as_str).collect();
            why.push_str(&format!(". Near: {}", near.join(", ")));
        }
        failure(format!("{at} shows its caption with no ring: {why}"))
    }
}

#[tool_router(router = guide_router, vis = "pub(crate)")]
impl FundaCad {
    #[tool(
        name = "guide_highlight",
        description = "Guide mode: show the user one step in their open FundaCAD window, a pulsing ring on a control (ui), a model area (model) or a part of the view (region), with your caption and Next and Stop buttons. Give exactly one of ui, model or region. Then guide_wait for the user. Needs the window to share its document; refuses in standalone mode.",
        input_schema = crate::guide::guide_highlight_schema()
    )]
    pub async fn t_guide_highlight(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let targets: Vec<&str> = ["ui", "model", "region"].into_iter().filter(|k| args.contains_key(*k)).collect();
        if targets.len() != 1 {
            return Ok(failure("give exactly one of ui, model or region"));
        }
        let key = targets[0];
        let asked = match &args[key] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let command = json!({
            "kind": "highlight",
            "target": {key: args[key].clone()},
            "caption": args.get("caption").cloned().unwrap_or(json!("")),
            "step": args.get("step").cloned().unwrap_or(json!(1)),
            "of": args.get("of").cloned().unwrap_or(json!(1)),
        });
        Ok(match self.guide_send(command).await {
            Ok((g, _)) => step_reply(&g, &asked),
            Err(out) => out,
        })
    }

    #[tool(
        name = "guide_wait",
        description = "Guide mode: wait for the user after guide_highlight, until they press Next, start a tool, add a feature, select something or type a value. One line says what happened, or that they pressed Stop, which clears the guide. Holds this conversation's tool calls for up to timeout_s (default 60, at most 120).",
        input_schema = crate::guide::guide_wait_schema()
    )]
    pub async fn t_guide_wait(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let until = match args.get("until") {
            None => json!(["next"]),
            Some(Value::String(s)) => json!([s]),
            Some(v) => v.clone(),
        };
        let timeout = args.get("timeout_s").and_then(Value::as_u64).unwrap_or(WAIT_DEFAULT_S).clamp(1, WAIT_MAX_S);
        let mut command = json!({"kind": "wait", "until": until});
        for k in ["tool", "field"] {
            if let Some(v) = args.get(k) {
                command[k] = v.clone();
            }
        }
        let (g, seq) = match self.guide_send(command).await {
            Ok(sent) => sent,
            Err(out) => return Ok(out),
        };
        let (link, name) = match self.guide_link().await {
            Ok(l) => l,
            Err(out) => return Ok(out),
        };
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let mut guide = g;
        loop {
            let w = &guide["wait"];
            if w["seq"].as_i64() == Some(seq) {
                if let Some(done) = w["done"].as_str() {
                    if done == "stopped" {
                        self.unreported_stop(&guide);
                    }
                    return Ok(text(w["what"].as_str().unwrap_or(done).to_owned()));
                }
            } else if let Some(stop) = self.unreported_stop(&guide) {
                return Ok(text(stop));
            }
            if Instant::now() >= deadline {
                return Ok(text(format!("nothing happened in {timeout} s, the step is still up")));
            }
            tokio::time::sleep(WAIT_POLL).await;
            guide = match self.guide_call(&link, &name, None).await {
                Ok(res) => res["guide"].clone(),
                Err(out) => return Ok(out),
            };
        }
    }

    #[tool(
        name = "guide_clear",
        description = "Guide mode: take the ring and caption off the user's window, at the end of a guide.",
        input_schema = crate::guide::guide_clear_schema()
    )]
    pub async fn t_guide_clear(&self, _args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(match self.guide_send(json!({"kind": "clear"})).await {
            Ok(_) => text("the guide is cleared"),
            Err(out) => out,
        })
    }
}
