//! What the integration suites share: an engine that answers whatever the test
//! wants, and the MCP server driven over its real stdio protocol.
//!
//! The Python suites stubbed `srv.link`, a Python object. Here the seam is a
//! socket, so the stub is a socket too, which costs a few lines and buys the
//! link, the framing and the reply matching being under test as well.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio_tungstenite::tungstenite::Message;

pub fn free_port() -> u16 {
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("a loopback port");
    l.local_addr().expect("bound").port()
}

/// One call the fake engine took: the op, its payload, and what the file the
/// payload named held AT THE TIME. That last part is the only moment it exists
/// for an inline import: by the time the tool returns the temporary file has
/// been deleted, so a test that looked afterwards would find nothing and be
/// unable to tell a correct write from no write at all.
#[derive(Debug, Clone)]
pub struct Call {
    pub op: String,
    pub payload: Map<String, Value>,
    pub saw: Option<Vec<u8>>,
}

#[derive(Clone)]
pub struct FakeEngine {
    pub port: u16,
    pub token: String,
    pub calls: Arc<Mutex<Vec<Call>>>,
}

impl FakeEngine {
    /// Serve `answer` on a free loopback port. The handler gets the op and the
    /// payload and returns the reply body; `id` is filled in here.
    pub fn start(
        answer: impl Fn(&str, &Map<String, Value>) -> Value + Send + Sync + 'static,
    ) -> FakeEngine {
        let port = free_port();
        let engine = FakeEngine {
            port,
            token: "test-token".into(),
            calls: Arc::new(Mutex::new(Vec::new())),
        };
        let answer = Arc::new(answer);
        let calls = engine.calls.clone();
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .expect("the port was free a moment ago");
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let answer = answer.clone();
                let calls = calls.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    while let Some(Ok(msg)) = ws.next().await {
                        let Message::Text(text) = msg else { continue };
                        let Ok(Value::Object(req)) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        let op = req
                            .get("op")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let saw = req
                            .get("path")
                            .and_then(Value::as_str)
                            .map(|p| std::fs::read(p).ok())
                            .unwrap_or(None);
                        calls.lock().expect("no panics here").push(Call {
                            op: op.clone(),
                            payload: req.clone(),
                            saw,
                        });
                        let mut reply = answer(&op, &req)
                            .as_object()
                            .cloned()
                            .unwrap_or_default();
                        reply.insert(
                            "id".into(),
                            req.get("id").cloned().unwrap_or(Value::Null),
                        );
                        if ws
                            .send(Message::Text(Value::Object(reply).to_string().into()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                });
            }
        });
        engine
    }

    /// An engine that answers every op with the same reply, which is what most
    /// of the import cases need.
    pub fn always(reply: Value) -> FakeEngine {
        FakeEngine::start(move |_op, _req| reply.clone())
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("no panics here").clone()
    }

    pub fn ops(&self) -> Vec<String> {
        self.calls().into_iter().map(|c| c.op).collect()
    }

    pub fn link(&self) -> fundacad_mcp::link::EngineLink {
        fundacad_mcp::link::EngineLink::attach(self.port, self.token.clone())
    }
}

/// What the real importer returns for a plain part: no colour, no assembly tree.
pub fn part_reply() -> Value {
    json!({"ok": true, "result": {"geom": "abc123", "solid": true, "faces": 15,
                                  "name": "bracket"}})
}

