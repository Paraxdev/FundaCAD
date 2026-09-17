//! FundaCAD over MCP: the tools another model uses to build, measure and look
//! at a part. A port of `plugins/FundaCAD.MCP/server.py`.
//!
//! The protocol is the official Rust MCP SDK over stdio. STDOUT IS THE
//! PROTOCOL, as it was: nothing else may ever be written there, and everything
//! diagnostic goes to stderr, which the host shows in its logs.
//!
//! What the tools are for, in the order they are meant to be used:
//!
//!   schema        what a feature looks like, read this before authoring one
//!   param_set     the driving dimensions, named, so the model stays parametric
//!   feature_*     the timeline
//!   build         make it, and say what broke
//!   inspect       exact measurements, and the SELECTORS that address each face
//!                 and edge, which is what makes the next feature writable
//!   view          a picture, because "is the hole in the right place" is not a
//!                 question numbers answer
//!   doc_save      a .funda file the app opens
//!
//! There are two worlds, and `link::for_mode` picks between them at start-up.
//! PRIVATE holds the document in this process and spawns its own engine; LIVE
//! works on the document a running FundaCAD has open, reading it before every
//! tool and offering the result back afterwards. Which one is in force is
//! `State::live`, and nothing in the tools themselves knows: `call_live` wraps
//! them, so a tool is written once and works either way. That is deliberate, a
//! tool that had to remember which world it was in would eventually forget, and
//! forgetting means editing the wrong document.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListResourcesResult, PaginatedRequestParams, ReadResourceRequestParams,
    ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ServerCapabilities,
    ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{tool, tool_router, ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::describe;
use crate::docfile;
use crate::link::{args as call_args, EngineLink, Mode};
use crate::live::{LiveError, LiveLink};
use crate::model::{self, Doc};
use crate::render::{self, ViewRequest};
use crate::schema;
use crate::upload::{self, Upload, ASK_FOR_A_PATH, IMPORT_FORMATS, PIECES_WORTH_IT};

/// Renders are returned inline as base64 PNG, so the size is a context cost
/// rather than a disk one. 640x480 is legible and about 25 kB of PNG on a
/// typical part; the cap stops a caller asking for something no context can hold.
pub const MAX_IMAGE_PX: i64 = 1600;

/// Tools that change the document. Anything here is offered to the app when a
/// live session is on; anything not here only reads, and a reader that proposed
/// would put a no-op edit and an undo step in front of the user every time an
/// agent measured something.
pub const MUTATORS: &[&str] = &[
    "doc_new",
    "doc_open",
    "doc_import",
    "doc_set",
    "param_set",
    "param_remove",
    "feature_add",
    "feature_update",
    "feature_remove",
    "feature_move",
];

/// Tools that need no document at all, so they must not be made to wait for
/// one. `schema` in particular is what an agent reads BEFORE anything exists.
pub const NO_DOCUMENT: &[&str] = &["schema"];

/// Prepended to the working-order instructions when this server is driving the
/// document a person has open. It is the one thing about this mode a model has
/// to know, because it changes what a mistake costs: there is no private copy
/// to throw away, and the person is watching.
pub const LIVE_INSTRUCTIONS: &str = "YOU ARE WORKING ON A DOCUMENT SOMEONE HAS OPEN IN FUNDACAD, right now, on their
screen. Every edit you make appears in their window as it happens.

  * Read before you write. Each tool re-reads their document first, so what you
    saw a moment ago may already have changed.
  * An edit is refused if they changed the model while you were writing it. That
    is not an error to retry blindly: read it again and decide again.
  * `doc_new` and `doc_open` REPLACE what they have open. Do not call either
    unless you were asked to.
  * `doc_save` writes their document to a file. It is not how your work reaches
    them; it is already there.

";

/// How long to leave between re-probes for a running app. The probe is a file
/// read, and only dials a port when that file exists, so the usual cost is
/// nothing at all. The interval is for the stale-file case, where the dial
/// waits out its timeout and would otherwise do so on every single tool call.
pub const REPROBE: Duration = Duration::from_secs(3);

pub fn log(line: &str) {
    eprintln!("{line}");
}

pub fn text(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(s)])
}

pub fn failure(s: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(s)])
}

/// Add a line to a tool result without rebuilding its shape.
fn append(result: CallToolResult, extra: &str) -> CallToolResult {
    let mut out = result;
    match out.content.last_mut() {
        Some(ContentBlock::Text(t)) => t.text.push_str(extra),
        _ => out.content.push(ContentBlock::text(extra.trim())),
    }
    out
}

fn is_error(result: &CallToolResult) -> bool {
    result.is_error.unwrap_or(false)
}

/// What the user sees beside the indicator that an assistant is editing: the
/// tool name plus the one argument that identifies what it touched, enough to
/// recognise an edit in a list and short enough for a line of UI.
fn edit_note(name: &str, args: &JsonObject) -> String {
    let subject = args
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| args.get("name").and_then(Value::as_str))
        .or_else(|| {
            args.get("feature")
                .and_then(|f| f.get("type"))
                .and_then(Value::as_str)
        });
    match subject {
        Some(s) => format!("{name}: {s}"),
        None => name.to_string(),
    }
}

/// What the last build was of. Cheap and exact: if this string is unchanged,
/// the cached mesh is still the answer.
fn signature(doc: &Doc) -> String {
    let mut m = Map::new();
    m.insert("f".into(), doc.get("features").cloned().unwrap_or(Value::Null));
    m.insert(
        "p".into(),
        doc.get("parameters").cloned().unwrap_or(Value::Null),
    );
    canonical(&Value::Object(m))
}

/// JSON with every object's keys sorted, which is what `sort_keys=True` buys:
/// two documents that differ only in key order are the same document.
fn canonical(v: &Value) -> String {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", Value::String((*k).clone()), canonical(&o[*k])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}

/// Python's `f"{x}"` for a JSON number: an integer prints bare, a float always
/// carries its point, which is what the build line's "20.0 x 20.0 x 30.0" is.
fn py_num(v: Option<&Value>) -> String {
    match v {
        Some(Value::Number(n)) if n.is_f64() => {
            let f = n.as_f64().unwrap_or(0.0);
            let text = format!("{f}");
            if text.contains(['.', 'e', 'E']) || !f.is_finite() {
                text
            } else {
                format!("{text}.0")
            }
        }
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => "None".into(),
        Some(other) => other.to_string(),
    }
}

fn abspath(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        normalise(p)
    } else {
        normalise(
            &std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(p),
        )
    }
}

