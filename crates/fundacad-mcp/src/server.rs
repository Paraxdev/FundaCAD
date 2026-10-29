//! FundaCAD over MCP. STDOUT IS THE PROTOCOL: nothing else may be written there, diagnostics go to stderr.
//! PRIVATE or LIVE is `State::live`, and `call_live` wraps every tool so no tool can forget which document it edits.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, JsonObject,
    ListResourcesResult, PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult,
    Resource, ResourceContents, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{tool, tool_router, ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::budget::{self, Page};
use crate::describe;
use crate::docfile;
use crate::docget;
use crate::link::{args as call_args, EngineLink, Mode};
use crate::live::{LiveError, LiveLink};
use crate::mesh::MeshBody;
use crate::model::{self, Doc};
use crate::render::{self, ViewRequest};
use crate::schema;
use crate::scope::PathScope;
use crate::upload::{self, Upload, ASK_FOR_A_PATH, IMPORT_FORMATS, PIECES_WORTH_IT};

/// Renders go back inline, so their size costs context: 640x480 is about 25 kB of PNG on a typical part.
pub const MAX_IMAGE_PX: i64 = 1600;

/// Offered to the app in a live session. A reader that proposed would put a no-op edit and an undo step
/// in front of the user every time an agent measured something.
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
    "edit",
    "sketch_merge",
    "sketch_tie",
];

/// They must not wait for a document: `schema` is what an agent reads BEFORE anything exists.
pub const NO_DOCUMENT: &[&str] =
    &["schema", "ui_open", "ui_do", "ui_read", "ui_shot", "ui_close", "guide_highlight", "guide_wait", "guide_clear"];

/// Kept SHORT and ordered by what a mistake costs, since hosts cut server instructions (Claude Code keeps 2048
/// characters). The full working order is in the `schema` tool; `tests/schema.rs` holds both under the limit.
pub const INSTRUCTIONS: &str = "Rules that save most failed builds:
- Z is up. A sketch on XY is a floor plan, on XZ a side elevation.
- box, cylinder, cone, sphere and torus are CENTRED ON THE ORIGIN. Place them with `move`.
- Body ids (body1, ...) are handed out at build time and are not feature ids. Read them from `build` or `inspect`. A body keeps its id, and a join keeps its target's.
- A feature can only reference features ABOVE it in the timeline.
- Once more than one body exists, set `targets` on every join, cut and intersect, or it acts on every body it overlaps.
- A numeric field takes a number or a parameter NAME, never an expression.
- Never guess a selector: take it from `inspect`, and always set its `body`.
- To fit something to a part in a file, `doc_import` the file. Never model against a stand-in you made up; if you cannot reach the file, ask for its path.
- Files: `doc_save`, `export`, `doc_open` and `doc_import` take a local path in any ordinary folder, not home itself, a drive root, a hidden (dot) folder or a network path; a server started with --allow-path keeps to those folders, and a refusal says which.
- Long replies come summary first with alike rows folded: `offset` pages on, `limit` 0 shows all, `body` or `bodies` narrows, `detail` or `outline` adds rows, `full` lists everything.

Working order: `param_set` the driving dimensions first, `feature_add` a few features, `build` often, `inspect`, `view`, then `doc_save` to a .funda file the app opens.

Call `schema` with a type before writing it for the first time: it has the fields, an example and the traps of every feature type, and the full working order.
";

/// Prepended in live mode, since there is no private copy to throw away and the person is watching.
pub const LIVE_INSTRUCTIONS: &str = "YOU ARE EDITING A DOCUMENT SOMEONE HAS OPEN IN FUNDACAD. Every edit appears in their window as you make it. Each tool re-reads their document first. An edit refused because they changed the model means read it again and decide again, not retry. `doc_new` and `doc_open` REPLACE what they have open: only call them when asked. Your work reaches them without `doc_save`.

";

pub fn instructions_for(live: bool) -> String {
    if live {
        format!("{LIVE_INSTRUCTIONS}{INSTRUCTIONS}")
    } else {
        INSTRUCTIONS.to_string()
    }
}

/// The probe reads a file and dials only when it exists; the interval is for a stale file,
/// whose dial would otherwise wait out its timeout on every tool call.
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

/// One "FEATURE FAILED (id): message" line per failure, from `featureErrors`, `inspect`'s `errors` or
/// `export`'s `warnings`, so every tool reads a partial build the same way.
fn feature_failure_lines(errors: &[Value]) -> Vec<String> {
    errors
        .iter()
        .filter_map(|e| {
            let m = e.get("message").and_then(Value::as_str)?;
            Some(format!(
                "FEATURE FAILED ({}): {m}{}",
                e.get("feature_id").and_then(Value::as_str).unwrap_or("None"),
                open_profile_hint(m)
            ))
        })
        .collect()
}

/// The engine's "no closed profile" is also what the app shows, and the app
/// has no `sketch_tie`, so the way out is added here.
fn open_profile_hint(message: &str) -> &'static str {
    if message.contains("no closed profile") {
        ". `inspect` with `sketch` lists the sketch's loose ends, and `sketch_tie` ties the ones that only touch."
    } else {
        ""
    }
}

/// A `match` selector the engine found no longer matching where it was
/// picked. It still took an edge, so the build never goes silent about which.
fn stale_match_line(d: &Value) -> Option<String> {
    if d.get("stale") != Some(&json!(true)) {
        return None;
    }
    let mm = |x: f64| {
        let r = (x * 1000.0).round() / 1000.0;
        format!("{}", if r == 0.0 { 0.0 } else { r })
    };
    let pt = |v: &Value| {
        let c: Vec<String> = v.as_array()?.iter().map(|x| x.as_f64().map(mm)).collect::<Option<_>>()?;
        Some(format!("({})", c.join(", ")))
    };
    let picked = pt(d.get("picked")?)?;
    let now = d.get("now")?;
    let through = pt(now.get("mid")?)?;
    let curve = now.get("curve").and_then(Value::as_str).unwrap_or("edge");
    let off = d.get("off").and_then(Value::as_f64).map_or(String::new(), |o| format!(", {} mm from its pick", mm(o)));
    if d.get("reason").and_then(Value::as_str).is_some_and(|r| r.starts_with("tie")) {
        return Some(format!(
            "its edge selector picked at {picked} no longer matches an edge there, it now resolves to the {curve} \
             through {through}{off}, tied with another edge. Check it with inspect and re-pick it if that is the \
             wrong edge."
        ));
    }
    // One best match far from the pick is what a parameter moving the edge
    // leaves, and also what the edge being gone leaves, so it is said either way.
    Some(format!(
        "its edge selector picked at {picked} now resolves to the {curve} through {through}{off}. That is right \
         when a parameter moved the edge, otherwise check it with inspect and re-pick it."
    ))
}

/// The engine's `skippedFeatures`: features of a type it does not know, which a
/// file from a newer version can hold. Not built, and not lost either.
fn skipped_lines(result: &Value) -> Vec<String> {
    result
        .get("skippedFeatures")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|s| {
            let m = s.get("message").and_then(Value::as_str)?;
            Some(format!(
                "SKIPPED ({}): {m}, kept in the document but not built",
                s.get("feature_id").and_then(Value::as_str).unwrap_or("None")
            ))
        })
        .collect()
}

struct Rebuilt {
    link: Arc<EngineLink>,
    document: Map<String, Value>,
    result: Value,
    mesh: Arc<Vec<MeshBody>>,
    problems: Vec<String>,
}

/// Shown to the user beside the editing indicator: the tool plus the argument that says what it touched.
fn edit_note(name: &str, args: &JsonObject) -> String {
    let subject = args
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| args.get("name").and_then(Value::as_str))
        .or_else(|| args.get("feature").and_then(|f| f.get("type")).and_then(Value::as_str));
    match subject {
        Some(s) => format!("{name}: {s}"),
        None => name.to_string(),
    }
}

/// Mesh points rounded to a micron and sorted, so a reordered timeline gives the same print;
/// a body that only moved gets a new one.
fn shape_print(b: &MeshBody) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut points: Vec<[i64; 3]> =
        b.positions.chunks_exact(3).map(|p| [0, 1, 2].map(|k| ((p[k] as f64) * 1000.0).round() as i64)).collect();
    points.sort_unstable();
    points.dedup();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    points.hash(&mut h);
    h.finish()
}

/// Cheap and exact: while this string is unchanged, the cached mesh is still the answer.
fn signature(doc: &Doc) -> String {
    let mut m = Map::new();
    m.insert("f".into(), doc.get("features").cloned().unwrap_or(Value::Null));
    m.insert("p".into(), doc.get("parameters").cloned().unwrap_or(Value::Null));
    canonical(&Value::Object(m))
}

/// Keys sorted, as Python's `sort_keys=True`: documents that differ only in key order are the same.
fn canonical(v: &Value) -> String {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let body: Vec<String> =
                keys.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), canonical(&o[*k]))).collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
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

/// The app's file when this is its live session, which shares its path as the title,
/// else the one opened or saved here.
fn doc_file(st: &State) -> Option<PathBuf> {
    match &st.live {
        Some(live) => live.title.as_deref().map(PathBuf::from).filter(|p| p.is_absolute()),
        None => st.path.clone(),
    }
}

struct State {
    doc: Doc,
    path: Option<PathBuf>,
    link: Arc<EngineLink>,
    /// Set while working on the document a running app has open; None means the document here is private.
    live: Option<LiveLink>,
    /// True once a tool changed the PRIVATE document, which stops the re-probe pulling the rug out from under it.
    private_edits: bool,
    /// By id, only between the first piece of a file and its last.
    uploads: HashMap<String, Upload>,
    /// So a closed app costs one file stat per tool rather than one connect timeout.
    probed_at: Option<Instant>,
    /// What `view` draws, kept because a render right after a build is common and the mesh is the costly part.
    mesh: Arc<Vec<MeshBody>>,
    /// The document signature `mesh` belongs to.
    built_for: Option<String>,
    /// Each body's line from the last `build`, so the next one says only what changed:
    /// a 32-body assembly listed in full after every edit eats an agent's context.
    reported: Option<HashMap<String, (String, u64)>>,
    /// The `build` FundaCAD's engine answered the last probe with, kept after
    /// the app goes so work moved to a private engine can be compared with it.
    app_build: Option<Value>,
    /// Sections of the opened `.fundab` this build cannot read, which a JSON
    /// save leaves out.
    unread_sections: Vec<String>,
}

impl State {
    fn invalidate(&mut self) {
        self.mesh = Arc::default();
        self.built_for = None;
    }