pub fn text_of(result: &rmcp::model::CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|c| match c {
            rmcp::model::ContentBlock::Text(t) => Some(t.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

pub fn is_error(result: &rmcp::model::CallToolResult) -> bool {
    result.is_error.unwrap_or(false)
}

// --- the server as a process -------------------------------------------------

/// The built `fundacad-mcp` binary, beside the test binary.
pub fn mcp_binary() -> PathBuf {
    let exe = std::env::current_exe().expect("a test binary has a path");
    let profile = exe
        .parent()
        .and_then(Path::parent)
        .expect("target/<profile>/deps");
    profile.join(if cfg!(windows) {
        "fundacad-mcp.exe"
    } else {
        "fundacad-mcp"
    })
}

pub fn engine_binary() -> PathBuf {
    let exe = std::env::current_exe().expect("a test binary has a path");
    let profile = exe
        .parent()
        .and_then(Path::parent)
        .expect("target/<profile>/deps");
    profile.join(if cfg!(windows) {
        "fundacad-engine.exe"
    } else {
        "fundacad-engine"
    })
}

/// A session file nothing can find, so a test on a machine with FundaCAD open
/// never attaches to it.
///
/// NO TEST MAY FIND THE RUNNING APP. Discovery reads a session file the app
/// publishes in its app data directory, so a server built by a test on such a
/// machine attaches to it, and every tool that changes the document then PUSHES
/// that change into the document on the user's screen. Running the Python suite
/// once with the app open put six features into it, one undo step each: the
/// tests passed their own assertions against the app's document rather than
/// their own, and the damage was in another process.
pub fn no_app() -> PathBuf {
    std::env::temp_dir().join("fundacad-no-app-in-tests.json")
}

/// `fundacad-mcp` over its real stdio protocol, not its methods.
pub struct Mcp {
    child: Child,
    reader: BufReader<std::process::ChildStdout>,
    next_id: i64,
    pub stderr: PathBuf,
}

impl Mcp {
    pub fn start(env: &BTreeMap<String, String>, cwd: &Path) -> Mcp {
        let stderr_path =
            std::env::temp_dir().join(format!("fundacad-mcp-test-{}.log", std::process::id()));
        let log = std::fs::File::create(&stderr_path).expect("a log file");
        let mut cmd = Command::new(mcp_binary());
        cmd.current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log));
        cmd.env("FUNDACAD_SESSION_FILE", no_app());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("the MCP binary is built");
        let stdout = child.stdout.take().expect("piped");
        let mut mcp = Mcp {
            child,
            reader: BufReader::new(stdout),
            next_id: 0,
            stderr: stderr_path,
        };
        mcp.rpc(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "test", "version": "1"}}),
        );
        mcp.notify("notifications/initialized");
        mcp
    }

    fn send(&mut self, line: &str) {
        let stdin = self.child.stdin.as_mut().expect("piped");
        writeln!(stdin, "{line}").expect("the server is alive");
        stdin.flush().expect("the server is alive");
    }

    pub fn notify(&mut self, method: &str) {
        self.send(&json!({"jsonrpc": "2.0", "method": method}).to_string());
    }

    pub fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
        );
        loop {
            let mut line = String::new();
            let read = self.reader.read_line(&mut line).expect("the server is alive");
            assert!(read > 0, "the server closed its stdout");
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if msg.get("id").and_then(Value::as_i64) == Some(id) {
                return msg;
            }
        }
    }

    /// One tool call, as {text, images, isError}.
    pub fn call(&mut self, name: &str, args: Value) -> ToolReply {
        let msg = self.rpc(
            "tools/call",
            json!({"name": name, "arguments": args}),
        );
        let result = msg.get("result").cloned().unwrap_or_else(|| json!({}));
        let mut text = String::new();
        let mut images: Vec<Vec<u8>> = Vec::new();
        for c in result
            .get("content")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            match c.get("type").and_then(Value::as_str) {
                Some("text") => text.push_str(c.get("text").and_then(Value::as_str).unwrap_or("")),
                Some("image") => {
                    use base64::Engine as _;
                    let data = c.get("data").and_then(Value::as_str).unwrap_or("");
                    images.push(
                        base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap_or_default(),
                    );
                }
                _ => {}
            }
        }
        ToolReply {
            text,
            images,
            is_error: result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            error: msg.get("error").cloned(),
        }
    }

    pub fn tools(&mut self) -> Vec<Value> {
        self.rpc("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    pub fn log(&self) -> String {
        std::fs::read_to_string(&self.stderr).unwrap_or_default()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.stderr);
    }
}

#[derive(Debug, Clone)]
pub struct ToolReply {
    pub text: String,
    pub images: Vec<Vec<u8>>,
    pub is_error: bool,
    pub error: Option<Value>,
}

pub fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}