/// `.` and `..` folded out, as `os.path.abspath` does, without touching the
/// filesystem: the path may not exist yet, which is the whole point of
/// `doc_save`.
fn normalise(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in p.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

struct State {
    doc: Doc,
    path: Option<PathBuf>,
    link: Arc<EngineLink>,
    /// Set when this server is working on the document a running app has open.
    /// None means the document here is private, which is what every tool
    /// assumed before there was another option.
    live: Option<LiveLink>,
    /// True once a tool has changed the PRIVATE document. It is what stops the
    /// re-probe from pulling the rug out from under work already done here.
    private_edits: bool,
    /// Uploads still arriving, by id. Empty except between the first piece of a
    /// file and its last.
    uploads: HashMap<String, Upload>,
    /// When the last re-probe ran, so a closed app costs one file stat per tool
    /// rather than one connect timeout.
    probed_at: Option<Instant>,
    /// The last successful build's per-body mesh, which is what `view` draws.
    /// Kept rather than re-requested: a render right after a build is the
    /// common case and the mesh is the expensive part of the reply.
    mesh: Vec<Value>,
    /// The document signature `mesh` belongs to.
    built_for: Option<String>,
}

impl State {
    fn invalidate(&mut self) {
        self.mesh.clear();
        self.built_for = None;
    }

    fn state_line(&mut self, head: &str) -> String {
        let ids: Vec<String> = model::features(&self.doc)
            .iter()
            .map(|f| {
                format!(
                    "{}:{}",
                    f.get("id").and_then(Value::as_str).unwrap_or("None"),
                    f.get("type").and_then(Value::as_str).unwrap_or("None")
                )
            })
            .collect();
        let problems = model::validate(&mut self.doc);
        let mut out = format!(
            "{head}\ntimeline: {}",
            if ids.is_empty() {
                "(empty)".to_string()
            } else {
                ids.join(" -> ")
            }
        );
        if !problems.is_empty() {
            out.push_str("\nproblems (these WILL fail a build):\n  ");
            out.push_str(&problems.join("\n  "));
        }
        out
    }

    fn drop_upload(&mut self, id: &str) {
        if let Some(up) = self.uploads.remove(id) {
            up.drop_files();
        }
    }
}

/// The MCP server: one document, one engine, and the tools between them.
#[derive(Clone)]
pub struct FundaCad {
    state: Arc<Mutex<State>>,
    /// Built once. `tool_router()` constructs the whole table every call, and
    /// `call_tool` consults it three times.
    router: Arc<rmcp::handler::server::router::tool::ToolRouter<FundaCad>>,
    /// One tool at a time. MCP allows concurrency, but every tool here ends in
    /// the engine, which serialises heavy work anyway, and an agent asking one
    /// question at a time is the entire traffic pattern. It also makes the live
    /// pull, the tool and the push one atomic edit.
    turn: Arc<Mutex<()>>,
}

impl FundaCad {
    /// A server with a link and no discovery, which is what a test wants.
    pub fn with_link(link: EngineLink) -> FundaCad {
        FundaCad {
            state: Arc::new(Mutex::new(State {
                doc: model::new_document(),
                path: None,
                link: Arc::new(link),
                live: None,
                private_edits: false,
                uploads: HashMap::new(),
                probed_at: None,
                mesh: Vec::new(),
                built_for: None,
            })),
            turn: Arc::new(Mutex::new(())),
            router: Arc::new(Self::tool_router()),
        }
    }

    /// Decide where the engine comes from, once, at start-up. Split out of the
    /// constructor because it does IO, it reads the session file and dials the
    /// port.
    pub async fn attach(mode: Mode) -> Result<FundaCad, String> {
        let (link, app) = EngineLink::for_mode(mode, log).await?;
        let server = FundaCad::with_link(link);
        if app.is_some() {
            let mut st = server.state.lock().await;
            let mut live = LiveLink::new();
            match live.pull(&st.link).await {
                Ok(_) => {
                    log(&format!(
                        "[mcp] sharing the open document: {}",
                        live.title.clone().unwrap_or_else(|| "untitled".into())
                    ));
                }
                Err(e) => {
                    // The engine is the app's but the WINDOW is not sharing.
                    // That is the live-editing setting being off, and it is a
                    // state to stay in rather than fail on: the agent still
                    // gets the app's engine, and every tool that needs the
                    // document says why it cannot have it.
                    log(&format!(
                        "[mcp] attached to the engine, but not to a document: {e}"
                    ));
                }
            }
            st.live = Some(live);
        }
        Ok(server)
    }

    /// The document as it stands, for a test that drives the tools directly.
    pub async fn document(&self) -> Doc {
        self.state.lock().await.doc.clone()
    }

    /// Whether this server is working on a document a running app has open.
    pub async fn is_live(&self) -> bool {
        self.state.lock().await.live.is_some()
    }

    /// The engine this server is talking to, by port.
    pub async fn engine_port(&self) -> u16 {
        self.state.lock().await.link.port
    }

    /// Whether a tool has changed the PRIVATE document. It is what stops the
    /// re-probe pulling the rug out from under work already done here, and it
    /// is settable so a test can reach that branch without building anything.
    pub async fn private_edits(&self) -> bool {
        self.state.lock().await.private_edits
    }

    pub async fn set_private_edits(&self, edited: bool) {
        self.state.lock().await.private_edits = edited;
    }

    /// Move the last re-probe back, so a test can reach the next one without
    /// waiting out the interval.
    pub async fn age_probe(&self, by: Duration) {
        let mut st = self.state.lock().await;
        st.probed_at = st.probed_at.and_then(|at| at.checked_sub(by));
    }

    /// Ask again whether FundaCAD is open, which is what every tool call does
    /// before it runs.
    pub async fn probe_for_the_app(&self) {
        self.adopt_running_app().await;
    }

    /// The uploads still arriving, as (id, spool directory).
    pub async fn uploads(&self) -> Vec<(String, PathBuf)> {
        self.state
            .lock()
            .await
            .uploads
            .iter()
            .map(|(k, u)| (k.clone(), u.dir.clone()))
            .collect()
    }

    /// Move every open upload's last-touched time back, so a test can reach the
    /// sweep without waiting half an hour for it.
    pub async fn age_uploads(&self, by: Duration) {
        for up in self.state.lock().await.uploads.values_mut() {
            up.touched -= by;
        }
    }

    /// Every tool this server offers, as the host sees them.
    pub fn tools(&self) -> Vec<rmcp::model::Tool> {
        self.router.list_all()
    }

    pub async fn instructions(&self) -> String {
        // Live mode adds a paragraph rather than replacing the working order,
        // which is just as true either way.
        if self.state.lock().await.live.is_none() {
            schema::how_to().to_string()
        } else {
            format!("{LIVE_INSTRUCTIONS}{}", schema::how_to())
        }
    }

    /// Attach to the app if it has appeared since start-up.
    ///
    /// `attach` runs once, at start-up, which is the wrong moment and the only
    /// one available to it: an MCP host starts its servers when the HOST
    /// starts, not when a conversation starts, so "is FundaCAD open?" gets
    /// asked before the user had any reason to have opened it. Answering no
    /// then meant a private engine for the rest of the host's session, which
    /// reads exactly as the server refusing to use the app that is right there.
    ///
    /// So the question is asked again, while the answer can still change: only
    /// while private, only when nothing has been built here that adopting would
    /// discard, and no more often than REPROBE.
    async fn adopt_running_app(&self) {
        {
            let st = self.state.lock().await;
            if st.live.is_some() || st.private_edits {
                return;
            }
        }
        if crate::link::mode_from_env() == Mode::Standalone {
            return; // configured to stay private, so do not go looking
        }
        {
            let mut st = self.state.lock().await;
            if st.probed_at.is_some_and(|at| at.elapsed() < REPROBE) {
                return;
            }
            st.probed_at = Some(Instant::now());
        }

        let Some(app) =
            crate::app_session::find_running_app(None, crate::app_session::PROBE_TIMEOUT).await
        else {
            return;
        };
        let link = Arc::new(EngineLink::attach(app.port, app.token.clone()));
        let mut live = LiveLink::new();
        let doc = match live.pull(&link).await {
            Ok(doc) => doc,
            Err(e) => {
                // Found the engine, but the window is not sharing, or it went
                // away between the probe and the pull. Staying private is the
                // honest outcome; saying why is what stops it looking like the
                // connector is broken.
                log(&format!(
                    "[mcp] FundaCAD is open but not sharing a document: {e}"
                ));
                return;
            }
        };
        log(&format!(
            "[mcp] FundaCAD opened since start-up (pid {}), switching to its engine on port {} \
             and its open document: {}",
            app.pid.map_or("?".into(), |p| p.to_string()),
            app.port,
            live.title.clone().unwrap_or_else(|| "untitled".into())
        ));
        let old = {
            let mut st = self.state.lock().await;
            let old = std::mem::replace(&mut st.link, link);
            st.live = Some(live);
            st.doc = doc.unwrap_or_else(model::new_document);
            model::fill_defaults(&mut st.doc);
            st.invalidate();
            old
        };
        // The private engine held a worker that nothing will ask for again.
        // Dropped after the swap, never before: a failure above has to leave a
        // working private session behind, not neither.
        old.stop().await;
    }

    /// The app's engine went away under a live session: the window closed, or
    /// the engine was restarted with a new token. Nothing reconnects a live
    /// link, so without this every later call fails the same way until the host
    /// restarts this server. Fall back to a private engine, keeping the last
    /// document pulled, and let the re-probe find the app again.
    async fn drop_lost_app(&self, why: &str) {
        log(&format!(
            "[mcp] lost FundaCAD's engine ({why}), working on a private copy until it is back"
        ));
        let lost = {
            let mut st = self.state.lock().await;
            let lost = std::mem::replace(&mut st.link, Arc::new(EngineLink::private()));
            st.live = None;
            st.probed_at = None;
            st.invalidate();
            lost
        };
        lost.stop().await;
    }

    async fn engine_link(&self) -> Arc<EngineLink> {
        self.state.lock().await.link.clone()
    }

    /// One tool, against the document a running app has open.
    ///
    /// Mirror in, mirror out. The pull before makes the local document the
    /// app's, so the tool sees what the user sees rather than whatever this
    /// process last built; the push after offers the result, and does not
    /// return until the app has taken it. The tools themselves know none of
    /// this.
    ///
    /// A tool that fails leaves nothing to offer, which is why the push is
    /// after the error check: proposing a half-applied document would put the
    /// failure in front of the user as an edit.
    async fn call_live(
        &self,
        name: &str,
        args: &JsonObject,
        run: impl std::future::Future<Output = Result<CallToolResponse, McpError>>,
    ) -> Result<Result<CallToolResponse, McpError>, LiveError> {
        let link = self.engine_link().await;
        let before = {
            let mut st = self.state.lock().await;
            let Some(live) = st.live.as_mut() else {
                return Err(LiveError::NoAppOpen("no live session".into()));
            };
            // A window that is not sharing is a SETTING, not a lost engine:
            // the answer the user can act on is "turn live editing on", and
            // falling back to a private copy would hide it. Only the transport
            // going away is worth reconnecting over.
            let pulled = match live.pull(&link).await {
                Ok(pulled) => pulled,
                Err(e) if e.is_lost() => return Err(e),
                Err(e) => return Ok(Ok(CallToolResponse::Complete(failure(e.message())))),
            };
            st.doc = pulled.unwrap_or_else(model::new_document);
            model::fill_defaults(&mut st.doc);
            // No invalidate here, deliberately. `view` already asks whether the
            // cached mesh belongs to the document in hand, and that check
            // answers "the user changed it under us" as well as it answers "we
            // changed it". Dropping the mesh on every pull would make the
            // ordinary build then view pair rebuild twice, which in live mode
            // is every single render.
            st.doc.clone()
        };

        let out = run.await;
        let Ok(CallToolResponse::Complete(result)) = out else {
            return Ok(out);
        };
        if !MUTATORS.contains(&name) || is_error(&result) {
            return Ok(Ok(CallToolResponse::Complete(result)));
        }
        let (changed, document) = {
            let st = self.state.lock().await;
            (st.doc != before, st.doc.clone())
        };
        if !changed {
            return Ok(Ok(CallToolResponse::Complete(result))); // nothing to offer
        }
        let pushed = {
            let mut st = self.state.lock().await;
            let live = st.live.as_mut().expect("live checked above");
            live.push(&link, &document, &edit_note(name, args)).await
        };
        match pushed {
            Ok(rev) => Ok(Ok(CallToolResponse::Complete(append(
                result,
                &format!("\n(applied in FundaCAD, revision {rev})"),
            )))),
            Err(e) if e.is_lost() => Err(e),
            Err(e) => {
                // The local document now holds an edit the app never took. Put
                // it back, or the next tool would build on a change that does
                // not exist anywhere else and the agent would have no way to
                // notice. The mesh cache needs no help: it is keyed on the
                // document's signature, which this restores with it.
                let mut st = self.state.lock().await;
                st.doc = before;
                Ok(Ok(CallToolResponse::Complete(failure(e.message()))))
            }
        }
    }
}

/// Python's `bool(x)` for a JSON value, which is what `doc_import` branched on.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        Some(Value::Bool(true)) => true,
    }
}