    /// Not the timeline itself, which at two hundred features was most of every reply; `doc_get` has it.
    fn state_line(&mut self, head: &str) -> String {
        let count = model::features(&self.doc).len();
        let problems = model::validate(&mut self.doc);
        let mut out = format!("{head} {count} feature{} in the timeline.", if count == 1 { "" } else { "s" });
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
    /// One tool at a time: the engine serialises heavy work anyway, and it makes the live pull,
    /// the tool and the push one atomic edit.
    turn: Arc<Mutex<()>>,
    pub(crate) ui: Arc<Mutex<Option<crate::ui::UiBridge>>>,
    /// The user's guide Stop presses already reported, so each is said once.
    pub(crate) guide_stops: Arc<std::sync::atomic::AtomicI64>,
    scope: Arc<PathScope>,
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
                mesh: Arc::default(),
                built_for: None,
                reported: None,
                app_build: None,
                unread_sections: Vec::new(),
            })),
            turn: Arc::new(Mutex::new(())),
            router: Arc::new(Self::base_router()),
            ui: Arc::new(Mutex::new(None)),
            guide_stops: Arc::new(std::sync::atomic::AtomicI64::new(crate::guide::UNSEEN)),
            scope: Arc::new(PathScope::for_server(std::env::args_os()).0),
        }
    }

    /// Every mode's tools. Guide mode is listed everywhere and says why where it cannot work.
    fn base_router() -> rmcp::handler::server::router::tool::ToolRouter<FundaCad> {
        let mut router = Self::tool_router();
        router.merge(Self::guide_router());
        router
    }

    /// The link, the live guest's name when sharing the app's document, and whether a private copy was edited.
    pub(crate) async fn guide_parts(&self) -> (Arc<EngineLink>, Option<String>, bool) {
        let st = self.state.lock().await;
        (st.link.clone(), st.live.as_ref().map(|l| l.name.clone()), st.private_edits)
    }

    /// `raw` absolute if the tools may touch it, else the refusal to answer with.
    pub(crate) async fn scoped(&self, raw: &str) -> Result<PathBuf, CallToolResult> {
        let st = self.state.lock().await;
        self.scoped_in(&st, raw)
    }

    fn scoped_in(&self, st: &State, raw: &str) -> Result<PathBuf, CallToolResult> {
        self.scope.check(raw, doc_file(st).as_deref()).map_err(failure)
    }

    /// The ui tools as well, which standalone gets and nothing else does.
    pub fn with_ui(mut self) -> FundaCad {
        let mut router = Self::base_router();
        router.merge(Self::ui_router());
        self.router = Arc::new(router);
        self
    }

    /// Once, at start-up, apart from the constructor because it reads the session file and dials the port.
    pub async fn attach(mode: Mode) -> Result<FundaCad, String> {
        let (link, app) = EngineLink::for_mode(mode, log).await?;
        let mut server = FundaCad::with_link(link);
        let (scope, refused) = PathScope::for_server(std::env::args_os());
        for line in refused {
            log(&format!("[mcp] {line}"));
        }
        let folders: Vec<String> = scope.folders().iter().map(|p| p.display().to_string()).collect();
        if scope.is_strict() {
            log(&format!(
                "[mcp] files are reached in {} and the open document's folder; more with --allow-path or {}",
                folders.join(", "),
                crate::scope::ALLOW_ENV
            ));
        } else {
            log("[mcp] files are reached in any plain folder except home itself, drive roots and hidden folders; --allow-path keeps to given folders");
        }
        server.scope = Arc::new(scope);
        if mode == Mode::Standalone {
            server = server.with_ui();
        }
        if let Some(app) = app {
            let mut st = server.state.lock().await;
            st.app_build = app.build;
            let mut live = LiveLink::new();
            match live.pull(&st.link).await {
                Ok(_) => {
                    log(&format!(
                        "[mcp] sharing the open document: {}",
                        live.title.clone().unwrap_or_else(|| "untitled".into())
                    ));
                }
                Err(e) => {
                    // The engine is the app's but the WINDOW is not sharing, a state to stay in:
                    // every tool that needs the document says why it cannot have it.
                    log(&format!("[mcp] attached to the engine, but not to a document: {e}"));
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

    pub async fn is_live(&self) -> bool {
        self.state.lock().await.live.is_some()
    }

    pub async fn engine_port(&self) -> u16 {
        self.state.lock().await.link.port()
    }

    /// Settable too, so a test can reach the re-probe branch without building anything.
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
        self.state.lock().await.uploads.iter().map(|(k, u)| (k.clone(), u.dir.clone())).collect()
    }

    /// Move every open upload's last-touched time back, so a test can reach the
    /// sweep without waiting half an hour for it.
    pub async fn age_uploads(&self, by: Duration) {
        for up in self.state.lock().await.uploads.values_mut() {
            up.touched -= by;
        }
    }

    pub fn tools(&self) -> Vec<rmcp::model::Tool> {
        self.router.list_all()
    }

    pub async fn instructions(&self) -> String {
        // Live mode adds a paragraph rather than replacing the working order,
        // which is just as true either way.
        instructions_for(self.state.lock().await.live.is_some())
    }

    /// Attach to an app that appeared after start-up: hosts start servers with the HOST, before anyone opened FundaCAD.
    /// Only while private, only when nothing built here would be discarded, and no more often than REPROBE.
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

        let Some(app) = crate::app_session::find_running_app(None, crate::app_session::PROBE_TIMEOUT).await else {
            return;
        };
        self.state.lock().await.app_build = app.build.clone();
        let link = Arc::new(EngineLink::attach(app.port, app.token.clone()));
        let mut live = LiveLink::new();
        let doc = match live.pull(&link).await {
            Ok(doc) => doc,
            Err(e) => {
                // Engine found, but the window is not sharing or went away. Staying private is honest,
                // and saying why keeps the connector from looking broken.
                log(&format!("[mcp] FundaCAD is open but not sharing a document: {e}"));
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
            st.reported = None;
            old
        };
        // Dropped after the swap, never before: a failure above must leave a working private session.
        old.stop().await;
    }

    /// The app's engine went away under a live session and nothing reconnects a live link, so fall back
    /// to a private engine with the last pulled document and let the re-probe find the app again.
    pub(crate) async fn drop_lost_app(&self, why: &str) {
        log(&format!("[mcp] lost FundaCAD's engine ({why}), working on a private copy until it is back"));
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

    /// Said while on a private engine that is not the build of the app it last reached,
    /// which is how a document comes to build differently here than in the app.
    async fn build_mismatch(&self) -> Option<String> {
        let (link, app) = {
            let st = self.state.lock().await;
            if st.live.is_some() || st.link.attached {
                return None;
            }
            (st.link.clone(), st.app_build.clone()?)
        };
        crate::link::build_mismatch(&app, &link.build().await?)
    }

    async fn engine_link(&self) -> Arc<EngineLink> {
        self.state.lock().await.link.clone()
    }

    /// One tool against the app's open document: pulled before, so the tool sees what the user sees, and pushed
    /// after the error check, waiting for the app, since a half-applied document would reach the user as an edit.
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
            // A window not sharing is a SETTING the user can turn on, not a lost engine;
            // only a lost transport reconnects.
            let pulled = match live.pull(&link).await {
                Ok(pulled) => pulled,
                Err(e) if e.is_lost() => return Err(e),
                Err(e) => return Ok(Ok(CallToolResponse::Complete(failure(e.message())))),
            };
            st.doc = pulled.unwrap_or_else(model::new_document);
            model::fill_defaults(&mut st.doc);
            // No invalidate: `view` checks the cached mesh against the document in hand anyway,
            // and dropping it on every pull would make each live build then view rebuild twice.
            (st.doc.clone(), st.path.clone(), st.unread_sections.clone())
        };
        let (before, path_before, unread_before) = before;

        let out = run.await;
        let Ok(CallToolResponse::Complete(result)) = out else {
            return Ok(out);
        };
        // An `edit` or `sketch_merge` that built a failing feature still made its change, the user's to see;
        // its isError is about the build.
        if !MUTATORS.contains(&name) || (is_error(&result) && !matches!(name, "edit" | "sketch_merge")) {
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
            let replaces = matches!(name, "doc_new" | "doc_open" | "doc_set");
            live.push(&link, &document, &edit_note(name, args), replaces).await
        };
        match pushed {
            Ok(rev) => {
                Ok(Ok(CallToolResponse::Complete(append(result, &format!("\n(applied in FundaCAD, revision {rev})")))))
            }
            Err(e) => {
                // Put back the edit the app never took, and a refused doc_open's path, or a bare doc_save writes
                // the user's document over that file. A lost engine retries privately from the pulled document.
                let mut st = self.state.lock().await;
                st.doc = before;
                st.path = path_before;
                st.unread_sections = unread_before;
                st.reported = None;
                if e.is_lost() {
                    return Err(e);
                }
                Ok(Ok(CallToolResponse::Complete(failure(e.message()))))
            }
        }
    }
}

/// Python's `bool(x)` for a JSON value.
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
        .ok_or_else(|| failure(format!("this call needs `{key}`, and it was not given")))
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
        input_schema = crate::tools::schema_tool(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_schema(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(text(schema::schema_text(args.get("type").and_then(Value::as_str))))
    }

    #[tool(
        name = "doc_new",
        description = "Start an empty document, discarding the current one.",
        input_schema = crate::tools::doc_new(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_doc_new(&self, _args: JsonObject) -> Result<CallToolResult, McpError> {
        let mut st = self.state.lock().await;
        st.doc = model::new_document();
        st.path = None;
        st.unread_sections.clear();
        st.invalidate();
        st.reported = None;
        Ok(text("New empty document."))
    }

    #[tool(
        name = "doc_open",
        description = "Load a .funda document from disk.",
        input_schema = crate::tools::doc_open(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_doc_open(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        // Absolute from here down: a relative path resolves against the working directory the MCP host chose,
        // so echoing what was typed says nothing about where the file is.
        let path = match require_str(&args, "path") {
            Ok(p) => match self.scoped(&p).await {
                Ok(p) => p,
                Err(e) => return Ok(e),
            },
            Err(e) => return Ok(e),
        };
        let (doc, blobs, unread) = match docfile::read_document_full(&path) {
            Ok(v) => v,
            Err(e) => return Ok(failure(e.to_string())),
        };
        let root = docfile::blob_dir();
        let published = docfile::publish_all(&root, &blobs);
        let link = self.engine_link().await;
        let mut pushed_note = String::new();
        if let Err(e) = crate::blobs::push(&link, &blobs).await {
            if !published {
                return Ok(failure(format!(
                    "the geometry of {}'s imported bodies reached neither the engine ({e}) nor {}, \
                     so it was not opened.",
                    path.display(),
                    root.display()
                )));
            }
            log(&format!("[mcp] blobs not pushed to the engine, relying on {}: {e}", root.display()));
            pushed_note = format!("\n{}", crate::blobs::engine_problem(&e));
        }
        let mut st = self.state.lock().await;
        st.doc = doc;
        st.unread_sections = unread;
        model::fill_defaults(&mut st.doc);
        st.path = Some(path.clone());
        st.invalidate();
        st.reported = None;
        let newer = model::newer_file_note(&st.doc).map_or(String::new(), |n| format!("\nnote: {n}"));
        let issues = model::recompute_parameters(&mut st.doc);
        let note = if issues.is_empty() {
            String::new()
        } else {
            format!(
                "\nparameter problems: {}",
                issues.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("; ")
            )
        };
        Ok(text(format!(
            "Opened {}: {} features, {} parameters.{newer}{note}{pushed_note}",
            path.display(),
            model::features(&st.doc).len(),
            model::param_defs(&st.doc).len()
        )))
    }

    #[tool(
        name = "doc_import",
        description = "Read an external geometry file (STEP, IGES, FreeCAD .FCStd, Rhino .3dm, IFC buildings, STL, 3MF, OBJ, PLY, OFF, AMF, BREP, GLB, glTF, VRML, X3D, FBX, 3DS, DXF, SVG) into the timeline as a body, so it can be measured with `inspect` and modelled against. Use it when asked to fit something to a part that exists as a file.\n\
`path` is a file the machine FundaCAD runs on can open, and is how anything of real size gets in. `content` is the file itself, for when you have no path to give: gzip it (`compression`, and a STEP shrinks about tenfold), and split it with `part` and `parts` if one message will not hold it.\n\
But content is written by YOU, so the limit that binds is your own output and not this server's: roughly one message per piece, and a file needing more than a handful of pieces is one to ask for a path to instead. If you cannot reach the file from where you are, ask the person you are working with for its path on the machine FundaCAD runs on, or ask them to open it in FundaCAD themselves (File, Import Mesh), which puts it in the document for `inspect` to measure. Do not substitute a simplified stand-in for the real part: fitting to an approximation is the failure this tool exists to prevent.\n\
The format comes from the extension unless given. A .gltf whose buffers sit in separate files needs `path`, its neighbours cannot come as `content`. A large STEP can take minutes: it is one read, so do it once and keep the document. A DXF drawing arrives as one sketch per layer on the XY plane, ready to extrude, and only its 3D faces as a body; a binary DXF goes as base64, an ASCII one may go as text. An SVG drawing arrives the same way, one sketch per top level group or Inkscape layer, Y up, healed into closed outlines that extrude with their holes; strokes come in as open curves.",
        input_schema = crate::tools::doc_import(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    pub async fn t_doc_import(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.doc_import(&args).await)
    }

    #[tool(
        name = "doc_save",
        description = "Write the document to a .funda file, which the FundaCAD app opens directly. Saves to the path it was opened from if none is given. Any ordinary folder works; home itself, a drive root, hidden (dot) folders and network paths are refused, and a server started with --allow-path keeps to those folders.",
        input_schema = crate::tools::doc_save(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_doc_save(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let mut st = self.state.lock().await;
        let given = args.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string);
        let Some(given) = given.or_else(|| st.path.as_ref().map(|p| p.to_string_lossy().into_owned())) else {
            return Ok(failure("No path given and this document has never been saved."));
        };
        let path = match self.scoped_in(&st, &given) {
            Ok(p) => p,
            Err(e) => return Ok(e),
        };
        model::recompute_parameters(&mut st.doc);
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Ok(failure(format!("No such directory: {}", parent.display())));
            }
        }
        let root = docfile::blob_dir();
        let mut fetched = std::collections::HashMap::new();
        let mut asking_failed = None;
        let link = st.link.clone();
        for digest in docfile::referenced_geometry(&st.doc) {
            if docfile::local_blob(&root, &digest).is_some() {
                continue;
            }
            match crate::blobs::fetch(&link, &digest).await {
                Ok(Some(data)) => {
                    fetched.insert(digest, data);
                }
                Ok(None) => {}
                Err(e) => {
                    log(&format!("[mcp] could not ask the engine for {digest}: {e}"));
                    asking_failed = Some(e);
                }
            }
        }
        let mut stamped = st.doc.clone();
        model::stamp_for_save(&mut stamped);
        let embedded = match docfile::write_with(&path, &stamped, Some(&root), &fetched) {
            Ok(n) => n,
            Err(e) => {
                let why = asking_failed.map_or_else(String::new, |e| format!("\n{}", crate::blobs::engine_problem(&e)));
                return Ok(failure(format!("{e}{why}")));
            }
        };
        st.path = Some(path.clone());
        let left_out = if st.unread_sections.is_empty() {
            String::new()
        } else {
            format!(
                "
note: left out of the file, because this build cannot read them and a .funda has no place for them: {}. Open the original .fundab in FundaCAD and save as .fundab to keep them.",
                std::mem::take(&mut st.unread_sections).join(", ")
            )
        };
        let geometry =
            if embedded > 0 { format!(", with {embedded} imported bodies' geometry") } else { String::new() };
        Ok(text(format!(
            "Saved {} features to {}{geometry}.{left_out}",
            model::features(&st.doc).len(),
            path.display()
        )))
    }

    #[tool(
        name = "doc_get",
        description = "The document's geometry as JSON: parameters, the feature timeline in order, and `bodyIds`, the record that keeps every body's id. Pass all of it back to `doc_set` and the same ids come out; the parts it leaves out (stress study, environment, materials and the like) stay in the document. By default runs of bodyIds read as one range entry and an import's long node and part lists are left out, which `doc_set` reads back; `full` gives the document as stored.",
        input_schema = crate::tools::doc_get(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_doc_get(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let full = truthy(args.get("full"));
        let st = self.state.lock().await;
        let mut out = Map::new();
        let features = st.doc.get("features").cloned().unwrap_or_else(|| json!([]));
        out.insert("features".into(), if full { features } else { docget::leave_out_lists(&features) });
        if !args.get("features_only").and_then(Value::as_bool).unwrap_or(false) {
            out.insert("parameters".into(), st.doc.get("parameters").cloned().unwrap_or_else(|| json!({})));
            out.insert("paramDefs".into(), st.doc.get("paramDefs").cloned().unwrap_or_else(|| json!({})));
            for key in ["bodyIds", "version"] {
                if let Some(v) = st.doc.get(key) {
                    let v = match v.as_object() {
                        Some(ids) if !full => Value::Object(docget::fold_body_ids(ids)),
                        _ => v.clone(),
                    };
                    out.insert(key.into(), v);
                }
            }
        }
        let printed = pretty(&Value::Object(out.clone()), 1);
        Ok(text(if full || printed.len() <= docget::LINES_FROM { printed } else { docget::lines(&out) }))
    }

    #[tool(
        name = "doc_set",
        description = "Replace what `doc_get` gives (features, parameters, paramDefs, bodyIds, version) with the given JSON. For wholesale rewrites; prefer the feature_* tools for edits. Every other part of the open document (stress study, environment, materials, palette, overlays, reference images) stays unless the JSON names it, and a key named with null is cleared. Keep the `bodyIds` that `doc_get` gave; without it the document is numbered as a new one, where a join keeps the id of the body it merges into.",
        input_schema = crate::tools::doc_set(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_doc_set(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let doc = match require(&args, "document") {
            Ok(d) => d,
            Err(e) => return Ok(e),
        };
        let ok = doc.as_object().is_some_and(|o| o.get("features").is_some_and(Value::is_array));
        if !ok {
            return Ok(failure("`document` needs a `features` list."));
        }
        let mut next = doc.as_object().cloned().unwrap_or_default();
        // Shortcuts only: a whole document may carry entity fields from a
        // newer build, and refusing it over them would lose the lot.
        let mut notes = Vec::new();
        if let Some(Value::Array(features)) = next.get_mut("features") {
            for f in features.iter_mut().filter_map(Value::as_object_mut) {
                let id = f.get("id").and_then(Value::as_str).unwrap_or("a sketch").to_string();
                match crate::shortcuts::expand(f, None) {
                    Ok(said) => notes.extend(said.into_iter().map(|n| format!("in {id}, {n}"))),
                    Err(why) => return Ok(failure(why)),
                }
            }
        }
        if let Some(ids) = next.get("bodyIds").and_then(Value::as_object) {
            match docget::unfold_body_ids(ids) {
                Ok(ids) => next.insert("bodyIds".into(), Value::Object(ids)),
                Err(why) => return Ok(failure(why)),
            };
        }
        let mut st = self.state.lock().await;
        if let Err(why) = docget::take_back_lists(&st.doc, &mut next) {
            return Ok(failure(why));
        }
        model::forget_stale_joins(&st.doc, &mut next);
        model::keep_unnamed_keys(&st.doc, &mut next);
        st.doc = next;
        model::fill_defaults(&mut st.doc);
        fundacad_core::body_ids::ensure_map(&mut st.doc);
        st.doc.entry("version").or_insert_with(|| json!(model::FORMAT_VERSION));
        st.invalidate();
        st.reported = None;
        model::recompute_parameters(&mut st.doc);
        Ok(text(st.state_line(&crate::shortcuts::noted("Replaced the document.", &notes))))
    }

    #[tool(
        name = "param_set",
        description = "Define or redefine a parameter. `expr` may be a number or an expression over other parameters (\"hub_d/2 - wall\"). Features reference it by NAME, which is what keeps the model parametric. Function arguments are separated by SEMICOLONS and trig is in degrees. Comparisons (< <= > >= == !=), && || ! yield 1 or 0, and if(cond; a; b) picks a branch: \"if(solid == 1; 0; innerX)\". Refused, changing nothing, if the expression does not resolve.",
        input_schema = crate::tools::param_set(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
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
        // Just this parameter: the whole table on every call buried a twenty parameter model; doc_get has it.
        let count = st.doc.get("parameters").and_then(Value::as_object).map_or(0, Map::len);
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
        input_schema = crate::tools::param_remove(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
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
        Ok(text(format!("Removed {name}. Now: {}", py_json(&table))))
    }

    #[tool(
        name = "feature_add",
        description = "Append a feature to the timeline (or insert it at `at`). Returns the id it was given. Call `schema` for the shape of one.",
        input_schema = crate::tools::feature_add(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    pub async fn t_feature_add(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let feature = match require(&args, "feature") {
            Ok(f) => f.clone(),
            Err(e) => return Ok(e),
        };
        let at = args.get("at").and_then(Value::as_i64);
        let mut st = self.state.lock().await;
        let (fid, notes) = match model::add_feature_noted(&mut st.doc, &feature, at) {
            Ok(r) => r,
            Err(e) => return Ok(doc_error(e)),
        };
        st.invalidate();
        Ok(text(st.state_line(&crate::shortcuts::noted(&format!("Added {fid}."), &notes))))
    }

    #[tool(
        name = "feature_update",
        description = "Merge `patch` into a feature. A null value in the patch REMOVES that field. A new `type` is checked as that type, so send the fields it needs in the same patch. Pass replace=true to swap the whole body instead.",
        input_schema = crate::tools::feature_update(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
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
        let (f, notes) = match model::update_feature_noted(&mut st.doc, &id, &patch, replace) {
            Ok(r) => r,
            Err(e) => return Ok(doc_error(e)),
        };
        st.invalidate();
        let line = crate::shortcuts::noted(&updated_line(&id, &f, &patch, replace), &notes);
        Ok(text(st.state_line(&line)))
    }

    #[tool(
        name = "feature_remove",
        description = "Delete a feature from the timeline.",
        input_schema = crate::tools::feature_remove(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
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
        input_schema = crate::tools::feature_move(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
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
        Ok(text(st.state_line(&format!("Moved {id} to position {to}."))))
    }

    #[tool(
        name = "edit",
        description = "Several feature and parameter edits in one call, applied in order and all or nothing: if one is refused, none is applied and the reply names it. Each entry of `ops` is {op, ...} with that tool's own arguments: add (feature_add), update (feature_update), remove, move, param (param_set), param_remove. Later entries may use ids that earlier ones gave. Pass build:true to build once at the end. Prefer this to a run of single feature_* calls.",
        input_schema = crate::tools::edit(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    pub async fn t_edit(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.edit(&args).await)
    }

    #[tool(
        name = "interference",
        description = "Which bodies overlap, and by how much, without changing the document. Reports every overlapping pair with the overlap's volume and box, and pairs closer than `clearance` (default 1 mm) with their gap. A long list gives its total first, largest overlap first, folds pairs alike in all but their ids into one row and shows 30 rows: `offset` pages on, `limit` 0 shows every row, `full` lists each pair with where it meets. `sweep` repeats the check at each value of a parameter, for a mechanism: {param:\"press\", from:0, to:12, steps:13} gives the clashes and the smallest gap at every step. A body that is not a closed solid (a surface, an open or badly joined shell, as some imports are) cannot be judged: it is listed under NOT CHECKED with why, and no pair with it is called clear. Use this, not an intersect feature, to check fits and clearances.",
        input_schema = crate::tools::interference(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_interference(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.interference(&args).await)
    }

    #[tool(
        name = "section",
        description = "Cut the built bodies with a plane and get, per body, the outline in the plane as closed loops of points and the section properties: area, centroid, second moments of area about the centroid (and principal ones when they differ), furthest fibre, section modulus and polar moment. For quick beam and spring checks. `axis` and `at` cut across X, Y or Z; `origin` and `normal` cut at any angle. Changes nothing. Over 10 bodies it counts them first, folds bodies with the same section into one row, leaves the loop points out (`outline` true shows them, 5 bodies a page) and shows 30 rows: `offset` pages on, `limit` 0 shows every row, `bodies` picks some, `full` gives every body with its outline.",
        input_schema = crate::tools::section(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_section(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.section(&args).await)
    }

    #[tool(
        name = "stress",
        description = "Linear static stress analysis of one body, without changing the document. Hold faces still with `fixed`, or with `supports` that are fixed, pinned (a hole or a pin, free to turn about its axis) or slider (held across the face only), push on others with `loads` (a total force in N or a pressure in MPa), add the body's own weight with `gravity`, pick a `material` by name (PLA, PETG, ABS, ASA, PA12 nylon, PC, aluminium 6061-T6, steel S235) or as {E, nu, yield, density} in MPa and g/cm3. Faces are the per-face selectors `inspect` lists with detail:true and selectors:true. A load, or a fixed support, on a place with no face of its own takes `spots` instead, each {at: [x, y, z], radius}: the surface within the radius of a point on the body. Units are mm, N and MPa. Answers with the peak von Mises stress and where, the largest deflection and where, the safety factor against yield, applied load (with the weight) against reaction, the reaction at each support, the mesh, warnings to heed, and a PNG coloured blue (low) to red (high) by stress. Takes seconds to a minute.",
        input_schema = crate::tools::stress(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_stress(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.stress(&args).await)
    }

    #[tool(
        name = "printability",
        description = "Check the built parts for FDM printing before they are printed: overhangs past the angle that prints unsupported (45 deg), walls under two nozzle widths, floors under two layers, gaps narrow enough to fuse, flat ceilings bridged further than 10 mm, and shells that are not closed solids. Each finding names the face (F index, for `inspect` and `view` highlight_faces) and ends in a `view` focus. As modelled with +Z up, or `layFlat` as `export` would lay the parts. Measured on a fine mesh, the triangles an STL export holds. A flat ceiling counts as a bridge when walls hold it on two opposite sides, otherwise it is an overhang. Changes nothing. A long report counts its findings first, folds bodies alike in all but their ids and position into one row and shows 30 rows: `offset` pages on, `limit` 0 shows every row, `bodies` checks some as if printed alone, `full` gives each body its own block and focus, `all` every finding.",
        input_schema = crate::tools::printability(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_printability(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.printability(&args).await)
    }

    #[tool(
        name = "sketch_merge",
        description = "Replace closed shapes of a sketch that overlap or touch (rectangles, circles, polygons, slots, loops of lines and arcs) with the lines, arcs and circles that bound their union, so the sketch has one area where the overlaps made several, and an extrude picks it with one `regions` point. Leave out a shape meant as a hole. Constraints on the merged shapes are dropped. The outline is fixed numbers: shapes sized by parameters are refused unless `bake` is true. Replies with a point inside each merged area.",
        input_schema = crate::tools::sketch_merge(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_sketch_merge(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.sketch_merge(&args).await)
    }

    #[tool(
        name = "sketch_tie",
        description = "Tie a sketch's loose ends, the gaps that keep a profile from closing: every end that meets another curve only by position (within `tolerance`) gets a coincident or point on curve constraint and is moved onto what it touches, exactly, so the profile closes for the engine. `inspect` with `sketch` lists the loose ends first. An end that meets nothing within reach stays open: draw a line to close it. An end whose coordinates name a parameter is never moved.",
        input_schema = crate::tools::sketch_tie(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_sketch_tie(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.sketch_tie(&args).await)
    }

    #[tool(
        name = "build",
        description = "Rebuild the document and report what came out: the bodies, their sizes, and any feature that failed. Build often, an error names the feature that caused it. isError is true if ANY feature failed, even when other features still produced bodies; the text still lists everything that did build, so check isError rather than scanning for \"FEATURE FAILED\". Over 10 bodies, bodies alike in all but their ids share one row and 30 rows show: `offset` pages on, `limit` 0 shows every row, `full` lists every body, not only the changed ones, and `inspect` with `body` gives one.",
        input_schema = crate::tools::build(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_build(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let full = truthy(args.get("full"));
        match Page::of(&args, if full { 0 } else { budget::ROWS }) {
            Ok(page) => Ok(self.build(full, page).await),
            Err(why) => Ok(failure(why)),
        }
    }

    #[tool(
        name = "inspect",
        description = "Exact measurements of the built bodies. A bare call returns a one-line summary per body (volume, area, bounding box); pass detail:true and selectors:true to also list every face and edge with a ready-made SELECTOR you can paste into the next feature. Also flags seam edges and wrapping faces, which are what fillet and press/pull refuse. With `sketch` it reports that sketch's loose ends instead, the usual reason a sketch shows no closed profile: looseEnds { open: [{entity, p, at}], untied: [{entity, p, at, touches, gap, tieable}] } in sketch mm; `sketch_tie` ties the untied ones. Over 10 bodies alike ones share one row and 30 rows show, with detail or selectors 5 bodies: `offset` pages on, `limit` 0 shows all, `body` or `bodies` picks the ones you need.",
        input_schema = crate::tools::inspect(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_inspect(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.inspect(&args).await)
    }

    #[tool(
        name = "measure",
        description = "Exact measurements on the B-rep, without changing the document. With one thing (`a`): a face's surface, area, normal or radius and axis, an edge's length, direction or circle, a body's volume and size. With two (`a` and `b`): the minimum distance and both closest points, the gap between parallel planar faces (a wall), centre to centre or axis to axis distance (a hole pitch), and the angle between planes, lines and axes. Things are face or edge selectors from `inspect` (detail:true, selectors:true) with their body, {body, face: n} or {body, edge: n}, a body id, or {point: [x, y, z]}. Units mm and degrees, rounded to 3 places, the raw values follow on the `raw:` line.",
        input_schema = crate::tools::measure(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_measure(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.measure(&args).await)
    }

    #[tool(
        name = "view",
        description = "Render the built model as a PNG. Orthographic, flat-shaded, with edges drawn. Use it to check what the numbers cannot tell you. `section` cuts it open, which is the only way to see a bore, a pocket or a thread; `bodies` draws one part of an assembly; `focus` zooms in on a point, which is the only way to see a small feature on a large part.",
        input_schema = crate::tools::view(),
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_view(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        Ok(self.view(&args).await)
    }

    #[tool(
        name = "export",
        description = "Write the model to STEP, STL or 3MF, or one sketch (`sketch`) or flat face (`face`) to DXF or SVG at true size in mm. `separate` writes one file per body, named after the body; `body` writes one body, `bodies` a list of them, merged or with `separate`; `layFlat` turns the parts for printing. Refused if a feature failed to build, naming which, unless allowPartial:true is passed, in which case it writes the file anyway and still names the failures. A long `separate` list folds files of one name and size into one line and shows 30 rows: `offset` pages on, `limit` 0 shows every row, `full` lists every file.",
        input_schema = crate::tools::export(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    pub async fn t_export(&self, args: JsonObject) -> Result<CallToolResult, McpError> {
        let path = match require_str(&args, "path") {
            Ok(p) => match self.scoped(&p).await {
                Ok(p) => p,
                Err(e) => return Ok(e),
            },
            Err(e) => return Ok(e),
        };
        let format = match require_str(&args, "format") {
            Ok(f) => f,
            Err(e) => return Ok(e),
        };
        let full = truthy(args.get("full"));
        let page = match Page::of(&args, if full { 0 } else { budget::ROWS }) {
            Ok(p) => p,
            Err(why) => return Ok(failure(why)),
        };
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Ok(failure(format!("No such directory: {}", parent.display())));
            }
        }
        // The engine writes while building, before a failure is known, so it writes to a TEMPORARY sibling that is
        // moved into place only once the export is accepted; a refusal never touches what is already at `path`.
        let separate = truthy(args.get("separate"));
        let wanted = args.get("body").and_then(Value::as_str).filter(|b| !b.is_empty()).map(str::to_string);
        if separate && wanted.is_some() {
            return Ok(failure(
                "Give `body` or `separate`, not both: one body to one file, or every body to a \
                 file of its own.",
            ));
        }
        let mut listed: Vec<String> = Vec::new();
        if let Some(v) = args.get("bodies").filter(|v| !v.is_null()) {
            let Some(arr) = v.as_array() else {
                return Ok(failure(format!("`bodies` is a list of body ids or names, got {v}")));
            };
            for b in arr {
                match b.as_str().filter(|s| !s.is_empty()) {
                    Some(s) => listed.push(s.to_string()),
                    None => return Ok(failure(format!("`bodies` is a list of body ids or names, got {b}"))),
                }
            }
        }
        let lay_flat = args.get("layFlat").filter(|v| truthy(Some(v))).cloned();
        let flat = matches!(format.to_ascii_lowercase().as_str(), "dxf" | "svg");
        let flat_source: Vec<(&str, Value)> = ["sketch", "face", "tolerance", "svg"]
            .into_iter()
            .filter_map(|k| args.get(k).filter(|v| !v.is_null()).map(|v| (k, v.clone())))
            .collect();
        if flat {
            if separate || wanted.is_some() || !listed.is_empty() || lay_flat.is_some() {
                return Ok(failure(
                    "A DXF or SVG export draws one sketch or one flat face, so it takes `sketch` or                      `face`, not `body`, `bodies`, `separate` or `layFlat`.",
                ));
            }
            if !flat_source.iter().any(|(k, _)| *k == "sketch" || *k == "face") {
                return Ok(failure(
                    "A DXF or SVG export needs `sketch` (a sketch id or name) or `face` (a face                      selector from inspect, with its body).",
                ));
            }
        }
        let (link, mut doc) = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            (st.link.clone(), st.doc.clone())
        };
        let mut ids: Vec<String> = Vec::new();
        let mut laid = String::new();
        if wanted.is_some() || !listed.is_empty() || lay_flat.is_some() {
            let built = match engine_bodies(&link, &doc, None).await {
                Ok(b) => b,
                Err(e) => return Ok(failure(e)),
            };
            for w in listed.iter().chain(wanted.iter()) {
                match find_body(&built, w) {
                    Some(id) if !ids.contains(&id) => ids.push(id),
                    Some(_) => {}
                    None => return Ok(failure(no_such_body(w, &built))),
                }
            }
            if let Some(how) = &lay_flat {
                let only = (!ids.is_empty()).then_some(ids.as_slice());
                match crate::layflat::lay_flat(&link, &mut doc, &built, how, only, separate).await {
                    Ok(note) => laid = note,
                    Err(e) => return Ok(failure(e)),
                }
            }
        }
        // A temporary folder beside `path` holding a file of the same name, since the STEP's top assembly
        // is named after the file; a refusal removes only the folder.
        let tmp_root = temp_sibling(&path);
        if let Err(e) = std::fs::create_dir(&tmp_root) {
            return Ok(failure(format!("Could not write beside {}: {e}", path.display())));
        }
        // A separate export's folder is the path less its extension, split as the engine splits it. A path whose
        // extension is not the format's is the whole folder name, and the parts take the format's extension.
        let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut tmp_name = file_name.clone();
        let mut folder = path.clone();
        if separate {
            let (stem, ext) = split_ext(&file_name);
            if format_exts(&format).contains(&ext.trim_start_matches('.').to_ascii_lowercase().as_str()) {
                folder = path.with_file_name(stem);
            } else {
                tmp_name = format!("{file_name}.{}", format.to_ascii_lowercase());
            }
        }
        let tmp_path = tmp_root.join(&tmp_name);
        let mut payload = call_args([
            ("document", Value::Object(doc)),
            ("format", json!(format)),
            ("path", json!(tmp_path.to_string_lossy())),
        ]);
        if let Some(obj) = payload.as_object_mut() {
            if flat {
                obj.extend(flat_source.iter().map(|(k, v)| ((*k).to_string(), v.clone())));
            }
            if separate {
                obj.insert("separate".into(), json!(true));
            }
            if listed.is_empty() {
                if let Some(id) = ids.first() {
                    obj.insert("body".into(), json!(id));
                }
            } else {
                obj.insert("bodies".into(), json!(ids));
            }
        }
        let discard = || {
            let _ = std::fs::remove_dir_all(&tmp_root);
        };
        let reply = match link.call("export", payload).await {
            Ok(r) => r,
            Err(e) => {
                discard();
                return Ok(engine_gone(&e));
            }
        };
        if reply.get("ok") != Some(&json!(true)) {
            discard();
            return Ok(failure(format!("Export failed: {}", error_message(&reply))));
        }
        let result = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        if let Some(e) = result.get("error") {
            discard();
            return Ok(failure(format!("Export failed: {}", e.get("message").and_then(Value::as_str).unwrap_or("?"))));
        }
        // Only `warnings` entries carrying a `feature_id` key (`wire` always writes it, maybe null) are build
        // failures; the rest are export advisories such as a displacement STEP cannot keep.
        let failed: Vec<Value> = result
            .get("warnings")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|w| w.get("feature_id").is_some()).cloned().collect())
            .unwrap_or_default();
        let failures = feature_failure_lines(&failed);
        if !failures.is_empty() && !truthy(args.get("allowPartial")) {
            discard();
            return Ok(failure(format!(
                "Export refused: {} failed to build, the {format} would be incomplete. Pass \
                 allowPartial:true to write it anyway.\n{}",
                if failures.len() == 1 { "a feature" } else { "features" },
                failures.join("\n")
            )));
        }
        let mut out = if separate {
            match place_files(&result, &folder, page, full) {
                Ok(written) => written,
                Err(e) => {
                    discard();
                    return Ok(failure(e));
                }
            }
        } else {
            if let Err(e) = std::fs::rename(&tmp_path, &path) {
                discard();
                return Ok(failure(format!("Could not write {}: {e}", path.display())));
            }
            let size = std::fs::metadata(&path).map_or(0, |m| m.len());
            format!("Wrote {} ({size} bytes).", path.display())
        };
        discard();
        if !laid.is_empty() {
            out.push('\n');
            out.push_str(&laid);
        }
        if !failures.is_empty() {
            out.push('\n');
            out.push_str(&failures.join("\n"));
        }
        Ok(text(out))
    }
}

/// As `inspect` summarises them (id, name, box); `only` narrows it and asks for every face as well.
pub(crate) async fn engine_bodies(link: &EngineLink, doc: &Doc, only: Option<&[String]>) -> Result<Vec<Value>, String> {
    let mut payload = Map::new();
    payload.insert("document".into(), Value::Object(doc.clone()));
    payload.insert("detail".into(), json!(only.is_some()));
    payload.insert("summary".into(), json!(true));
    if let Some(ids) = only {
        payload.insert("bodies".into(), json!(ids));
    }
    let reply = link
        .call("inspect", Value::Object(payload))
        .await
        .map_err(|e| format!("the geometry engine could not be reached: {e}"))?;
    if reply.get("ok") != Some(&json!(true)) {
        return Err(format!("Could not measure the bodies: {}", error_message(&reply)));
    }
    Ok(reply.get("result").and_then(|r| r.get("bodies")).and_then(Value::as_array).cloned().unwrap_or_default())
}

/// A body named by id or by name, as its id.
pub(crate) fn find_body(built: &[Value], wanted: &str) -> Option<String> {
    let field = |b: &Value, k: &str| b.get(k).and_then(Value::as_str).map(str::to_string);
    built
        .iter()
        .find(|b| field(b, "id").as_deref() == Some(wanted))
        .or_else(|| built.iter().find(|b| field(b, "name").as_deref() == Some(wanted)))
        .and_then(|b| field(b, "id"))
}

pub(crate) fn no_such_body(wanted: &str, built: &[Value]) -> String {
    let have: Vec<String> = built
        .iter()
        .map(|b| {
            let id = b.get("id").and_then(Value::as_str).unwrap_or("?");
            match b.get("name").and_then(Value::as_str) {
                Some(n) if n != id => format!("{id} \"{n}\""),
                _ => id.to_string(),
            }
        })
        .collect();
    format!("no body '{wanted}' in this build, have {}", have.join(", "))
}

/// Replaces files of the same name in `folder` and leaves anything else there alone.
fn place_files(result: &Value, folder: &Path, page: Page, full: bool) -> Result<String, String> {
    let written: Vec<PathBuf> = result
        .get("paths")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
        .unwrap_or_default();
    if folder.exists() && !folder.is_dir() {
        return Err(format!("{} is a file, and a separate export writes a folder of that name.", folder.display()));
    }
    // Every part checked before the first is moved in, so a name that is
    // taken by a folder refuses the export with the old parts untouched.
    if let Some(to) = written.iter().filter_map(|from| Some(folder.join(from.file_name()?))).find(|to| to.is_dir()) {
        return Err(format!("{} is a folder, so the part of that name cannot be written there.", to.display()));
    }
    std::fs::create_dir_all(folder).map_err(|e| format!("Could not make {}: {e}", folder.display()))?;
    let (mut lines, mut sizes) = (Vec::new(), Vec::new());
    for from in &written {
        let Some(name) = from.file_name() else { continue };
        let to = folder.join(name);
        if let Err(e) = std::fs::rename(from, &to) {
            // The ones already moved replaced what was there: say which, or
            // the folder reads as untouched when it now mixes old and new.
            let placed = if lines.is_empty() {
                String::from(" No part was written.")
            } else {
                format!(" These parts were already replaced:\n{}", lines.join("\n"))
            };
            return Err(format!("Could not write {}: {e}.{placed}", to.display()));
        }
        let size = std::fs::metadata(&to).map_or(0, |m| m.len());
        lines.push(format!("  {} ({size} bytes)", name.to_string_lossy()));
        sizes.push((name.to_string_lossy().into_owned(), size));
    }
    let (mut rows, more) = page.cut(budget::files(&sizes, !full), "file rows");
    rows.extend(more.map(|m| format!("  {m}")));
    Ok(format!(
        "Wrote {} file{} to {}:\n{}",
        lines.len(),
        if lines.len() == 1 { "" } else { "s" },
        folder.display(),
        rows.join("\n")
    ))
}

/// A file name split as the engine splits it (Python's os.path.splitext):
/// leading dots are part of the name, the extension keeps its dot.
fn split_ext(name: &str) -> (&str, &str) {
    let lead = name.len() - name.trim_start_matches('.').len();
    match name[lead..].rfind('.') {
        Some(dot) => name.split_at(lead + dot),
        None => (name, ""),
    }
}

fn format_exts(format: &str) -> &'static [&'static str] {
    match format.to_ascii_lowercase().as_str() {
        "step" | "stp" => &["step", "stp"],
        "stl" => &["stl"],
        "3mf" => &["3mf"],
        "dxf" => &["dxf"],
        "svg" => &["svg"],
        _ => &[],
    }
}

/// Beside `path`, so moving out never crosses a filesystem and removing it never touches `path`;
/// the pid in the name keeps two agents exporting to one path apart.
fn temp_sibling(path: &Path) -> PathBuf {
    let pid = std::process::id();
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("export");
    let dir = path.with_file_name(format!(".{name}.partial-{pid}"));
    // Left by an export this process never finished; nobody else's.
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn error_message(reply: &Value) -> String {
    reply.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("?").to_string()
}

/// The fields the patch named with their values now, not the whole feature, which for a sketch is pages of points.
fn updated_line(id: &str, feature: &Value, patch: &Value, replace: bool) -> String {
    let kind = feature.get("type").and_then(Value::as_str).unwrap_or("None");
    if replace {
        return format!("Replaced {id} ({kind}).");
    }
    let fields: Vec<String> = patch
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, _)| match feature.get(k) {
            Some(v) => format!("{k} = {}", clipped(&py_json(v), 80)),
            None => format!("{k} removed"),
        })
        .collect();
    if fields.is_empty() {
        format!("Updated {id} ({kind}): nothing in the patch.")
    } else {
        format!("Updated {id} ({kind}): {}.", fields.join(", "))
    }
}

fn clipped(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}...")
}

