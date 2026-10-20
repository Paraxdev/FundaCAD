//! The ui tools: a private copy of the app in a browser, driven the way a
//! person drives it, through the harness in tools/harness (docs/HARNESS.md).
//!
//! The browser is owned by a Python child, `python -m fundacad_harness serve`,
//! spoken to in JSON lines on its stdin and stdout. It starts on the first
//! `ui_open` and stops with the server. Standalone only, so the window it
//! drives is never the user's.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject};
use rmcp::{tool, tool_router, ErrorData as McpError};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::server::{failure, log, text, FundaCad, MAX_IMAGE_PX};

pub const UI_TOOLS: &[&str] = &["ui_open", "ui_do", "ui_read", "ui_shot", "ui_close"];

pub const RELAY_TIMEOUT: Duration = Duration::from_secs(180);

const CLOSE_GRACE: Duration = Duration::from_secs(20);

const INSTALL_HINT: &str =
    "pip install -e tools/harness into the Python that FUNDACAD_HARNESS_PYTHON names";

/// `FUNDACAD_HARNESS_PYTHON`, else the Python on PATH.
pub fn python_command() -> Vec<String> {
    match std::env::var("FUNDACAD_HARNESS_PYTHON")
        .ok()
        .filter(|p| !p.trim().is_empty())
    {
        Some(p) => crate::link::split_command(&p),
        None => vec![if cfg!(windows) { "python" } else { "python3" }.into()],
    }
}

/// The inverse of `split_command`, which groups by quotes and has no escapes.
pub fn join_command(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            if a.chars().any(char::is_whitespace) {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub struct UiBridge {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    said: Arc<std::sync::Mutex<VecDeque<String>>>,
    python: String,
    #[cfg(windows)]
    job: crate::link::job::ProcessJob,
}

impl UiBridge {
    pub async fn spawn() -> Result<UiBridge, String> {
        let argv = python_command();
        let python = join_command(&argv);
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]).args(["-m", "fundacad_harness", "serve"]);
        let engine = crate::link::engine_command();
        if engine
            .first()
            .is_some_and(|p| std::path::Path::new(p).is_file())
        {
            cmd.env("FUNDACAD_ENGINE_CMD", join_command(&engine));
        }
        cmd.env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| {
            format!("could not start {python}: {e}. {INSTALL_HINT}, or set FUNDACAD_HARNESS_PYTHON to one that has it.")
        })?;
        #[cfg(windows)]
        let job = {
            let job = crate::link::job::ProcessJob::new();
            if let Some(pid) = child.id() {
                job.adopt(pid);
            }
            job
        };
        let said = Arc::new(std::sync::Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            let said = said.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[ui] {line}");
                    let mut said = said.lock().unwrap_or_else(|p| p.into_inner());
                    if said.len() == 30 {
                        said.pop_front();
                    }
                    said.push_back(line);
                }
            });
        }
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped");
        log(&format!("[mcp] started the ui harness with {python}"));
        Ok(UiBridge {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 0,
            said,
            python,
            #[cfg(windows)]
            job,
        })
    }

    /// The reply to one call. An Err means the child is gone or stuck, and
    /// the bridge is no use any more.
    pub async fn request(&mut self, call: &str, args: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let line = json!({"id": id, "call": call, "args": args}).to_string() + "\n";
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(self.gone().await);
        };
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            return Err(self.gone().await);
        }
        let answer = tokio::time::timeout(RELAY_TIMEOUT, async {
            loop {
                match self.lines.next_line().await {
                    Ok(Some(line)) => {
                        let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                            log(&format!("[ui] not a reply: {line}"));
                            continue;
                        };
                        if reply.get("id").and_then(Value::as_u64) == Some(id) {
                            return Some(reply);
                        }
                    }
                    _ => return None,
                }
            }
        })
        .await;
        match answer {
            Ok(Some(reply)) => Ok(reply),
            Ok(None) => Err(self.gone().await),
            Err(_) => Err(format!(
                "the app gave no answer to {call} in {} s, so it was stopped. ui_open starts a fresh one.",
                RELAY_TIMEOUT.as_secs()
            )),
        }
    }

    async fn gone(&mut self) -> String {
        // The stderr reader may still be draining what the child said last.
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let said: Vec<String> = self
            .said
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .collect();
        if said.iter().any(|l| l.contains("No module named")) {
            return format!("the harness is not installed for {}: {INSTALL_HINT}.", self.python);
        }
        let tail = said.iter().rev().take(6).rev().cloned().collect::<Vec<_>>();
        if tail.is_empty() {
            "the ui harness stopped without a word. ui_open starts a fresh one.".to_string()
        } else {
            format!(
                "the ui harness stopped. ui_open starts a fresh one. It said:\n{}",
                tail.join("\n")
            )
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Ends stdin, which closes the session and everything it started, and
    /// kills the child only if that takes too long.
    pub async fn stop(mut self) {
        self.stdin = None;
        if tokio::time::timeout(CLOSE_GRACE, self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
        }
        #[cfg(windows)]
        self.job.close();
    }
}

fn reply_result(reply: &Value) -> CallToolResult {
    let said = reply.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
    if !reply.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return failure(said);
    }
    match reply.get("png").and_then(Value::as_str) {
        Some(png) => CallToolResult::success(vec![
            ContentBlock::text(said),
            ContentBlock::image(png.to_string(), "image/png"),
        ]),
        None => text(said),
    }
}