fn require<'a>(args: &'a JsonObject, key: &str) -> Result<&'a Value, CallToolResult> {
    args.get(key)
        .filter(|v| !v.is_null())
        .ok_or_else(|| failure(format!("KeyError: '{key}'")))
}

fn require_str(args: &JsonObject, key: &str) -> Result<String, CallToolResult> {
    match require(args, key)? {
        Value::String(s) => Ok(s.clone()),
        other => Ok(other.to_string()),
    }
}

fn doc_error(e: model::DocumentError) -> CallToolResult {
    failure(format!("DocumentError: {e}"))
}

fn engine_gone(e: &std::io::Error) -> CallToolResult {
    failure(format!("the geometry engine could not be reached: {e}"))
}

#[tool_router]
impl FundaCad {
    #[tool(
        name = "schema",
        description = "The document schema: every feature type, its fields, an example and the traps. Call it with no argument for the overview and the working order, or with a type name for that type's detail. READ THIS FIRST.",
        input_schema = crate::tools::schema_tool()
    )]
    pub async fn t_schema(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(text(schema::schema_text(
            args.get("type").and_then(Value::as_str),
        )))
    }

    #[tool(
        name = "doc_new",
        description = "Start an empty document, discarding the current one.",
        input_schema = crate::tools::doc_new()
    )]
    pub async fn t_doc_new(&self, _args: JsonObject) -> Result<CallToolResult, McpError> {
        let mut st = self.state.lock().await;
        st.doc = model::new_document();
        st.path = None;
        st.invalidate();
        Ok(text("New empty document."))
    }

    #[tool(
        name = "doc_open",
        description = "Load a .funda document from disk.",
        input_schema = crate::tools::doc_open()
    )]
    pub async fn t_doc_open(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        // Absolute from here down. A relative path resolves against the
        // SERVER's working directory, which an MCP host chooses and which is
        // rarely the one the caller has in mind, so echoing back what was typed
        // says nothing about where the file actually is. Say where it is.
        let path = match require_str(&args, "path") {
            Ok(p) => abspath(&p),
            Err(e) => return Ok(e),
        };
        let (doc, _blobs) = match docfile::read(&path, None) {
            Ok(v) => v,
            Err(e) => return Ok(failure(e.to_string())),
        };
        let mut st = self.state.lock().await;
        st.doc = doc;
        model::fill_defaults(&mut st.doc);
        st.path = Some(path.clone());
        st.invalidate();
        let issues = model::recompute_parameters(&mut st.doc);
        let note = if issues.is_empty() {
            String::new()
        } else {
            format!(
                "\nparameter problems: {}",
                issues
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        };
        Ok(text(format!(
            "Opened {}: {} features, {} parameters.{note}",
            path.display(),
            model::features(&st.doc).len(),
            model::param_defs(&st.doc).len()
        )))
    }

    #[tool(
        name = "doc_import",
        description = "Read an external geometry file (STEP, STL, 3MF, OBJ, BREP, GLB) into the timeline as a body, so it can be measured with `inspect` and modelled against. Use it when asked to fit something to a part that exists as a file.\n\
`path` is a file the machine FundaCAD runs on can open, and is how anything of real size gets in. `content` is the file itself, for when you have no path to give: gzip it (`compression`, and a STEP shrinks about tenfold), and split it with `part` and `parts` if one message will not hold it.\n\
But content is written by YOU, so the limit that binds is your own output and not this server's: roughly one message per piece, and a file needing more than a handful of pieces is one to ask for a path to instead. If you cannot reach the file from where you are, ask the person you are working with for its path on the machine FundaCAD runs on, or ask them to open it in FundaCAD themselves (File, Import Mesh), which puts it in the document for `inspect` to measure. Do not substitute a simplified stand-in for the real part: fitting to an approximation is the failure this tool exists to prevent.\n\
The format comes from the extension unless given. A large STEP can take minutes: it is one read, so do it once and keep the document.",
        input_schema = crate::tools::doc_import()
    )]
    pub async fn t_doc_import(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.doc_import(&args).await)
    }

    #[tool(
        name = "doc_save",
        description = "Write the document to a .funda file, which the FundaCAD app opens directly. Saves to the path it was opened from if none is given.",
        input_schema = crate::tools::doc_save()
    )]
    pub async fn t_doc_save(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let mut st = self.state.lock().await;
        let given = args.get("path").and_then(Value::as_str).map(str::to_string);
        let Some(path) = given.map(|p| abspath(&p)).or_else(|| st.path.clone()) else {
            return Ok(failure(
                "No path given and this document has never been saved.",
            ));
        };
        model::recompute_parameters(&mut st.doc);
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Ok(failure(format!("No such directory: {}", parent.display())));
            }
        }
        let embedded = match docfile::write(&path, &st.doc, None) {
            Ok(n) => n,
            Err(e) => return Ok(failure(e.to_string())),
        };
        st.path = Some(path.clone());
        let geometry = if embedded > 0 {
            format!(", with {embedded} imported bodies' geometry")
        } else {
            String::new()
        };
        Ok(text(format!(
            "Saved {} features to {}{geometry}.",
            model::features(&st.doc).len(),
            path.display()
        )))
    }

    #[tool(
        name = "doc_get",
        description = "The whole document as JSON: parameters and the feature timeline in order.",
        input_schema = crate::tools::doc_get()
    )]
    pub async fn t_doc_get(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let st = self.state.lock().await;
        let mut out = Map::new();
        out.insert(
            "features".into(),
            st.doc.get("features").cloned().unwrap_or_else(|| json!([])),
        );
        if !args
            .get("features_only")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            out.insert(
                "parameters".into(),
                st.doc.get("parameters").cloned().unwrap_or_else(|| json!({})),
            );
            out.insert(
                "paramDefs".into(),
                st.doc.get("paramDefs").cloned().unwrap_or_else(|| json!({})),
            );
        }
        Ok(text(pretty(&Value::Object(out), 1)))
    }

    #[tool(
        name = "doc_set",
        description = "Replace the whole document with the given JSON. For wholesale rewrites; prefer the feature_* tools for edits.",
        input_schema = crate::tools::doc_set()
    )]
    pub async fn t_doc_set(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let doc = match require(&args, "document") {
            Ok(d) => d,
            Err(e) => return Ok(e),
        };
        let ok = doc
            .as_object()
            .is_some_and(|o| o.get("features").is_some_and(Value::is_array));
        if !ok {
            return Ok(failure("`document` needs a `features` list."));
        }
        let mut st = self.state.lock().await;
        st.doc = doc.as_object().cloned().unwrap_or_default();
        model::fill_defaults(&mut st.doc);
        st.doc
            .entry("version")
            .or_insert_with(|| json!(model::FORMAT_VERSION));
        st.invalidate();
        model::recompute_parameters(&mut st.doc);
        Ok(text(st.state_line("Replaced the document.")))
    }

    #[tool(
        name = "param_set",
        description = "Define or redefine a parameter. `expr` may be a number or an expression over other parameters (\"hub_d/2 - wall\"). Features reference it by NAME, which is what keeps the model parametric. Function arguments are separated by SEMICOLONS and trig is in degrees. Comparisons (< <= > >= == !=), && || ! yield 1 or 0, and if(cond; a; b) picks a branch: \"if(solid == 1; 0; innerX)\". Refused, changing nothing, if the expression does not resolve.",
        input_schema = crate::tools::param_set()
    )]
    pub async fn t_param_set(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let name = match require_str(&args, "name") {
            Ok(n) => n,
            Err(e) => return Ok(e),
        };
        let expr = match require(&args, "expr") {
            Ok(e) => e.clone(),
            Err(e) => return Ok(e),
        };
        let unit = args.get("unit").and_then(Value::as_str).unwrap_or("mm");
        let comment = args.get("comment").and_then(Value::as_str);
        let mut st = self.state.lock().await;
        let d = match model::set_parameter(&mut st.doc, &name, &expr, unit, comment) {
            Ok(d) => d,
            Err(e) => return Ok(doc_error(e)),
        };
        st.invalidate();
        // Just this parameter. Printing the whole table on every call turned a
        // twenty-parameter model into twenty pages of the same numbers; anything
        // that wants the table can ask doc_get for it.
        let count = st
            .doc
            .get("parameters")
            .and_then(Value::as_object)
            .map_or(0, Map::len);
        Ok(text(format!(
            "{name} = {} -> {} {} ({count} parameters defined)",
            d.get("expr").and_then(Value::as_str).unwrap_or_default(),
            describe::g_format(d.get("value").and_then(Value::as_f64).unwrap_or(0.0)),
            d.get("unit").and_then(Value::as_str).unwrap_or("mm")
        )))
    }

    #[tool(
        name = "param_remove",
        description = "Delete a parameter. Refused if anything still uses it.",
        input_schema = crate::tools::param_remove()
    )]
    pub async fn t_param_remove(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let name = match require_str(&args, "name") {
            Ok(n) => n,
            Err(e) => return Ok(e),
        };
        let mut st = self.state.lock().await;
        if let Err(e) = model::remove_parameter(&mut st.doc, &name) {
            return Ok(doc_error(e));
        }
        st.invalidate();
        let table = st.doc.get("parameters").cloned().unwrap_or_else(|| json!({}));
        Ok(text(format!("Removed {name}. Now: {table}")))
    }

    #[tool(
        name = "feature_add",
        description = "Append a feature to the timeline (or insert it at `at`). Returns the id it was given. Call `schema` for the shape of one.",
        input_schema = crate::tools::feature_add()
    )]
    pub async fn t_feature_add(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let feature = match require(&args, "feature") {
            Ok(f) => f.clone(),
            Err(e) => return Ok(e),
        };
        let at = args.get("at").and_then(Value::as_i64);
        let mut st = self.state.lock().await;
        let fid = match model::add_feature(&mut st.doc, &feature, at) {
            Ok(fid) => fid,
            Err(e) => return Ok(doc_error(e)),
        };
        st.invalidate();
        Ok(text(st.state_line(&format!("Added {fid}."))))
    }

    #[tool(
        name = "feature_update",
        description = "Merge `patch` into a feature. A null value in the patch REMOVES that field. Pass replace=true to swap the whole body instead.",
        input_schema = crate::tools::feature_update()
    )]
    pub async fn t_feature_update(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let id = match require_str(&args, "id") {
            Ok(i) => i,
            Err(e) => return Ok(e),
        };
        let patch = match require(&args, "patch") {
            Ok(p) => p.clone(),
            Err(e) => return Ok(e),
        };
        let replace = args.get("replace").and_then(Value::as_bool).unwrap_or(false);
        let mut st = self.state.lock().await;
        let f = match model::update_feature(&mut st.doc, &id, &patch, replace) {
            Ok(f) => f,
            Err(e) => return Ok(doc_error(e)),
        };
        st.invalidate();
        Ok(text(st.state_line(&format!("Updated {id}: {f}"))))
    }

    #[tool(
        name = "feature_remove",
        description = "Delete a feature from the timeline.",
        input_schema = crate::tools::feature_remove()
    )]
    pub async fn t_feature_remove(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let id = match require_str(&args, "id") {
            Ok(i) => i,
            Err(e) => return Ok(e),
        };
        let mut st = self.state.lock().await;
        let f = match model::remove_feature(&mut st.doc, &id) {
            Ok(f) => f,
            Err(e) => return Ok(doc_error(e)),
        };
        st.invalidate();
        let kind = f.get("type").and_then(Value::as_str).unwrap_or("None");
        Ok(text(st.state_line(&format!("Removed {id} ({kind})."))))
    }

    #[tool(
        name = "feature_move",
        description = "Move a feature to another position in the timeline.",
        input_schema = crate::tools::feature_move()
    )]
    pub async fn t_feature_move(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let id = match require_str(&args, "id") {
            Ok(i) => i,
            Err(e) => return Ok(e),
        };
        let to = match require(&args, "to") {
            Ok(t) => t.as_i64().unwrap_or(0),
            Err(e) => return Ok(e),
        };
        let mut st = self.state.lock().await;
        if let Err(e) = model::move_feature(&mut st.doc, &id, to) {
            return Ok(doc_error(e));
        }
        st.invalidate();
        Ok(text(
            st.state_line(&format!("Moved {id} to position {to}.")),
        ))
    }

    #[tool(
        name = "build",
        description = "Rebuild the document and report what came out: the bodies, their sizes, and any feature that failed. Build often, an error names the feature that caused it.",
        input_schema = crate::tools::build()
    )]
    pub async fn t_build(&self, _args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.build().await)
    }

    #[tool(
        name = "inspect",
        description = "Exact measurements of the built bodies: volume, area, bounding box, and, the part that matters, every face and edge with a ready-made SELECTOR you can paste into the next feature. Also flags seam edges and wrapping faces, which are what fillet and press/pull refuse.",
        input_schema = crate::tools::inspect()
    )]
    pub async fn t_inspect(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.inspect(&args).await)
    }

    #[tool(
        name = "view",
        description = "Render the built model as a PNG. Orthographic, flat-shaded, with edges drawn. Use it to check what the numbers cannot tell you. `section` cuts it open, which is the only way to see a bore, a pocket or a thread; `bodies` draws one part of an assembly; `focus` zooms in on a point, which is the only way to see a small feature on a large part.",
        input_schema = crate::tools::view()
    )]
    pub async fn t_view(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.view(&args).await)
    }

    #[tool(
        name = "export",
        description = "Write the model to STEP, STL, 3MF or OBJ.",
        input_schema = crate::tools::export()
    )]
    pub async fn t_export(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let path = match require_str(&args, "path") {
            Ok(p) => abspath(&p),
            Err(e) => return Ok(e),
        };
        let format = match require_str(&args, "format") {
            Ok(f) => f,
            Err(e) => return Ok(e),
        };
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Ok(failure(format!("No such directory: {}", parent.display())));
            }
        }
        let (link, doc) = {
            let st = self.state.lock().await;
            (st.link.clone(), st.doc.clone())
        };
        let reply = match link
            .call(
                "export",
                call_args([
                    ("document", Value::Object(doc)),
                    ("format", json!(format)),
                    ("path", json!(path.to_string_lossy())),
                ]),
            )
            .await
        {
            Ok(r) => r,
            Err(e) => return Ok(engine_gone(&e)),
        };
        if reply.get("ok") != Some(&json!(true)) {
            return Ok(failure(format!("Export failed: {}", error_message(&reply))));
        }
        let size = std::fs::metadata(&path).map_or(0, |m| m.len());
        Ok(text(format!("Wrote {} ({size} bytes).", path.display())))
    }
}