/// Python's `json.dumps(v)`, a space after every colon and comma, so both servers word the line
/// an agent reads after every edit the same way.
pub(crate) fn py_json(v: &Value) -> String {
    match v {
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, val)| format!("{}: {}", Value::String(k.clone()), py_json(val)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Array(a) => format!("[{}]", a.iter().map(py_json).collect::<Vec<_>>().join(", ")),
        other => other.to_string(),
    }
}

/// `json.dumps(v, indent=n)`, which is two things serde_json's PrettyFormatter
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

impl FundaCad {
    /// `Err` only when the engine could not even attempt the document. A feature that failed mid-build is
    /// `ok:true` with `featureErrors`, read by `feature_failure_lines`.
    async fn rebuild(&self) -> Result<Rebuilt, CallToolResult> {
        let (link, doc) = {
            let mut st = self.state.lock().await;
            let problems = model::validate(&mut st.doc);
            (st.link.clone(), (st.doc.clone(), problems))
        };
        let (document, problems) = doc;
        let (reply, framed) = match link
            .call_meshed(
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
            Err(e) => return Err(engine_gone(&e)),
        };
        if reply.get("ok") != Some(&json!(true)) {
            let where_ = reply
                .get("error")
                .and_then(|e| e.get("feature_id"))
                .and_then(Value::as_str)
                .map(|w| format!(" at {w}"))
                .unwrap_or_default();
            let err =
                reply.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("unknown error");
            return Err(failure(format!("Build failed{where_}: {err}{}", open_profile_hint(err))));
        }
        let result = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        let mesh = Arc::new(if framed.is_empty() {
            result
                .get("bodies")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(MeshBody::from_value)
                .collect()
        } else {
            framed
        });
        {
            let mut st = self.state.lock().await;
            if let Some(ids) = result.get("bodyIds") {
                st.doc.insert("bodyIds".into(), ids.clone());
            }
            if let Some(tracked) = result.get("trackedFaces").and_then(Value::as_object) {
                model::write_tracked_faces(&mut st.doc, tracked);
            }
            st.mesh = mesh.clone();
            st.built_for = Some(signature(&st.doc));
        }
        Ok(Rebuilt { link, document, result, mesh, problems })
    }