impl FundaCad {
    async fn relay(&self, call: &str, args: JsonObject) -> CallToolResult {
        let mut ui = self.ui.lock().await;
        if ui.is_none() {
            if call != "open" {
                return failure("no app is open, call ui_open first.");
            }
            match UiBridge::spawn().await {
                Ok(bridge) => *ui = Some(bridge),
                Err(why) => return failure(why),
            }
        }
        let bridge = ui.as_mut().expect("set above");
        match bridge.request(call, Value::Object(args)).await {
            Ok(reply) => reply_result(&reply),
            Err(why) => {
                if let Some(bridge) = ui.take() {
                    bridge.stop().await;
                }
                failure(why)
            }
        }
    }

    /// The harness child's pid, for a test that checks it dies with the server.
    pub async fn ui_pid(&self) -> Option<u32> {
        self.ui.lock().await.as_ref().and_then(UiBridge::pid)
    }

    pub(crate) async fn stop_ui(&self) {
        if let Some(bridge) = self.ui.lock().await.take() {
            bridge.stop().await;
        }
    }
}

#[tool_router(router = ui_router, vis = "pub(crate)")]
impl FundaCad {
    #[tool(
        name = "ui_open",
        description = "Open a private copy of the FundaCAD app in a browser, against its own engine, to use it the way a person does: real clicks, typing and drags. It is never the user's window. Takes about 10 s. A second call says what is open. Then ui_do to act, ui_read to see, ui_shot for a picture, ui_close when done.",
        input_schema = crate::tools::ui_open()
    )]
    pub async fn t_ui_open(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.relay("open", args).await)
    }

    #[tool(
        name = "ui_do",
        description = "Do steps in the open app, as a person would. One line per step done and the status line come back; a failing step stops the rest and is an error. Read refs with ui_read screen first rather than guessing.",
        input_schema = crate::tools::ui_do()
    )]
    pub async fn t_ui_do(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.relay("do", args).await)
    }

    #[tool(
        name = "ui_read",
        description = "What the open app shows, as short text: screen (the visible controls with their refs), history, bodies, status, errors, selection, handles.",
        input_schema = crate::tools::ui_read()
    )]
    pub async fn t_ui_read(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.relay("read", args).await)
    }

    #[tool(
        name = "ui_shot",
        description = "A picture of the open app, or of one control. Costs far more context than ui_read, ask only when the look matters.",
        input_schema = crate::tools::ui_shot()
    )]
    pub async fn t_ui_shot(&self, mut args: JsonObject) -> Result<CallToolResult, McpError> {
        if let Some(px) = args.get("max_px").and_then(Value::as_i64) {
            args.insert("max_px".into(), json!(px.clamp(64, MAX_IMAGE_PX)));
        }
        Ok(self.relay("shot", args).await)
    }

    #[tool(
        name = "ui_close",
        description = "Close the private app, its browser and its engine.",
        input_schema = crate::tools::ui_close()
    )]
    pub async fn t_ui_close(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        if self.ui.lock().await.is_none() {
            return Ok(text("nothing was open."));
        }
        let out = self.relay("close", args).await;
        self.stop_ui().await;
        Ok(out)
    }
}