fn error_message(reply: &Value) -> String {
    reply
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string()
}

/// `json.dumps(v, indent=n)`, which is two things serde_json's pretty printer
/// is not: any indent width, and a space after every colon.
fn pretty(v: &Value, indent: usize) -> String {
    let pad = " ".repeat(indent);
    let formatter = serde_json::ser::PrettyFormatter::with_indent(pad.as_bytes());
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    if serde::Serialize::serialize(v, &mut ser).is_err() {
        return v.to_string();
    }
    String::from_utf8(buf).unwrap_or_else(|_| v.to_string())
}

// --- the tools that need more than a few lines --------------------------------

impl FundaCad {
    async fn build(&self) -> CallToolResult {
        let (link, doc) = {
            let mut st = self.state.lock().await;
            let problems = model::validate(&mut st.doc);
            (st.link.clone(), (st.doc.clone(), problems))
        };
        let (document, problems) = doc;
        let reply = match link
            .call(
                "rebuild",
                call_args([
                    ("document", Value::Object(document.clone())),
                    ("revision", json!(1)),
                    ("tolerance", json!(0.1)),
                ]),
            )
            .await
        {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            let where_ = reply
                .get("error")
                .and_then(|e| e.get("feature_id"))
                .and_then(Value::as_str)
                .map(|w| format!(" at {w}"))
                .unwrap_or_default();
            let err = reply
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return failure(format!("Build failed{where_}: {err}"));
        }
        let result = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        let mesh: Vec<Value> = result
            .get("bodies")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        {
            let mut st = self.state.lock().await;
            if let Some(ids) = result.get("bodyIds") {
                st.doc.insert("bodyIds".into(), ids.clone());
            }
            st.mesh = mesh.clone();
            st.built_for = Some(signature(&st.doc));
        }
        // Sizes come from a second call, not from the mesh bbox in this reply.
        // The mesh bbox is over the triangulation plus the shape's own gap
        // tolerance, and after an offset or a thicken that tolerance is large:
        // measured 48.41 x 52.03 x 24.45 on a body whose exact box is 36.57 x
        // 36.57 x 21.45. A number a third too big, on the line an agent reads
        // after every single build, is worth one cache-warm rebuild.
        let mut exact: HashMap<String, Value> = HashMap::new();
        if let Ok(deep) = link
            .call(
                "inspect",
                call_args([
                    ("document", Value::Object(document)),
                    ("detail", json!(false)),
                ]),
            )
            .await
        {
            if deep.get("ok") == Some(&json!(true)) {
                for b in deep
                    .get("result")
                    .and_then(|r| r.get("bodies"))
                    .and_then(Value::as_array)
                    .map_or(&[][..], Vec::as_slice)
                {
                    if let Some(id) = b.get("id").and_then(Value::as_str) {
                        exact.insert(id.to_string(), b.clone());
                    }
                }
            }
        }
        let mut lines: Vec<String> = Vec::new();
        for b in &mesh {
            let id = b.get("id").and_then(Value::as_str).unwrap_or_default();
            let e = exact.get(id).cloned().unwrap_or_else(|| json!({}));
            let size: Vec<Value> = match e.get("bbox").and_then(|bb| bb.get("size")) {
                Some(Value::Array(items)) => items.clone(),
                _ => {
                    let bbox = b.get("bbox").cloned().unwrap_or_else(|| json!({}));
                    let lo = bbox.get("min").and_then(Value::as_array).cloned();
                    let hi = bbox.get("max").and_then(Value::as_array).cloned();
                    match (lo, hi) {
                        (Some(lo), Some(hi)) => lo
                            .iter()
                            .zip(hi.iter())
                            .map(|(a, b)| {
                                json!(round3(
                                    b.as_f64().unwrap_or(0.0) - a.as_f64().unwrap_or(0.0)
                                ))
                            })
                            .collect(),
                        _ => vec![json!(0.0), json!(0.0), json!(0.0)],
                    }
                }
            };
            let vol = match e.get("volume").and_then(Value::as_f64).filter(|v| *v != 0.0) {
                Some(v) => format!(", vol {} mm3", describe::g_format(v)),
                None => String::new(),
            };
            let triangles = b
                .get("indices")
                .and_then(Value::as_array)
                .map_or(0, |i| i.len() / 3);
            lines.push(format!(
                "{id} \"{}\": {} x {} x {} mm{vol}, {} faces, {triangles} triangles",
                b.get("name")
                    .and_then(Value::as_str)
                    .map_or("None".into(), str::to_string),
                py_num(size.first()),
                py_num(size.get(1)),
                py_num(size.get(2)),
                py_num(b.get("faceCount"))
            ));
        }
        // `featureErrors`, NOT `errors`. A feature that fails is recorded as a
        // no-op and the rebuild carries on, so the reply is a successful one
        // carrying the failures beside the geometry that did build. Reading the
        // wrong key made a failed press/pull look like a press/pull that did
        // nothing, which is the single most misleading thing this tool could say.
        for e in result
            .get("featureErrors")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            if let Some(m) = e.get("message").and_then(Value::as_str) {
                lines.push(format!(
                    "FEATURE FAILED ({}): {m}",
                    e.get("feature_id")
                        .and_then(Value::as_str)
                        .unwrap_or("None")
                ));
            }
        }
        for d in result
            .get("diagnostics")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            if let Some(m) = d.get("message").and_then(Value::as_str) {
                lines.push(format!("warning: {m}"));
            }
        }
        if mesh.is_empty() {
            lines.push("No bodies were produced.".into());
        }
        if !problems.is_empty() {
            lines.push(format!("document problems: {}", problems.join("; ")));
        }
        text(lines.join("\n"))
    }

    async fn inspect(&self, args: &JsonObject) -> CallToolResult {
        let (link, doc) = {
            let st = self.state.lock().await;
            (st.link.clone(), st.doc.clone())
        };
        let mut payload = Map::new();
        payload.insert("document".into(), Value::Object(doc));
        payload.insert("detail".into(), json!(true));
        if let Some(body) = args.get("body").and_then(Value::as_str) {
            payload.insert("bodies".into(), json!([body]));
        }
        let reply = match link.call("inspect", Value::Object(payload)).await {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            return failure(format!("Inspect failed: {}", error_message(&reply)));
        }
        let mut report = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        let want_faces = index_set(args.get("faces"));
        let want_edges = index_set(args.get("edges"));
        if want_faces.is_some() || want_edges.is_some() {
            if let Some(bodies) = report.get_mut("bodies").and_then(Value::as_array_mut) {
                for b in bodies {
                    if let Some(want) = &want_faces {
                        keep_indices(b, "faces", want);
                    }
                    if let Some(want) = &want_edges {
                        keep_indices(b, "edges", want);
                    }
                }
            }
        }
        let detail = args.get("detail").and_then(Value::as_bool).unwrap_or(false)
            || want_faces.is_some()
            || want_edges.is_some();
        let mut out = describe::describe(&report, detail);
        if args
            .get("selectors")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let mut sel = Map::new();
            for b in report
                .get("bodies")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
            {
                let mut faces = Map::new();
                for f in b.get("faces").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
                    faces.insert(
                        format!("F{}", f.get("i").and_then(Value::as_i64).unwrap_or(0)),
                        f.get("selector").cloned().unwrap_or(Value::Null),
                    );
                }
                let mut edges = Map::new();
                for e in b.get("edges").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
                    edges.insert(
                        format!("E{}", e.get("i").and_then(Value::as_i64).unwrap_or(0)),
                        e.get("selector").cloned().unwrap_or(Value::Null),
                    );
                }
                sel.insert(
                    b.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    json!({"faces": faces, "edges": edges}),
                );
            }
            out.push_str("\n\nselectors:\n");
            out.push_str(&pretty(&Value::Object(sel), 1));
        }
        text(out)
    }

    async fn view(&self, args: &JsonObject) -> CallToolResult {
        let stale = {
            let st = self.state.lock().await;
            st.mesh.is_empty() || st.built_for.as_deref() != Some(&signature(&st.doc))
        };
        if stale {
            let built = self.build().await;
            if is_error(&built) {
                return built;
            }
        }
        let mesh = {
            let st = self.state.lock().await;
            st.mesh.clone()
        };
        if mesh.is_empty() {
            return failure("Nothing to render: the document produced no bodies.");
        }
        let w = args
            .get("width")
            .and_then(Value::as_i64)
            .unwrap_or(640)
            .clamp(64, MAX_IMAGE_PX) as u32;
        let h = args
            .get("height")
            .and_then(Value::as_i64)
            .unwrap_or(480)
            .clamp(64, MAX_IMAGE_PX) as u32;
        let highlight = match index_set(args.get("highlight_faces")) {
            Some(faces) if !faces.is_empty() => {
                let body = args
                    .get("highlight_body")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        mesh[0]
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    });
                Some((body, faces))
            }
            _ => None,
        };
        let bodies = args.get("bodies").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        });
        let section = args.get("section").cloned().unwrap_or(Value::Null);
        let request = ViewRequest {
            width: w,
            height: h,
            view: args
                .get("view")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| Some("iso".into())),
            azimuth: args.get("azimuth").and_then(Value::as_f64),
            elevation: args.get("elevation").and_then(Value::as_f64),
            highlight,
            section: section.clone(),
            bodies: bodies.clone(),
            focus: args.get("focus").cloned().unwrap_or(Value::Null),
            draw_edges: true,
        };
        let canvas = match render::render(&mesh, &request) {
            Ok(c) => c,
            Err(e) => return failure(format!("ValueError: {e}")),
        };
        let png = match crate::png::encode(&canvas) {
            Ok(p) => p,
            Err(e) => return failure(e),
        };
        let where_ = match args.get("view").and_then(Value::as_str) {
            Some(v) => v.to_string(),
            None => format!(
                "az {} el {}",
                py_num(args.get("azimuth").or(Some(&json!(0)))),
                py_num(args.get("elevation").or(Some(&json!(0))))
            ),
        };
        let shown: Vec<String> = bodies.unwrap_or_else(|| {
            mesh.iter()
                .map(|b| {
                    b.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
                .collect()
        });
        let cut = if section.is_null() {
            String::new()
        } else {
            // The side actually kept, resolved the way the renderer resolves
            // it, not the word that was passed in: this line used to say
            // "keeping max" over a picture that had kept the other half.
            let keep = section
                .get("keep")
                .and_then(Value::as_str)
                .unwrap_or("below")
                .trim()
                .to_ascii_lowercase();
            let side = if render::keep_word(&keep).unwrap_or(false) {
                "above"
            } else {
                "below"
            };
            format!(
                ", cut on {} at {}, keeping {side}",
                section
                    .get("axis")
                    .map_or("X".to_string(), |a| py_num(Some(a))),
                section
                    .get("at")
                    .map_or("the middle".to_string(), |a| py_num(Some(a)))
            )
        };
        CallToolResult::success(vec![
            ContentBlock::text(format!(
                "{where_} view of {}, {w}x{h}{cut}",
                shown.join(", ")
            )),
            ContentBlock::image(
                base64::engine::general_purpose::STANDARD.encode(&png),
                "image/png",
            ),
        ])
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn index_set(v: Option<&Value>) -> Option<Vec<i64>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
}

fn keep_indices(body: &mut Value, key: &str, want: &[i64]) {
    if let Some(list) = body.get_mut(key).and_then(Value::as_array_mut) {
        list.retain(|e| {
            e.get("i")
                .and_then(Value::as_i64)
                .is_some_and(|i| want.contains(&i))
        });
    }
}

// --- doc_import ---------------------------------------------------------------

impl FundaCad {
    /// Read a geometry file into an `import` feature.
    ///
    /// Two steps, the same two the app's own import does: ask the engine to
    /// read the file, then put the fields it hands back into the timeline. The
    /// geometry itself never travels through here, `geom` is its content hash
    /// in the engine's durable blob store, which is why this stays a small
    /// reply for a file of any size and why that store has to be the one the
    /// app reads.
    ///
    /// Everything before the last piece changes nothing: the document is
    /// untouched, which is what keeps a half-arrived file from reaching the app
    /// as an edit.
    async fn doc_import(&self, args: &JsonObject) -> CallToolResult {
        // Present and not empty, whatever type it arrived as. A `content` that
        // is a number is content that was sent wrong, and it has to reach the
        // spool to be told so by name; treating it as absent would answer with
        // the message for a call that sent nothing at all.
        let has_path = truthy(args.get("path"));
        let has_content = truthy(args.get("content"));
        if has_path && has_content {
            return failure("Give path or content, not both.");
        }
        if !has_path && !has_content {
            return failure(
                "Give either path (a file this machine can open) or content (the file itself, \
                 base64) with name.",
            );
        }

        let mut upload_id: Option<String> = None;
        let (path, fmt, source) = if has_path {
            let path = abspath(args.get("path").and_then(Value::as_str).unwrap_or_default());
            if !path.is_file() {
                return failure(format!(
                    "No such file: {}\n{ASK_FOR_A_PATH}",
                    path.display()
                ));
            }
            let fmt = args
                .get("format")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
                .unwrap_or_else(|| upload::import_format(&path.to_string_lossy()).to_string());
            if !IMPORT_FORMATS.contains(&fmt.as_str()) {
                return failure(format!(
                    "Cannot import '{fmt}' files. Formats: {}.",
                    IMPORT_FORMATS.join(", ")
                ));
            }
            let source = path.to_string_lossy().into_owned();
            (path, fmt, source)
        } else {
            let id = match self.spool(args).await {
                Ok(id) => id,
                Err(e) => return failure(e.to_string()),
            };
            let (got, parts, spooled, name) = {
                let st = self.state.lock().await;
                let up = &st.uploads[&id];
                (up.got, up.parts, up.spooled(), up.name.clone())
            };
            if got < parts {
                // The nudge goes on the FIRST piece or nowhere: that is while
                // there is still something to decide. On the fifth it would
                // only be telling an agent that the thing it is halfway through
                // was a bad idea, which is worse than silence.
                let costly = if got == 1 && parts > PIECES_WORTH_IT {
                    format!("\nThis is one message of yours per piece. {ASK_FOR_A_PATH}")
                } else {
                    String::new()
                };
                return text(format!(
                    "Part {got} of {parts} received, {} of {name} so far. Send part {} with \
                     upload=\"{id}\". Nothing is imported until the last piece.{costly}",
                    upload::size_text(spooled),
                    got + 1
                ));
            }
            let unpacked = {
                let mut st = self.state.lock().await;
                let up = st.uploads.get_mut(&id).expect("just spooled");
                upload::unpack(up).map(|p| (p, up.fmt.clone(), up.name.clone()))
            };
            match unpacked {
                Ok((path, fmt, name)) => {
                    upload_id = Some(id);
                    // Provenance, not a path. The temporary file is about to be
                    // gone, and recording it would send whoever read the field
                    // back to nothing.
                    (path, fmt, name)
                }
                Err(e) => {
                    self.state.lock().await.drop_upload(&id);
                    return failure(format!("Could not read what was sent: {e}"));
                }
            }
        };

        let link = self.engine_link().await;
        let reply = link
            .call(
                "import",
                call_args([
                    ("path", json!(path.to_string_lossy())),
                    ("format", json!(fmt)),
                ]),
            )
            .await;
        if let Some(id) = &upload_id {
            self.state.lock().await.drop_upload(id);
        }
        let reply = match reply {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            // The engine refuses for reasons an agent can act on (too large,
            // too many triangles, unreadable), so its message is the whole
            // answer and is passed through rather than summarised.
            let message = reply
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unreadable file");
            return failure(format!("Import failed: {message}"));
        }
        let res = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        if res.get("geom").and_then(Value::as_str).unwrap_or("").is_empty() {
            return failure(format!("The engine read {source} but returned no geometry."));
        }

        let mut feature = Map::new();
        feature.insert("type".into(), json!("import"));
        feature.insert("format".into(), json!(fmt));
        let name = match res.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) {
            Some(n) => n.to_string(),
            None => stem(&source),
        };
        feature.insert("name".into(), json!(name));
        feature.insert("geom".into(), res["geom"].clone());
        feature.insert("source".into(), json!(source));
        let solid = res.get("solid").and_then(Value::as_bool).unwrap_or(false);
        feature.insert("solid".into(), json!(solid));
        // Spread, not defaulted, exactly as the app's import does: a file with
        // no colour and no assembly tree must produce the feature it always
        // did, and a null is a different thing from absent to everything
        // downstream.
        for key in ["color", "nodes", "parts"] {
            if let Some(v) = res.get(key).filter(|v| !v.is_null()) {
                feature.insert(key.into(), v.clone());
            }
        }

        let mut st = self.state.lock().await;
        let fid = match model::add_feature(
            &mut st.doc,
            &Value::Object(feature),
            args.get("at").and_then(Value::as_i64),
        ) {
            Ok(fid) => fid,
            Err(e) => return doc_error(e),
        };
        st.invalidate();
        let kind = if solid {
            "solid"
        } else {
            "surface body (not a solid)"
        };
        let parts = match res.get("parts").and_then(Value::as_array) {
            Some(p) if !p.is_empty() => format!(", {} parts", p.len()),
            _ => String::new(),
        };
        let head = format!(
            "Imported {source} as {fid}: '{name}', {kind}, {} faces{parts}.\nRun `build`, then \
             `inspect` for its sizes and the selectors that address its faces and edges.",
            res.get("faces")
                .map_or("?".to_string(), |f| py_num(Some(f)))
        );
        text(st.state_line(&head))
    }

    /// Take one piece of an inline file and return the upload it belongs to.
    ///
    /// Order is required rather than reassembled. Buffering out-of-order pieces
    /// would mean holding them until the gap filled, and a gap that never fills
    /// is indistinguishable from one that has not filled yet; refusing by name
    /// turns a lost piece into something the caller can act on immediately.
    async fn spool(&self, args: &JsonObject) -> Result<String, upload::UploadError> {
        let part = args.get("part").filter(|v| !v.is_null()).cloned();
        let parts = args.get("parts").filter(|v| !v.is_null()).cloned();
        if part.is_some() != parts.is_some() {
            return Err(upload::UploadError(
                "part and parts go together: say which piece this is and how many there are \
                 altogether."
                    .into(),
            ));
        }
        let (part, parts) = match (part, parts) {
            (None, None) => (1, 1),
            (Some(a), Some(b)) => {
                for (label, v) in [("part", &a), ("parts", &b)] {
                    let ok = matches!(v, Value::Number(n) if n.is_i64() || n.is_u64())
                        && v.as_i64().is_some_and(|n| n >= 1);
                    if !ok {
                        return Err(upload::UploadError(format!(
                            "{label} must be a whole number from 1 up."
                        )));
                    }
                }
                (a.as_i64().unwrap_or(0), b.as_i64().unwrap_or(0))
            }
            _ => unreachable!("both or neither, checked above"),
        };
        if part > parts {
            return Err(upload::UploadError(format!(
                "part {part} of {parts} is more pieces in than there are pieces."
            )));
        }

        let mut st = self.state.lock().await;
        let id = if part == 1 {
            // Pieces nobody came back for.
            let stale: Vec<String> = st
                .uploads
                .iter()
                .filter(|(_, u)| u.touched.elapsed().as_secs() > upload::UPLOAD_IDLE_SECONDS)
                .map(|(k, u)| {
                    log(&format!("[mcp] dropping an unfinished upload of {}", u.name));
                    k.clone()
                })
                .collect();
            for k in stale {
                st.drop_upload(&k);
            }
            let up = Upload::new(args, parts)?;
            let id = up.id.clone();
            st.uploads.insert(id.clone(), up);
            id
        } else {
            let id = args
                .get("upload")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let Some(up) = st.uploads.get(&id) else {
                return Err(upload::UploadError(format!(
                    "no upload is in progress under that id. Send part 1 again; every piece \
                     after it has to quote the id the first reply gave, and an upload nobody \
                     returns to is dropped after {} minutes.",
                    upload::UPLOAD_IDLE_SECONDS / 60
                )));
            };
            if parts != up.parts {
                return Err(upload::UploadError(format!(
                    "this upload was announced as {} pieces and part {part} says {parts}.",
                    up.parts
                )));
            }
            if part != up.got + 1 {
                return Err(upload::UploadError(format!(
                    "expected part {} of {}, got part {part}. The pieces have to arrive in order.",
                    up.got + 1,
                    up.parts
                )));
            }
            id
        };
        let written = {
            let up = st.uploads.get_mut(&id).expect("present");
            up.write(args.get("content"), part)
        };
        if let Err(e) = written {
            st.drop_upload(&id);
            return Err(e);
        }
        Ok(id)
    }
}