    async fn build(&self, full: bool, page: Page) -> CallToolResult {
        let Rebuilt { link, document, result, mesh, problems } = match self.rebuild().await {
            Ok(r) => r,
            Err(e) => return e,
        };
        // Sizes come from a second call: the mesh bbox includes the shape's gap tolerance, large after an offset or a
        // thicken (48.41 x 52.03 x 24.45 measured on an exact 36.57 x 36.57 x 21.45 box).
        let mut exact: HashMap<String, Value> = HashMap::new();
        if let Ok(deep) =
            link.call("inspect", call_args([("document", Value::Object(document)), ("detail", json!(false))])).await
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
        let mut bodies: Vec<(String, String, u64)> = Vec::new();
        let mut names: HashMap<String, String> = HashMap::new();
        for b in mesh.iter() {
            let id = b.id();
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
                            .map(|(a, b)| json!(round3(b.as_f64().unwrap_or(0.0) - a.as_f64().unwrap_or(0.0))))
                            .collect(),
                        _ => vec![json!(0.0), json!(0.0), json!(0.0)],
                    }
                }
            };
            let vol = match e.get("volume").and_then(Value::as_f64).filter(|v| *v != 0.0) {
                Some(v) => format!(", vol {} mm3", describe::g_format(v)),
                None => String::new(),
            };
            let triangles = b.triangles();
            names.insert(id.to_string(), b.get("name").and_then(Value::as_str).map_or("None".into(), str::to_string));
            bodies.push((
                id.to_string(),
                format!(
                    "{id} \"{}\": {} x {} x {} mm{vol}, {} faces, {triangles} triangles",
                    b.get("name").and_then(Value::as_str).map_or("None".into(), str::to_string),
                    py_num(size.first()),
                    py_num(size.get(1)),
                    py_num(size.get(2)),
                    py_num(b.get("faceCount"))
                ),
                shape_print(b),
            ));
        }
        let (rows, tail) = self.changed_bodies(&bodies, full).await;
        let listed = rows.len();
        let rows = budget::fold(
            rows.into_iter()
                .map(|(id, line)| {
                    let name = names.get(&id).cloned().unwrap_or_default();
                    budget::Row::of_line(id, name, line)
                })
                .collect(),
        );
        let (shown, more) = page.cut_asking(rows, "rows", if full { "" } else { "full true and " });
        let mut lines = Vec::new();
        if listed > budget::FOLD_FROM {
            lines.push(format!(
                "{listed} bodies{}, alike ones in one row:",
                if listed < bodies.len() { " changed" } else { "" }
            ));
        }
        lines.extend(shown);
        lines.extend(more);
        lines.extend(tail);
        // `featureErrors`, NOT `errors`: a failed feature is a no-op and the rebuild succeeds around it,
        // so the wrong key made a failed press/pull look like one that did nothing.
        let failures =
            feature_failure_lines(result.get("featureErrors").and_then(Value::as_array).map_or(&[][..], Vec::as_slice));
        let skips = skipped_lines(&result);
        // A skip makes the model incomplete, so it counts as a failure for isError.
        let any_feature_failed = !failures.is_empty() || !skips.is_empty();
        lines.extend(failures);
        lines.extend(skips);
        for d in result.get("diagnostics").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
            // The engine's advisories carry their text as `reason`, the lossy
            // entries are selector match notes an agent cannot act on.
            let advisory = d.get("lossy") == Some(&json!(false));
            let note = d
                .get("message")
                .or_else(|| d.get("reason").filter(|_| advisory))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| stale_match_line(d));
            if let Some(m) = note {
                let at = d.get("feature_id").and_then(Value::as_str).map_or(String::new(), |id| format!(" ({id})"));
                lines.push(format!("warning{at}: {m}"));
            }
        }
        if mesh.is_empty() {
            lines.push("No bodies were produced.".into());
        }
        if lines.is_empty() {
            lines.push("Built, nothing failed.".into());
        }
        if !problems.is_empty() {
            lines.push(format!("document problems: {}", problems.join("; ")));
        }
        lines.extend(self.build_mismatch().await);
        // isError reflects a partial build too, so an agent gating on it need not string match "FEATURE FAILED".
        let full = lines.join("\n");
        if any_feature_failed {
            failure(full)
        } else {
            text(full)
        }
    }

    /// All of them the first time and when asked, else the new, changed and gone bodies and a count of the rest.
    async fn changed_bodies(
        &self,
        bodies: &[(String, String, u64)],
        full: bool,
    ) -> (Vec<(String, String)>, Vec<String>) {
        let previous = {
            let mut st = self.state.lock().await;
            st.reported.replace(bodies.iter().map(|(id, line, print)| (id.clone(), (line.clone(), *print))).collect())
        };
        let previous = match previous {
            Some(p) if !full => p,
            _ => return (bodies.iter().map(|(id, line, _)| (id.clone(), line.clone())).collect(), Vec::new()),
        };
        let mut rows: Vec<(String, String)> = Vec::new();
        for (id, line, print) in bodies {
            match previous.get(id) {
                Some((was, p)) if was == line && p == print => {}
                // Same size, volume and counts but different geometry: moved, turned, or a hole moved inside it.
                Some((was, _)) if was == line => {
                    rows.push((id.clone(), format!("{line} (moved or reshaped, same size)")))
                }
                _ => rows.push((id.clone(), line.clone())),
            }
        }
        let shown = rows.len();
        let mut out: Vec<String> = Vec::new();
        let mut gone: Vec<&String> = previous.keys().filter(|id| !bodies.iter().any(|(b, _, _)| b == *id)).collect();
        gone.sort_by(|a, b| budget::natural(a, b));
        if !gone.is_empty() {
            out.push(format!(
                "gone since the last build: {}",
                budget::ranges(&gone.iter().map(|s| s.as_str()).collect::<Vec<_>>(), false)
            ));
        }
        let same = bodies.len() - shown;
        if same > 0 {
            out.push(format!(
                "{} {} unchanged{}",
                if shown == 0 { "all".to_string() } else { format!("{same} other") },
                if same == 1 && shown > 0 { "body" } else { "bodies" },
                if shown == 0 { format!(" ({same})") } else { String::new() }
            ));
        }
        (rows, out)
    }

    async fn inspect(&self, args: &JsonObject) -> CallToolResult {
        if let Some(sketch) = args.get("sketch").and_then(Value::as_str) {
            let tol = match tolerance_arg(args) {
                Ok(t) => t,
                Err(why) => return failure(why),
            };
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            return match crate::looseends::find(&st.doc, sketch, tol) {
                Ok(le) => text(crate::looseends::summary(sketch, &le)),
                Err(why) => failure(why),
            };
        }
        let (link, doc) = {
            let st = self.state.lock().await;
            (st.link.clone(), st.doc.clone())
        };
        let want_faces = index_set(args.get("faces"));
        let want_edges = index_set(args.get("edges"));
        let selectors = args.get("selectors").and_then(Value::as_bool).unwrap_or(false);
        let detail = args.get("detail").and_then(Value::as_bool).unwrap_or(false)
            || want_faces.is_some()
            || want_edges.is_some();
        let deep = detail || selectors;
        let page = match Page::of(args, if deep { budget::DETAIL_BODIES } else { budget::ROWS }) {
            Ok(p) => p,
            Err(why) => return failure(why),
        };
        let mut wanted: Vec<String> = args
            .get("bodies")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if let Some(body) = args.get("body").and_then(Value::as_str) {
            wanted.push(body.to_string());
        }
        let call = |detail: bool, bodies: &[String]| {
            let mut payload = Map::new();
            payload.insert("document".into(), Value::Object(doc.clone()));
            // The summary is counts and flags the engine keeps per body, where
            // detail measures and fingerprints every face and edge of every body.
            payload.insert("detail".into(), json!(detail));
            payload.insert("summary".into(), json!(true));
            if !bodies.is_empty() {
                payload.insert("bodies".into(), json!(bodies));
            }
            Value::Object(payload)
        };
        // Every face of three thousand bodies is megabytes, so detail is measured for one page of them.
        let mut paged = None;
        if deep && wanted.is_empty() {
            let ids: Vec<String> = match link.call("inspect", call(false, &[])).await {
                Ok(r) => r
                    .get("result")
                    .and_then(|r| r.get("bodies"))
                    .and_then(Value::as_array)
                    .map_or(&[][..], Vec::as_slice)
                    .iter()
                    .filter_map(|b| b.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect(),
                Err(e) => return engine_gone(&e),
            };
            let (ids, line) = page.cut(ids, "bodies");
            if let Some(line) = line {
                if ids.is_empty() {
                    return text(line);
                }
                paged = Some(if line.contains(": pass ") { format!("{line}, or name one with `body`") } else { line });
                wanted = ids;
            }
        }
        let reply = match link.call("inspect", call(deep, &wanted)).await {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            return failure(format!("Inspect failed: {}", error_message(&reply)));
        }
        let mut report = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        if let Some(wanted) =
            report.get("unknown").and_then(Value::as_array).and_then(|u| u.first()).and_then(Value::as_str)
        {
            let have = report.get("have").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
            return failure(if have.is_empty() {
                format!("no body '{wanted}', this build made no bodies")
            } else {
                no_such_body(wanted, have)
            });
        }
        // `errors` is inspect's name for `rebuild`'s `featureErrors`, reported beside the bodies that did build.
        let failures =
            feature_failure_lines(report.get("errors").and_then(Value::as_array).map_or(&[][..], Vec::as_slice));
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
        let (rows, errors) = describe::rows(&report, detail);
        let listed = rows.len();
        let rows = if deep { rows.into_iter().map(|r| r.text).collect() } else { budget::fold(rows) };
        let (rows, more) = if deep { (rows, paged) } else { page.cut(rows, "rows") };
        let mut lines = Vec::new();
        if listed > budget::FOLD_FROM && !deep {
            lines.push(format!("{listed} bodies, alike ones in one row:"));
        }
        lines.extend(rows);
        if listed == 0 {
            lines.push(describe::NO_BODIES.into());
        }
        lines.extend(errors);
        lines.extend(more);
        let mut out = lines.join("\n");
        if selectors {
            let mut sel = Map::new();
            for b in report.get("bodies").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
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
                    b.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    json!({"faces": faces, "edges": edges}),
                );
            }
            out.push_str("\n\nselectors:\n");
            out.push_str(&budget::selector_json(&sel));
        }
        if !failures.is_empty() {
            out.push('\n');
            out.push_str(&failures.join("\n"));
        }
        text(out)
    }

    async fn view(&self, args: &JsonObject) -> CallToolResult {
        let camera = match view_camera(args) {
            Ok(c) => c,
            Err(e) => return e,
        };
        let stale = {
            let st = self.state.lock().await;
            st.mesh.is_empty() || st.built_for.as_deref() != Some(&signature(&st.doc))
        };
        let mut build_failures = String::new();
        if stale {
            // Only a total engine failure refuses: after a feature failed mid-rebuild, what DID build is still drawn
            // and the rest named, since looking is how an agent checks its work.
            let r = match self.rebuild().await {
                Ok(r) => r,
                Err(e) => return e,
            };
            let mut lines = feature_failure_lines(
                r.result.get("featureErrors").and_then(Value::as_array).map_or(&[][..], Vec::as_slice),
            );
            lines.extend(skipped_lines(&r.result));
            build_failures = lines.join("\n");
        }
        let mesh = {
            let st = self.state.lock().await;
            st.mesh.clone()
        };
        if mesh.is_empty() {
            return failure("Nothing to render: the document produced no bodies.");
        }
        let w =
            args.get("width").and_then(Value::as_i64).filter(|n| *n != 0).unwrap_or(640).clamp(64, MAX_IMAGE_PX) as u32;
        let h = args.get("height").and_then(Value::as_i64).filter(|n| *n != 0).unwrap_or(480).clamp(64, MAX_IMAGE_PX)
            as u32;
        let highlight = match index_set(args.get("highlight_faces")) {
            Some(faces) if !faces.is_empty() => {
                let body = args
                    .get("highlight_body")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| mesh[0].get("id").and_then(Value::as_str).unwrap_or_default().to_string());
                Some((body, faces))
            }
            _ => None,
        };
        // Empty is absent: `bodies: []` draws everything and `section: {}` cuts nothing, and both must READ that way.
        let bodies = args
            .get("bodies")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>());
        if let Some(list) = &bodies {
            let known: Vec<&str> = mesh.iter().map(MeshBody::id).collect();
            let unknown: Vec<&String> = list.iter().filter(|id| !known.contains(&id.as_str())).collect();
            if !unknown.is_empty() {
                return failure(format!(
                    "no body {} in this build, have [{}]",
                    unknown.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", "),
                    known.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ")
                ));
            }
        }
        let section = args.get("section").filter(|s| truthy(Some(s))).cloned().unwrap_or(Value::Null);
        let request = ViewRequest {
            width: w,
            height: h,
            view: Some(camera.view.clone()),
            azimuth: camera.angles.map(|a| a.0),
            elevation: camera.angles.map(|a| a.1),
            highlight,
            section: section.clone(),
            bodies: bodies.clone(),
            focus: args.get("focus").cloned().unwrap_or(Value::Null),
            draw_edges: true,
            color_bar: false,
        };
        let canvas = match render::render(&mesh[..], &request) {
            Ok(c) => c,
            Err(e) => return failure(e),
        };
        let png = match crate::png::encode(&canvas) {
            Ok(p) => p,
            Err(e) => return failure(e),
        };
        let where_ = match camera.angles {
            Some(_) => {
                let given = |long: &str, short: &str| {
                    py_num(args.get(long).filter(|v| !v.is_null()).or(args.get(short)).or(Some(&json!(0))))
                };
                format!("az {} el {}", given("azimuth", "az"), given("elevation", "el"))
            }
            None => camera.view.clone(),
        };
        let shown: Vec<String> = bodies.unwrap_or_else(|| mesh.iter().map(|b| b.id().to_string()).collect());
        let cut = if section.is_null() {
            String::new()
        } else {
            // The side actually kept, resolved as the renderer resolves it, not the word passed in.
            let keep = section.get("keep").and_then(Value::as_str).unwrap_or("below").trim().to_ascii_lowercase();
            let side = if render::keep_word(&keep).unwrap_or(false) { "above" } else { "below" };
            format!(
                ", cut on {} at {}, keeping {side}",
                section.get("axis").map_or("X".to_string(), |a| py_num(Some(a))),
                section.get("at").map_or("the middle".to_string(), |a| py_num(Some(a)))
            )
        };
        let who = if shown.len() > budget::FOLD_FROM {
            budget::ranges(&shown.iter().map(String::as_str).collect::<Vec<_>>(), false)
        } else {
            shown.join(", ")
        };
        let mut caption = format!("{where_} view of {who}, {w}x{h}{cut}");
        if !build_failures.is_empty() {
            caption.push('\n');
            caption.push_str(&build_failures);
        }
        CallToolResult::success(vec![
            ContentBlock::text(caption),
            ContentBlock::image(base64::engine::general_purpose::STANDARD.encode(&png), "image/png"),
        ])
    }
}

/// Refused by name, since an ignored `view {az: 180}` drew the default iso and looked like it had worked.
fn unknown_arguments(name: &str, tool: &rmcp::model::Tool, args: &JsonObject) -> Option<CallToolResult> {
    let known = tool.input_schema.get("properties").and_then(Value::as_object)?;
    let unknown: Vec<&String> = args.keys().filter(|k| !known.contains_key(k.as_str())).collect();
    if unknown.is_empty() {
        return None;
    }
    let mut have: Vec<&String> = known.keys().collect();
    have.sort();
    let list = |v: &[&String]| v.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ");
    Some(failure(format!(
        "{name} takes no {} {}, nothing was done. It takes {}.",
        if unknown.len() == 1 { "argument" } else { "arguments" },
        list(&unknown),
        if have.is_empty() { "no arguments".to_string() } else { list(&have) }
    )))
}

struct Camera {
    view: String,
    angles: Option<(f64, f64)>,
}

/// `az` and `el` are taken as the short spellings they are. A non-numeric angle or an unknown view name
/// is refused rather than quietly replaced by the default iso.
fn view_camera(args: &JsonObject) -> Result<Camera, CallToolResult> {
    let angle = |long: &str, short: &str| -> Result<Option<f64>, CallToolResult> {
        let (key, v) = match (args.get(long), args.get(short)) {
            (Some(v), _) if !v.is_null() => (long, v),
            (_, Some(v)) if !v.is_null() => (short, v),
            _ => return Ok(None),
        };
        let n = match v {
            Value::Number(n) => n.as_f64(),
            Value::String(t) => t.trim().parse::<f64>().ok(),
            _ => None,
        };
        match n.filter(|f| f.is_finite()) {
            Some(f) => Ok(Some(f)),
            None => Err(failure(format!("`{key}` has to be a number of degrees, got {v}"))),
        }
    };
    let az = angle("azimuth", "az")?;
    let el = angle("elevation", "el")?;
    let view = match args.get("view").and_then(Value::as_str) {
        Some(v) => {
            let name = v.trim().to_ascii_lowercase();
            if !render::NAMED_VIEWS.iter().any(|(n, _)| *n == name) {
                return Err(failure(format!(
                    "no view '{v}', have {}, or give azimuth and elevation in degrees",
                    render::NAMED_VIEWS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")
                )));
            }
            name
        }
        None => "iso".into(),
    };
    let angles = (az.is_some() || el.is_some()).then(|| (az.unwrap_or(0.0), el.unwrap_or(0.0)));
    Ok(Camera { view, angles })
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn tolerance_arg(args: &JsonObject) -> Result<Option<f64>, String> {
    match args.get("tolerance").filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|t| t.is_finite() && *t > 0.0)
            .map(Some)
            .ok_or_else(|| format!("`tolerance` is a distance in mm, more than 0, got {v}")),
    }
}