fn stem(source: &str) -> String {
    let base = source.rsplit(['/', '\\']).next().unwrap_or(source);
    match base.rfind('.') {
        Some(at) if at > 0 => base[..at].to_string(),
        _ => base.to_string(),
    }
}

// --- the protocol -------------------------------------------------------------

#[rmcp::tool_handler(router = self.router)]
impl ServerHandler for FundaCad {
    fn get_info(&self) -> ServerConfig {
        // `instructions` needs the lock and this does not get to await, so the
        // working order goes out as it stands at start-up, which is when a host
        // reads it. `call_live` is what keeps the live rules true afterwards.
        let live = self.state.try_lock().map(|s| s.live.is_some()).unwrap_or(false);
        let instructions = if live {
            format!("{LIVE_INSTRUCTIONS}{}", schema::how_to())
        } else {
            schema::how_to().to_string()
        };
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::new("fundacad", "0.1.0"))
        .with_instructions(instructions)
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let mut resource = Resource::new("fundacad://schema", "FundaCAD document schema");
        resource.description = Some("Every feature type, its fields and its traps.".into());
        resource.mime_type = Some("text/plain".into());
        Ok(ListResourcesResult {
            resources: vec![resource],
            ..Default::default()
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        if request.uri != "fundacad://schema" {
            return Err(McpError::invalid_params(
                format!("no such resource: {}", request.uri),
                None,
            ));
        }
        Ok(ReadResourceResponse::Complete(ReadResourceResult::new(
            vec![ResourceContents::TextResourceContents {
                uri: request.uri,
                mime_type: Some("text/plain".into()),
                text: schema::schema_text(None),
                meta: None,
            }],
        )))
    }

    /// A tool's own failure is a RESULT with isError, not a JSON-RPC error.
    ///
    /// The distinction matters: a JSON-RPC error means the call was malformed
    /// and the model cannot learn anything from it, while isError puts the
    /// message in front of the model as something to react to. Almost
    /// everything that goes wrong here, a bad selector, an impossible fillet, a
    /// sketch that does not close, is the second kind.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let _turn = self.turn.lock().await;
        let name = request.name.to_string();
        if self.router.get(&name).is_none() {
            let mut have: Vec<String> = self
                .router
                .list_all()
                .iter()
                .map(|t| t.name.to_string())
                .collect();
            have.sort();
            return Ok(CallToolResponse::Complete(failure(format!(
                "No tool '{name}'. Have: {}",
                have.join(", ")
            ))));
        }
        let args = request.arguments.clone().unwrap_or_default();
        // Never fatal to a tool call: working privately is a worse answer than
        // working on the open document, but it is a working one.
        self.adopt_running_app().await;

        for attempt in 0..2 {
            let live = self.state.lock().await.live.is_some();
            if live && !NO_DOCUMENT.contains(&name.as_str()) {
                let tcc = ToolCallContext::new(self, request.clone(), context.clone());
                let run = self.router.call(tcc);
                match self.call_live(&name, &args, run).await {
                    Ok(out) => return out,
                    Err(e) if attempt == 0 && e.is_lost() => {
                        self.drop_lost_app(e.message()).await;
                        continue;
                    }
                    Err(e) => return Ok(CallToolResponse::Complete(failure(e.message()))),
                }
            }
            if MUTATORS.contains(&name.as_str()) {
                self.state.lock().await.private_edits = true;
            }
            let tcc = ToolCallContext::new(self, request, context);
            return self.router.call(tcc).await;
        }
        unreachable!("the loop returns or continues once")
    }
}

impl FundaCad {
    /// Pieces of a file nobody finished sending, and the lease the app is
    /// showing. Not a substitute for the sweep, which is what covers the case
    /// that actually happens: a host kills its servers outright, and no
    /// clean-up runs then.
    pub async fn shutdown(&self) {
        let (link, live, ids) = {
            let st = self.state.lock().await;
            (
                st.link.clone(),
                st.live.is_some(),
                st.uploads.keys().cloned().collect::<Vec<_>>(),
            )
        };
        {
            let mut st = self.state.lock().await;
            for id in ids {
                st.drop_upload(&id);
            }
        }
        if live {
            let st = self.state.lock().await;
            if let Some(l) = st.live.as_ref() {
                l.leave(&link).await;
            }
        }
        link.stop().await;
    }
}