fn index_set(v: Option<&Value>) -> Option<Vec<i64>> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_i64).collect())
}

fn keep_indices(body: &mut Value, key: &str, want: &[i64]) {
    if let Some(list) = body.get_mut(key).and_then(Value::as_array_mut) {
        list.retain(|e| e.get("i").and_then(Value::as_i64).is_some_and(|i| want.contains(&i)));
    }
}

impl FundaCad {
    async fn edit(&self, args: &JsonObject) -> CallToolResult {
        let ops = match args.get("ops").and_then(Value::as_array) {
            Some(o) if !o.is_empty() => o.clone(),
            _ => return failure("`ops` needs at least one edit."),
        };
        let head = {
            let mut st = self.state.lock().await;
            // On a copy: the document only changes if every entry applies.
            let mut doc = st.doc.clone();
            let mut done = Vec::new();
            let mut notes = Vec::new();
            for (n, entry) in ops.iter().enumerate() {
                match crate::edits::apply(&mut doc, entry, &mut notes) {
                    Ok(d) => done.push(d),
                    Err(why) => return failure(crate::edits::refused(n + 1, ops.len(), entry, &why)),
                }
            }
            st.doc = doc;
            st.invalidate();
            st.state_line(&crate::shortcuts::noted(&crate::edits::summary(&done), &notes))
        };
        self.then_build(head, args).await
    }

    /// `head`, and a build after it when the call asked for one.
    async fn then_build(&self, head: String, args: &JsonObject) -> CallToolResult {
        if !truthy(args.get("build")) {
            return text(head);
        }
        let built = self.build(false, Page { offset: 0, limit: budget::ROWS }).await;
        let body = built
            .content
            .iter()
            .filter_map(|c| match c {
                ContentBlock::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let all = format!("{head}\nbuild:\n{body}");
        if is_error(&built) {
            failure(all)
        } else {
            text(all)
        }
    }

    async fn sketch_merge(&self, args: &JsonObject) -> CallToolResult {
        let (link, doc, plan) = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            match crate::sketchmerge::plan(&st.doc, args) {
                Ok(p) => (st.link.clone(), st.doc.clone(), p),
                Err(why) => return failure(why),
            }
        };
        let before = model::find_feature(&doc, &plan.sketch).map(|(_, f)| f.clone());
        let payload = json!({"document": doc, "sketch": plan.sketch, "entities": plan.ids});
        let outline = match link.call("sketchOutline", payload).await {
            Err(e) => return engine_gone(&e),
            Ok(r) if r.get("ok") != Some(&json!(true)) => {
                return failure(format!("Could not merge: {}", error_message(&r)))
            }
            Ok(r) => r.get("result").cloned().unwrap_or_else(|| json!({})),
        };
        let head = {
            let mut st = self.state.lock().await;
            if model::find_feature(&st.doc, &plan.sketch).map(|(_, f)| f.clone()) != before {
                return failure(format!(
                    "{} changed while it was being merged, so nothing was merged. Try again",
                    plan.sketch
                ));
            }
            let merged = match crate::sketchmerge::apply(&mut st.doc, &plan, &outline) {
                Ok(m) => m,
                Err(why) => return failure(why),
            };
            st.invalidate();
            st.state_line(&crate::sketchmerge::reply(&plan, &merged))
        };
        self.then_build(head, args).await
    }

    async fn sketch_tie(&self, args: &JsonObject) -> CallToolResult {
        let Some(sketch) = args.get("sketch").and_then(Value::as_str) else {
            return failure("`sketch` is the id of the sketch whose loose ends to tie");
        };
        let tol = match tolerance_arg(args) {
            Ok(t) => t,
            Err(why) => return failure(why),
        };
        let head = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            let tied = match crate::looseends::tie(&mut st.doc, sketch, tol) {
                Ok(t) => t,
                Err(why) => return failure(why),
            };
            if !tied.added.is_empty() {
                st.invalidate();
            }
            let mut line = format!(
                "tied {} loose end{} in {sketch}",
                tied.added.len(),
                if tied.added.len() == 1 { "" } else { "s" }
            );
            if !tied.skipped.is_empty() {
                line.push_str(&format!(", could not move {}", tied.skipped.join(", ")));
            }
            line.push('\n');
            line.push_str(&crate::looseends::summary(sketch, &tied.left));
            st.state_line(&line)
        };
        self.then_build(head, args).await
    }

    async fn interference(&self, args: &JsonObject) -> CallToolResult {
        let clearance = match args.get("clearance").filter(|v| !v.is_null()) {
            None => crate::clash::DEFAULT_CLEARANCE,
            Some(v) => match v.as_f64().filter(|c| c.is_finite() && *c >= 0.0) {
                Some(c) => c,
                None => return failure(format!("`clearance` is a distance in mm, 0 or more, got {v}")),
            },
        };
        let full = truthy(args.get("full"));
        let page = match Page::of(args, if full { 0 } else { budget::ROWS }) {
            Ok(p) => p,
            Err(why) => return failure(why),
        };
        let bodies: Vec<String> = args
            .get("bodies")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let sweep = match args.get("sweep").filter(|v| !v.is_null()) {
            None => None,
            Some(v) => match crate::clash::sweep_of(v) {
                Ok(s) => Some(s),
                Err(e) => return failure(e),
            },
        };
        let (link, doc) = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            (st.link.clone(), st.doc.clone())
        };
        let ask = |document: Doc| {
            let mut payload = Map::new();
            payload.insert("document".into(), Value::Object(document));
            payload.insert("clearance".into(), json!(clearance));
            if !bodies.is_empty() {
                payload.insert("bodies".into(), json!(bodies));
            }
            let link = link.clone();
            async move {
                match link.call("interference", Value::Object(payload)).await {
                    Err(e) => Err(format!("the geometry engine could not be reached: {e}")),
                    Ok(reply) if reply.get("ok") != Some(&json!(true)) => {
                        Err(format!("the check failed: {}", error_message(&reply)))
                    }
                    Ok(reply) => {
                        let r = reply.get("result").cloned().unwrap_or_else(|| json!({}));
                        match r.get("error") {
                            // Nothing built at all: the engine names the
                            // feature that stopped it.
                            Some(e) => Err(format!(
                                "nothing built, {}",
                                e.get("message").and_then(Value::as_str).unwrap_or("no bodies")
                            )),
                            None => Ok(r),
                        }
                    }
                }
            }
        };
        let unknown = |r: &Value| -> Option<CallToolResult> {
            if bodies.is_empty() {
                return None;
            }
            let missing = crate::clash::missing(r, &bodies);
            (!missing.is_empty()).then(|| {
                let names = missing.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(", ");
                let failed = crate::clash::failures(r);
                let mut why = format!("no body {names} in this build. Check the ids or names against `build`.");
                if !failed.is_empty() {
                    // Maybe the name is right and its feature failed.
                    why.push_str(" Some features failed, which may be why:\n");
                    why.push_str(&failed.join("\n"));
                }
                failure(why)
            })
        };

        let Some(sweep) = sweep else {
            let r = match ask(doc).await {
                Ok(r) => r,
                Err(e) => return failure(e),
            };
            if let Some(refusal) = unknown(&r) {
                return refusal;
            }
            let mut out = crate::clash::report(&r, clearance, page, full);
            let failed = crate::clash::failures(&r);
            if !failed.is_empty() {
                out.push_str("\nSome features failed, so this checked what did build:\n");
                out.push_str(&failed.join("\n"));
            }
            return text(out);
        };

        let defs = model::param_defs(&doc);
        let Some(def) = defs.get(&sweep.param) else {
            let mut have: Vec<&String> = defs.keys().collect();
            have.sort();
            return failure(format!(
                "no parameter '{}' to sweep, have [{}]",
                sweep.param,
                have.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ")
            ));
        };
        let unit = def.get("unit").and_then(Value::as_str).unwrap_or("mm").to_string();
        let mut steps: Vec<crate::clash::Step> = Vec::new();
        for value in &sweep.values {
            let mut d = doc.clone();
            let reply = match model::set_parameter(&mut d, &sweep.param, &json!(value), &unit, None) {
                Err(e) => Err(e.to_string()),
                Ok(_) => ask(d).await,
            };
            steps.push(crate::clash::Step { value: *value, reply });
        }
        let report = crate::clash::sweep_report(&sweep.param, &unit, &steps, clearance, &bodies);
        let built: Vec<&Value> = steps.iter().filter_map(|s| s.reply.as_ref().ok()).collect();
        if built.is_empty() {
            return failure(report);
        }
        // Missing at every step that built means no step checked what was asked. Missing at some (a failed feature,
        // a join that merged it away) is a note on those steps and in the summary.
        let never: Vec<String> = crate::clash::missing(built[0], &bodies)
            .into_iter()
            .filter(|b| built.iter().all(|r| crate::clash::missing(r, &bodies).contains(b)))
            .collect();
        if !never.is_empty() {
            let failed = built.iter().any(|r| !crate::clash::failures(r).is_empty());
            return failure(format!(
                "no body {} at any step of the sweep. Check the ids or names against `build`{}.\n{report}",
                never.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(", "),
                if failed { ", and the failed features below, which may be why" } else { "" }
            ));
        }
        text(report)
    }
}

impl FundaCad {
    async fn section(&self, args: &JsonObject) -> CallToolResult {
        let plane = match crate::section::plane_of(args) {
            Ok(p) => p,
            Err(e) => return failure(e),
        };
        let wanted: Vec<String> = args
            .get("bodies")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let full = truthy(args.get("full"));
        let page = match Page::of(args, 0) {
            Ok(p) => p,
            Err(e) => return failure(e),
        };
        let limit_given = args.get("limit").is_some_and(|v| !v.is_null());
        let asked_outline = args.get("outline").and_then(Value::as_bool);
        let (link, doc) = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            (st.link.clone(), st.doc.clone())
        };
        // Its own, finer mesh: the build's is meant for looking at, and a
        // circle drawn with it is a few percent short of its area.
        let (reply, framed) = match link
            .call_meshed(
                "rebuild",
                call_args([
                    ("document", Value::Object(doc.clone())),
                    ("revision", json!(1)),
                    ("tolerance", json!(crate::section::TOLERANCE)),
                ]),
            )
            .await
        {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            return failure(format!("Build failed: {}", error_message(&reply)));
        }
        let result = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        let bodies = meshed_bodies(&result, framed);
        let name_of = |b: &MeshBody| b.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let missing: Vec<&String> =
            wanted.iter().filter(|w| !bodies.iter().any(|b| b.id() == w.as_str() || name_of(b) == **w)).collect();
        if !missing.is_empty() {
            return failure(format!(
                "no body {} in this build. Check the ids or names against `build`.",
                missing.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(", ")
            ));
        }
        let mut cuts = Vec::new();
        let mut missed = Vec::new();
        for b in &bodies {
            if !wanted.is_empty() && !wanted.iter().any(|w| w == b.id() || *w == name_of(b)) {
                continue;
            }
            let cut = crate::section::cut(b, &plane);
            if cut.loops.is_empty() && cut.open.is_empty() {
                missed.push(b.id().to_string());
                continue;
            }
            cuts.push((b, cut));
        }
        let long = cuts.len() > budget::FOLD_FROM;
        let outline = asked_outline.unwrap_or(full || !long);
        let page = if limit_given || full {
            page
        } else {
            Page { limit: if outline && long { budget::DETAIL_BODIES } else { budget::ROWS }, ..page }
        };
        let cut_ids: Vec<String> = cuts.iter().map(|(b, _)| b.id().to_string()).collect();
        // A section is read off the mesh, which draws a body that is not a
        // closed solid as readily as one that is: only the exact shape knows.
        let unsound = Self::unsound(&link, doc, &cut_ids).await;
        let mut area = 0.0;
        let mut rows = Vec::new();
        for (b, cut) in &cuts {
            let id = b.id();
            area += crate::section::properties(&cut.loops).area;
            let mut text = crate::section::report(id, &name_of(b), &plane, cut, outline);
            let mut same = if full || !long { String::new() } else { crate::section::alike(&plane, cut, outline) };
            if let Some(why) = unsound.get(id) {
                text.push_str(&format!(
                    "\n  NOT A SOUND SOLID: {id} {why}. This section can miss material or count a hole as material"
                ));
                same.push_str(&format!("\nunsound: {why}"));
            }
            rows.push(budget::Row { id: id.to_string(), name: name_of(b), same, text });
        }
        let mut out = format!("Section on {}, in-plane axes {} and {}:", plane.label, plane.axes.0, plane.axes.1);
        if rows.is_empty() {
            out.push_str("\nThe plane misses every body.");
        } else {
            let left_out = long && !outline && asked_outline.is_none();
            out.push('\n');
            out.push_str(&crate::section::listing(rows, area, page, full, left_out).join("\n"));
        }
        if !missed.is_empty() && !wanted.is_empty() {
            out.push_str(&format!("\nThe plane misses {}.", missed.join(", ")));
        }
        let mut failures =
            feature_failure_lines(result.get("featureErrors").and_then(Value::as_array).map_or(&[][..], Vec::as_slice));
        failures.extend(skipped_lines(&result));
        if !failures.is_empty() {
            out.push_str("\nSome features failed, so this cut what did build:\n");
            out.push_str(&failures.join("\n"));
        }
        text(out)
    }
}

impl FundaCad {
    async fn measure(&self, args: &JsonObject) -> CallToolResult {
        let mut payload = match crate::measure::request_of(args) {
            Ok(p) => p,
            Err(e) => return failure(e),
        };
        let (link, doc) = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            (st.link.clone(), st.doc.clone())
        };
        payload.insert("document".into(), Value::Object(doc));
        let reply = match link.call("measure", Value::Object(payload)).await {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            return failure(format!("Could not measure: {}", error_message(&reply)));
        }
        let r = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        text(crate::measure::report(&r))
    }

    async fn stress(&self, args: &JsonObject) -> CallToolResult {
        let request = match crate::stress::request_of(args) {
            Ok(r) => r,
            Err(e) => return failure(e),
        };
        let camera = match view_camera(args) {
            Ok(c) => c,
            Err(e) => return e,
        };
        let side = |key: &str, default: i64| {
            args.get(key).and_then(Value::as_i64).filter(|n| *n != 0).unwrap_or(default).clamp(64, MAX_IMAGE_PX) as u32
        };
        let (w, h) = (side("width", 640), side("height", 480));
        let wanted = request.payload.get("body").and_then(Value::as_str).unwrap_or_default().to_string();
        let (link, doc) = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            (st.link.clone(), st.doc.clone())
        };
        let mut payload = request.payload;
        payload.insert("document".into(), Value::Object(doc.clone()));
        let reply = match link.call("stress", Value::Object(payload)).await {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            let why = error_message(&reply);
            // The body may be missing because a feature failed: say which
            // bodies there are and every failure, not only the first.
            if let Some(refusal) = Self::missing_body(&link, &doc, &wanted).await {
                return refusal;
            }
            return failure(format!("The analysis was refused: {why}"));
        }
        let r = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        let mut out = crate::stress::report(&r, &request.supports);
        let failed = crate::clash::failures(&r);
        if !failed.is_empty() {
            out.push_str("\nSome features failed, so this analysed what did build:\n");
            out.push_str(&failed.join("\n"));
        }
        if !request.image {
            return text(out);
        }
        let Some(surface) = crate::stress::surface_of(&r) else {
            out.push_str("\nNo picture: the reply carried no surface to draw.");
            return text(out);
        };
        let view = ViewRequest {
            width: w,
            height: h,
            view: Some(camera.view.clone()),
            azimuth: camera.angles.map(|a| a.0),
            elevation: camera.angles.map(|a| a.1),
            draw_edges: true,
            color_bar: true,
            ..ViewRequest::default()
        };
        let png = match render::render(std::slice::from_ref(&surface), &view).and_then(|c| crate::png::encode(&c)) {
            Ok(p) => p,
            Err(e) => return failure(format!("{out}\nThe picture could not be drawn: {e}")),
        };
        let where_ = match camera.angles {
            Some(_) => {
                let given = |long: &str, short: &str| {
                    py_num(args.get(long).filter(|v| !v.is_null()).or(args.get(short)).or(Some(&json!(0))))
                };
                format!("az {} el {}", given("azimuth", "az"), given("elevation", "el"))
            }
            None => camera.view.clone(),
        };
        out.push_str(&format!("\n{where_} view of {}, {w}x{h}. {}", surface.id, surface.scale()));
        CallToolResult::success(vec![
            ContentBlock::text(out),
            ContentBlock::image(base64::engine::general_purpose::STANDARD.encode(&png), "image/png"),
        ])
    }

    /// A refusal naming `wanted` and the bodies there are, with every feature
    /// failure, when the build has no such body; None when it has one.
    async fn missing_body(link: &EngineLink, doc: &Doc, wanted: &str) -> Option<CallToolResult> {
        let reply = link
            .call(
                "inspect",
                call_args([
                    ("document", Value::Object(doc.clone())),
                    ("detail", json!(false)),
                    ("summary", json!(true)),
                ]),
            )
            .await
            .ok()?;
        let r = reply.get("result").filter(|_| reply.get("ok") == Some(&json!(true)))?;
        let built = r.get("bodies").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        if find_body(built, wanted).is_some() {
            return None;
        }
        let failed = crate::clash::failures(r);
        let mut why = if built.is_empty() {
            format!("nothing built, so there is no body '{wanted}' to analyse.")
        } else {
            format!("{}. Check the id or name against `build`.", no_such_body(wanted, built))
        };
        if !failed.is_empty() {
            why.push_str(" Some features failed, which may be why:\n");
            why.push_str(&failed.join("\n"));
        }
        Some(failure(why))
    }
}

impl FundaCad {
    /// Of `ids`, the bodies that are not closed outward facing solids, with why; empty when the engine cannot be asked.
    async fn unsound(link: &EngineLink, doc: Doc, ids: &[String]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        if ids.is_empty() {
            return out;
        }
        let asked = call_args([("document", Value::Object(doc)), ("detail", json!(false)), ("bodies", json!(ids))]);
        let Ok(reply) = link.call("inspect", asked).await else {
            return out;
        };
        let bodies = reply.get("result").and_then(|r| r.get("bodies")).and_then(Value::as_array);
        for b in bodies.map_or(&[][..], Vec::as_slice) {
            let Some(id) = b.get("id").and_then(Value::as_str) else { continue };
            if let Some(why) = b.get("fault").and_then(Value::as_str) {
                out.insert(id.to_string(), why.to_string());
            } else if b.get("insideOut").and_then(Value::as_bool).unwrap_or(false) {
                out.insert(id.to_string(), "is inside out, its faces point into the material".to_string());
            }
        }
        out
    }
}

/// The bodies of a meshed rebuild, sent framed or inline in the reply.
fn meshed_bodies(result: &Value, framed: Vec<MeshBody>) -> Vec<MeshBody> {
    if !framed.is_empty() {
        return framed;
    }
    result
        .get("bodies")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(MeshBody::from_value)
        .collect()
}

impl FundaCad {
    /// The engine's `printability` op does the work, so the app's panel and
    /// this tool check the same mesh the same way; this adds the failures.
    async fn printability(&self, args: &JsonObject) -> CallToolResult {
        // The engine passes over keys it does not know, as every op does, so
        // a misspelt setting is caught here rather than quietly defaulted.
        const KNOWN: [&str; 13] = [
            "bodies",
            "nozzle",
            "layer",
            "overhang",
            "minGap",
            "maxBridge",
            "checks",
            "up",
            "layFlat",
            "all",
            "full",
            "limit",
            "offset",
        ];
        if let Some(k) = args.keys().find(|k| !KNOWN.contains(&k.as_str())) {
            return failure(format!("printability takes no '{k}', it takes {}", KNOWN.join(", ")));
        }
        let full = truthy(args.get("full"));
        let page = match Page::of(args, if full { 0 } else { budget::ROWS }) {
            Ok(p) => p,
            Err(why) => return failure(why),
        };
        let topology =
            args.get("checks").and_then(Value::as_array).is_none_or(|c| c.iter().any(|k| k.as_str() == Some("open")));
        let (link, doc) = {
            let mut st = self.state.lock().await;
            model::recompute_parameters(&mut st.doc);
            (st.link.clone(), st.doc.clone())
        };
        let mut payload = args.clone();
        for k in ["full", "limit", "offset"] {
            payload.remove(k);
        }
        payload.insert("document".into(), Value::Object(doc));
        let reply = match link.call("printability", Value::Object(payload)).await {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            return failure(error_message(&reply));
        }
        let r = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        let mut out = crate::printrep::condensed(&r, page, full, topology);
        let failed = crate::clash::failures(&r);
        let nothing = r.get("bodies").and_then(Value::as_array).is_none_or(Vec::is_empty);
        if nothing {
            if !failed.is_empty() {
                out.push('\n');
                out.push_str(&failed.join("\n"));
            }
            return failure(out);
        }
        if !failed.is_empty() {
            out.push_str("\nSome features failed, so this checked what did build:\n");
            out.push_str(&failed.join("\n"));
        }
        text(out)
    }
}

impl FundaCad {
    /// Asks the engine to read the file, as the app's import does, and adds the fields it hands back. `geom` is a
    /// content hash in the engine's blob store, so the reply stays small. Pieces before the last change nothing.
    async fn doc_import(&self, args: &JsonObject) -> CallToolResult {
        // Present and not empty, whatever its type: a numeric `content` must reach the spool to be refused by name.
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
            let path = match self.scoped(args.get("path").and_then(Value::as_str).unwrap_or_default()).await {
                Ok(p) => p,
                Err(e) => return e,
            };
            if !path.is_file() {
                return failure(format!("No such file: {}\n{ASK_FOR_A_PATH}", path.display()));
            }
            let fmt = args
                .get("format")
                .and_then(Value::as_str)
                .map(upload::format_told_as)
                .unwrap_or_else(|| upload::import_format(&path.to_string_lossy()).to_string());
            if !IMPORT_FORMATS.contains(&fmt.as_str()) {
                return failure(format!("Cannot import '{fmt}' files. Formats: {}.", IMPORT_FORMATS.join(", ")));
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
                // The nudge goes on the FIRST piece or nowhere, while there is still something to decide.
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
                    // Provenance, not a path: the temporary file is about to be gone.
                    (path, fmt, name)
                }
                Err(e) => {
                    self.state.lock().await.drop_upload(&id);
                    return failure(format!("Could not read what was sent: {e}"));
                }
            }
        };

        let mut import_args = vec![("path", json!(path.to_string_lossy())), ("format", json!(fmt))];
        if let Some(unit) = args.get("unit").and_then(Value::as_str) {
            import_args.push(("unit", json!(unit)));
        }
        let link = self.engine_link().await;
        let reply = link.call("import", call_args(import_args)).await;
        if let Some(id) = &upload_id {
            self.state.lock().await.drop_upload(id);
        }
        let reply = match reply {
            Ok(r) => r,
            Err(e) => return engine_gone(&e),
        };
        if reply.get("ok") != Some(&json!(true)) {
            // The engine refuses for reasons an agent can act on, so its message is passed through whole.
            let message =
                reply.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("unreadable file");
            return failure(format!("Import failed: {message}"));
        }
        let res = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        let sketches: Vec<Value> = res.get("sketches").and_then(Value::as_array).cloned().unwrap_or_default();
        let has_geom = !res.get("geom").and_then(Value::as_str).unwrap_or("").is_empty();
        if !has_geom && sketches.is_empty() {
            return failure(format!("The engine read {source} but returned neither sketches nor geometry."));
        }
        let notes: String = res
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|n| format!("\nNote: {n}."))
            .collect();
        let mut at = args.get("at").and_then(Value::as_i64);
        let mut added = Vec::new();
        if !sketches.is_empty() {
            let mut st = self.state.lock().await;
            for s in &sketches {
                let layer = s.get("name").and_then(Value::as_str).unwrap_or("Sketch");
                let entities = s.get("entities").cloned().unwrap_or_else(|| json!([]));
                let count = entities.as_array().map_or(0, Vec::len);
                let mut f = json!({"type": "sketch", "plane": "XY", "name": layer, "entities": entities});
                if let Some(rule) = s.get("fillRule") {
                    f["fillRule"] = rule.clone();
                }
                match model::add_feature(&mut st.doc, &f, at) {
                    Ok(fid) => added.push(format!("sketch {fid} '{layer}', {count} entities")),
                    Err(e) => return doc_error(e),
                }
                at = at.map(|a| a + 1);
            }
            st.invalidate();
            if !has_geom {
                let what = if added.len() == 1 { "1 sketch".to_string() } else { format!("{} sketches", added.len()) };
                let filled = if sketches.iter().any(|s| s.get("fillRule").is_some()) {
                    "Its outlines are healed into closed profiles with fillRule evenodd, so the holes stay open when the \
                     extrude has no `regions`."
                } else {
                    "Without `regions` an extrude fills every closed outline, holes included."
                };
                let head = format!(
                    "Imported {source} as {what} on the XY plane: {}.{notes}\nExtrude a sketch to make a body. {filled}",
                    added.join("; ")
                );
                return text(st.state_line(&head));
            }
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
        // Spread, not defaulted, as the app's import does: a null differs from absent to everything downstream.
        for key in ["color", "nodes", "parts", "notes", "unit"] {
            if let Some(v) = res.get(key).filter(|v| !v.is_null()) {
                feature.insert(key.into(), v.clone());
            }
        }

        let mut st = self.state.lock().await;
        let fid = match model::add_feature(&mut st.doc, &Value::Object(feature), at) {
            Ok(fid) => fid,
            Err(e) => return doc_error(e),
        };
        st.invalidate();
        let kind = if solid { "solid" } else { "surface body (not a solid)" };
        let parts = match res.get("parts").and_then(Value::as_array) {
            Some(p) if !p.is_empty() => format!(", {} parts", p.len()),
            _ => String::new(),
        };
        let sketch_line = if added.is_empty() { String::new() } else { format!("\nAlso added {}.", added.join("; ")) };
        let head = format!(
            "Imported {source} as {fid}: '{name}', {kind}, {} faces{parts}.{sketch_line}{notes}\nRun `build`, then \
             `inspect` for its sizes and the selectors that address its faces and edges.",
            res.get("faces").map_or("?".to_string(), |f| py_num(Some(f)))
        );
        text(st.state_line(&head))
    }

    /// Order is required rather than reassembled: a gap that never fills looks like one not filled yet,
    /// while a refusal by name turns a lost piece into something the caller can act on.
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
                    let ok =
                        matches!(v, Value::Number(n) if n.is_i64() || n.is_u64()) && v.as_i64().is_some_and(|n| n >= 1);
                    if !ok {
                        return Err(upload::UploadError(format!("{label} must be a whole number from 1 up.")));
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
            let id = args.get("upload").and_then(Value::as_str).unwrap_or_default().to_string();
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

#[rmcp::tool_handler(router = self.router)]
impl ServerHandler for FundaCad {
    fn get_info(&self) -> ServerConfig {
        // `instructions` cannot await the lock, so the working order goes out as at start-up, when a host reads it.
        // `call_live` keeps the live rules true afterwards.
        let live = self.state.try_lock().map(|s| s.live.is_some()).unwrap_or(false);
        let instructions = instructions_for(live);
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
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
        Ok(ListResourcesResult { resources: vec![resource], ..Default::default() })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        if request.uri != "fundacad://schema" {
            return Err(McpError::invalid_params(format!("no such resource: {}", request.uri), None));
        }
        Ok(ReadResourceResponse::Complete(ReadResourceResult::new(vec![ResourceContents::TextResourceContents {
            uri: request.uri,
            mime_type: Some("text/plain".into()),
            text: schema::schema_text(None),
            meta: None,
        }])))
    }

    /// A tool's own failure is a RESULT with isError, which the model can react to,
    /// not a JSON-RPC error, which only says the call was malformed.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let _turn = self.turn.lock().await;
        let name = request.name.to_string();
        if self.router.get(&name).is_none() {
            let mut have: Vec<String> = self.router.list_all().iter().map(|t| t.name.to_string()).collect();
            have.sort();
            return Ok(CallToolResponse::Complete(failure(format!("No tool '{name}'. Have: {}", have.join(", ")))));
        }
        let args = request.arguments.clone().unwrap_or_default();
        if let Some(refusal) = self.router.get(&name).and_then(|t| unknown_arguments(&name, t, &args)) {
            return Ok(CallToolResponse::Complete(refusal));
        }
        // Never fatal to a tool call: working privately is a worse answer than
        // working on the open document, but it is a working one.
        self.adopt_running_app().await;

        let mut lost = false;
        for attempt in 0..2 {
            let live = self.state.lock().await.live.is_some();
            if live && !NO_DOCUMENT.contains(&name.as_str()) {
                let tcc = ToolCallContext::new(self, request.clone(), context.clone());
                let run = self.router.call(tcc);
                match self.call_live(&name, &args, run).await {
                    Ok(out) => return out,
                    Err(e) if attempt == 0 && e.is_lost() => {
                        self.drop_lost_app(e.message()).await;
                        lost = true;
                        continue;
                    }
                    Err(e) => return Ok(CallToolResponse::Complete(failure(e.message()))),
                }
            }
            let mutates = MUTATORS.contains(&name.as_str());
            if mutates {
                self.state.lock().await.private_edits = true;
            }
            let tcc = ToolCallContext::new(self, request, context);
            let out = self.router.call(tcc).await;
            // The agent was working on the open document a moment ago: say
            // that this change did not reach it.
            if lost && mutates {
                if let Ok(CallToolResponse::Complete(result)) = out {
                    let mut note = "\n(FundaCAD's engine went away, so this was done on a private copy, not in the \
                         open document. doc_save it to keep it, or reopen FundaCAD and do it again there.)"
                        .to_string();
                    if let Some(mismatch) = self.build_mismatch().await {
                        note.push_str(&format!("\n{mismatch}"));
                    }
                    return Ok(CallToolResponse::Complete(append(result, &note)));
                }
            }
            return out;
        }
        unreachable!("the loop returns or continues once")
    }
}

impl FundaCad {
    /// Drops unfinished uploads and the app's lease. The sweep still covers the usual case,
    /// a host killing its servers with no clean-up at all.
    pub async fn shutdown(&self) {
        let (link, live, ids) = {
            let st = self.state.lock().await;
            (st.link.clone(), st.live.is_some(), st.uploads.keys().cloned().collect::<Vec<_>>())
        };
        self.stop_ui().await;
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
