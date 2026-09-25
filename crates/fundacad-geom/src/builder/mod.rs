//! Timeline replay, replacing the Python engine's `builder.py` `rebuild` and the helpers of
//! the Python engine's `handler_util.py`.
//!
//! The document's features run in order against an ordered list of bodies. A
//! feature that fails is a no-op with an error naming it, and the build goes
//! on. Bodies get their ids from `BodyIds` exactly as the Python engine assigns
//! them, so a document keeps its ids whichever engine built it.

mod fmt;
pub mod owners;
pub mod plane;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use fundacad_core::body_ids::{number, BodyIds, Event};
use fundacad_core::schema::{CadDocument, Feature, Num, UnresolvedNum};
use indexmap::IndexMap;
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

use crate::features;
use crate::kernel::{self, KernelError};
pub use fmt::{py_g, py_g_prec};
pub use owners::Owners;
pub use plane::PlaneRecord;

/// Machine codes of the Python engine's `errors.py`.
pub const BAD_REQUEST: &str = "badRequest";

/// Why a feature did nothing: the arms of the Python rebuild loop's `except`.
#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    /// A refusal written for the user (`ValueError`, `GeomError`).
    Value {
        message: String,
        code: Option<&'static str>,
    },
    /// The feature lacks a field its handler reads (`KeyError`).
    Missing(String),
    /// Anything else, named by its exception class.
    Internal(String),
}

impl Fail {
    pub fn msg(message: impl Into<String>) -> Fail {
        Fail::Value {
            message: message.into(),
            code: None,
        }
    }
}

impl From<UnresolvedNum> for Fail {
    fn from(e: UnresolvedNum) -> Fail {
        Fail::msg(e.to_string())
    }
}

impl From<KernelError> for Fail {
    fn from(e: KernelError) -> Fail {
        translate_kernel_error(e.0)
    }
}

/// The handful of raw OCCT exception names worth turning into a sentence a
/// caller can act on, the same way `require_positive` already reads for a
/// negative dimension. Everything else stays `Internal`, named by its
/// exception class rather than guessed at, because a name not on this list
/// has not been checked to mean the same thing in every feature that can
/// raise it.
fn translate_kernel_error(name: String) -> Fail {
    match name.as_str() {
        "Standard_DomainError" => Fail::msg(
            "the kernel refused a degenerate value, a size, distance or direction is zero or \
             too small to represent (Standard_DomainError)",
        ),
        _ => Fail::Internal(name),
    }
}

pub type FResult<T = ()> = Result<T, Fail>;

/// One entry of the build's error list, `{feature_id, message, code?}`.
#[derive(Debug, Clone, PartialEq)]
pub struct FeatureError {
    pub feature_id: Option<String>,
    pub message: String,
    pub code: Option<String>,
    /// For the error report: the kernel calls, the bodies and the parameter
    /// values at the moment it failed. `None` for errors restored from a
    /// checkpoint written before this existed.
    pub detail: Option<Value>,
}

impl FeatureError {
    /// server.py `_err_wire`.
    pub fn wire(&self) -> Value {
        let mut m = Map::new();
        m.insert("message".into(), Value::String(self.message.clone()));
        m.insert(
            "feature_id".into(),
            self.feature_id.clone().map_or(Value::Null, Value::String),
        );
        if let Some(code) = &self.code {
            m.insert("code".into(), Value::String(code.clone()));
        }
        Value::Object(m)
    }

    /// `wire` plus the report detail, for the app's `featureErrors` and the
    /// checkpoint. Kept out of `wire`, which the parity and MCP replies compare.
    pub fn wire_full(&self) -> Value {
        let mut v = self.wire();
        if let (Some(detail), Value::Object(m)) = (&self.detail, &mut v) {
            m.insert("detail".into(), detail.clone());
        }
        v
    }
}

#[derive(Clone)]
pub struct Body {
    uid: u64,
    generation: u64,
    pub id: String,
    pub name: String,
    shape: Shape,
    pub owners: Owners,
    /// Mesh pass specs a plugin stashed, `plugin_geometry.BODY_KEY`.
    pub mesh_passes: Vec<Value>,
    /// The assembly tree node an import bound this body to, `<featureId>/<index>`.
    pub node_ref: Option<String>,
    /// Packed per-face colours (fundacad_core::face_colors) from the imported file.
    pub face_colors: Option<Value>,
    pub part_color: Option<String>,
    /// An explicitly collapsed import, exempt from debris dropping.
    pub intact: bool,
}

impl Body {
    pub fn shape(&self) -> &Shape {
        &self.shape
    }

    /// Process-unique while the shape is unchanged, a key for derived caches.
    pub fn identity(&self) -> (u64, u64) {
        (self.uid, self.generation)
    }

    /// A body read back from a checkpoint, under a new identity.
    pub fn restored(id: String, name: String, shape: Shape, owners: Owners, meta: ImportedMeta) -> Body {
        Body {
            uid: NEXT_UID.fetch_add(1, Ordering::Relaxed) + 1,
            generation: NEXT_UID.fetch_add(1, Ordering::Relaxed) + 1,
            id,
            name,
            shape,
            owners,
            mesh_passes: Vec::new(),
            node_ref: meta.node_ref,
            face_colors: meta.face_colors,
            part_color: meta.part_color,
            intact: meta.intact,
        }
    }
}

/// What the file an import came from says about a body.
#[derive(Default)]
pub struct ImportedMeta {
    pub node_ref: Option<String>,
    pub face_colors: Option<Value>,
    pub part_color: Option<String>,
    pub intact: bool,
}

/// A located sketch: the whole profile, its region cells, the hole positions
/// and sweep path it offers, and its plane.
#[derive(Clone)]
pub struct SketchEntry {
    pub sketch: Option<Shape>,
    pub faces: Vec<Shape>,
    pub points: Vec<[f64; 3]>,
    pub wire: Option<Shape>,
    pub plane: kernel::Frame,
    /// Every sketch curve, located, for Divide to imprint.
    pub edges: Vec<Shape>,
    /// The face selector the sketch follows, which names the body a Divide splits.
    pub face: Option<fundacad_core::schema::Selector>,
}

/// What a handler reads and edits, the Python engine's `builder.py` `_RebuildCtx`.
pub struct Ctx {
    params: HashMap<String, f64>,
    pub datums: IndexMap<String, PlaneRecord>,
    pub sketches: HashMap<String, SketchEntry>,
    pub bodies: Vec<Body>,
    pub diagnostics: Vec<Value>,
    pub hidden_bodies: HashSet<String>,
    pub sketch_planes: IndexMap<String, Value>,
    pub datum_marks: IndexMap<String, Value>,
    /// Projected sketch entity refresh entries, the Python engine's `projection_refresh.py`.
    pub projections: Vec<Value>,
    /// The cut or join each feature applied so far, by feature id, which is
    /// what a feature pattern repeats. Kept only for the features in
    /// `patterned`, so a document without feature patterns holds no tools.
    pub tools: HashMap<String, Vec<ToolRecord>>,
    pub patterned: HashSet<String>,
    /// Every feature of the document in order, for naming one in a message.
    pub timeline: Vec<Step>,
    ids: BodyIds,
}

/// One boolean a feature applied: the tool solid and the bodies it changed.
#[derive(Clone)]
pub struct ToolRecord {
    pub kind: kernel::BoolKind,
    pub bodies: Vec<String>,
    pub tool: Shape,
}

#[derive(Clone)]
pub struct Step {
    pub id: String,
    pub kind: String,
    pub label: String,
}

static NEXT_UID: AtomicU64 = AtomicU64::new(0);

impl Ctx {
    /// A context holding only the document's parameters, for reading sketch
    /// entities outside a rebuild.
    pub fn with_params(doc: &CadDocument) -> Ctx {
        Ctx {
            params: params_of(doc),
            datums: IndexMap::new(),
            sketches: HashMap::new(),
            bodies: Vec::new(),
            diagnostics: Vec::new(),
            hidden_bodies: HashSet::new(),
            sketch_planes: IndexMap::new(),
            datum_marks: IndexMap::new(),
            projections: Vec::new(),
            tools: HashMap::new(),
            patterned: HashSet::new(),
            timeline: Vec::new(),
            ids: BodyIds::new(None),
        }
    }

    pub fn val(&self, n: &Num) -> FResult<f64> {
        Ok(n.resolve(|name| self.params.get(name).copied())?)
    }

    pub fn val_or(&self, n: Option<&Num>, default: f64) -> FResult<f64> {
        n.map_or(Ok(default), |n| self.val(n))
    }

    /// A context outside any document, for geometry a plugin generates.
    pub fn detached() -> Ctx {
        Ctx {
            params: HashMap::new(),
            datums: IndexMap::new(),
            sketches: HashMap::new(),
            bodies: Vec::new(),
            diagnostics: Vec::new(),
            hidden_bodies: HashSet::new(),
            sketch_planes: IndexMap::new(),
            datum_marks: IndexMap::new(),
            projections: Vec::new(),
            tools: HashMap::new(),
            patterned: HashSet::new(),
            timeline: Vec::new(),
            ids: BodyIds::new(None),
        }
    }

    fn bump(&mut self) -> u64 {
        NEXT_UID.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// `new_body`: the next id for this feature, `Body<n>` unless named.
    pub fn new_body(&mut self, shape: Shape, name: Option<String>, inherit: Option<&str>) -> usize {
        self.new_body_with(shape, name, inherit, ImportedMeta::default())
    }

    /// `new_body` with the import metadata, whose node ref also keys the body id.
    pub fn new_body_with(
        &mut self,
        shape: Shape,
        name: Option<String>,
        inherit: Option<&str>,
        meta: ImportedMeta,
    ) -> usize {
        let key = self.ids.key(meta.node_ref.as_deref());
        let id = self.ids.assign(&key, inherit);
        let name = name.unwrap_or_else(|| format!("Body{}", number(&id)));
        let uid = self.bump();
        let generation = self.bump();
        self.bodies.push(Body {
            uid,
            generation,
            id,
            name,
            shape,
            owners: Owners::default(),
            mesh_passes: Vec::new(),
            node_ref: meta.node_ref.filter(|r| !r.is_empty()),
            face_colors: meta.face_colors,
            part_color: meta.part_color.filter(|c| !c.is_empty()),
            intact: meta.intact,
        });
        self.bodies.len() - 1
    }

    pub fn require_active(&self, label: &str) -> FResult<usize> {
        if self.bodies.is_empty() {
            return Err(Fail::msg(format!("{label} needs an existing body")));
        }
        Ok(self.bodies.len() - 1)
    }

    pub fn find_body(&self, id: &str) -> Option<usize> {
        self.bodies.iter().position(|b| b.id == id)
    }

    pub fn set_shape(&mut self, index: usize, shape: Shape) {
        let generation = self.bump();
        if let Some(b) = self.bodies.get_mut(index) {
            b.shape = shape;
            b.generation = generation;
        }
    }

    pub fn record_tool(&mut self, feature_id: &str, kind: kernel::BoolKind, bodies: Vec<String>, tool: Shape) {
        if !self.patterned.contains(feature_id) {
            return;
        }
        self.tools
            .entry(feature_id.to_owned())
            .or_default()
            .push(ToolRecord { kind, bodies, tool });
    }

    pub fn remove_bodies(&mut self, ids: &HashSet<String>) {
        self.bodies.retain(|b| !ids.contains(&b.id));
    }

    /// booleans.py `_skip_feature`: a stale reference recorded, not raised.
    pub fn skip_feature(&mut self, feature_id: &str, kind: &str, reason: &str) {
        self.diagnostics.push(json!({
            "feature_id": feature_id,
            "kind": kind,
            "resolved": 0,
            "confidence": 0.0,
            "lossy": true,
            "reason": reason,
        }));
    }

    /// A note about a feature that built: the timeline chip's tooltip, and a
    /// warning line in the MCP build reply.
    pub fn advise(&mut self, feature_id: &str, kind: &str, reason: String) {
        self.diagnostics.push(advisory(feature_id, kind, reason));
    }

    pub fn shapes(&self) -> Vec<&Shape> {
        self.bodies.iter().map(|b| &b.shape).collect()
    }
}

fn advisory(feature_id: &str, kind: &str, reason: String) -> Value {
    json!({
        "feature_id": feature_id,
        "kind": kind,
        "resolved": 1,
        "confidence": 1.0,
        "lossy": false,
        "reason": reason,
        "code": kind,
    })
}

/// Solids a body holds once `drop_debris` has had its say.
fn pieces(shape: &Shape) -> usize {
    let n = kernel::count(shape, kernel::Kind::Solid);
    if n < 2 {
        return n;
    }
    kernel::count(&kernel::drop_debris(shape), kernel::Kind::Solid)
}

/// Says so when a feature that removed material left a body in more pieces
/// than it found it. The pieces stay in the body, and without this nothing
/// would tell the user a tip fell off. Split exists to do this, so it is quiet.
fn note_splits(ctx: &mut Ctx, fid: &str, rawf: &Value, pre: &[(u64, u64, Shape)]) {
    if rawf.get("type").and_then(Value::as_str) == Some("split") {
        return;
    }
    let noun = match rawf.get("operation").and_then(Value::as_str) {
        Some("intersect") => "the intersect",
        _ => "the cut",
    };
    let mut notes = Vec::new();
    for b in &ctx.bodies {
        let Some((_, _, old)) = pre
            .iter()
            .find(|(uid, generation, _)| *uid == b.uid && *generation != b.generation)
        else {
            continue;
        };
        if kernel::count(&b.shape, kernel::Kind::Solid) < 2 {
            continue;
        }
        let now = pieces(&b.shape);
        if now > pieces(old) && kernel::volume(&b.shape).abs() < kernel::volume(old).abs() {
            notes.push(advisory(
                fid,
                "bodySplit",
                format!("{noun} split {} into {now} pieces", b.name),
            ));
        }
    }
    // First, since a chip shows one note and a lost piece matters most.
    let at = ctx
        .diagnostics
        .iter()
        .position(|d| d.get("feature_id").and_then(Value::as_str) == Some(fid))
        .unwrap_or(ctx.diagnostics.len());
    ctx.diagnostics.splice(at..at, notes);
}

/// A body as the build leaves it, debris dropped.
pub struct BuiltBody {
    pub id: String,
    pub name: String,
    pub shape: Shape,
    pub owners: Owners,
    pub mesh_passes: Vec<Value>,
    pub node_ref: Option<String>,
    pub face_colors: Option<Value>,
    pub part_color: Option<String>,
    /// `Body::identity` of the body this was made from.
    pub identity: (u64, u64),
}

pub struct Rebuild {
    pub bodies: Vec<BuiltBody>,
    pub errors: Vec<FeatureError>,
    pub diagnostics: Vec<Value>,
    pub datum_planes: IndexMap<String, PlaneRecord>,
    pub sketch_planes: IndexMap<String, Value>,
    pub datum_marks: IndexMap<String, Value>,
    pub body_ids: IndexMap<String, String>,
    /// `projectionUpdates`, only the entries a refresh found a real change for.
    pub projection_updates: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// Hooks the engine hands a rebuild: progress per feature, cancel between them.
pub trait Watch {
    fn feature(&self, _index: usize) {}
    /// Meshing `done` of `total` bodies.
    fn meshing(&self, _done: usize, _total: usize) {}
    fn cancelled(&self) -> bool {
        false
    }
    /// The flag behind `cancelled`, for work that polls it off this thread.
    fn cancel_token(&self) -> Option<fundacad_protocol::CancelToken> {
        None
    }
    /// Proof of life a feature can give from inside one long kernel call.
    fn heartbeat(&self) -> Option<crate::heartbeat::Beat> {
        None
    }
}

pub struct NoWatch;
impl Watch for NoWatch {}

/// The build state after a feature, what a later rebuild resumes from.
/// Shapes are handle copies, so taking one duplicates no geometry.
#[derive(Clone)]
pub struct Snapshot {
    pub bodies: Vec<Body>,
    pub sketches: HashMap<String, SketchEntry>,
    /// The sketches were not kept (a disk checkpoint), rebuild them on resume.
    pub replay_sketches: bool,
    pub datums: IndexMap<String, PlaneRecord>,
    pub sketch_planes: IndexMap<String, Value>,
    pub datum_marks: IndexMap<String, Value>,
    pub diagnostics: Vec<Value>,
    pub errors: Vec<FeatureError>,
    pub id_events: Vec<Event>,
    /// `Ctx::tools`, empty from a disk checkpoint.
    pub tools: HashMap<String, Vec<ToolRecord>>,
}

/// The live state a `Tap` sees after each feature.
pub struct State<'a> {
    pub ctx: &'a Ctx,
    pub errors: &'a [FeatureError],
}

impl State<'_> {
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            bodies: self.ctx.bodies.clone(),
            sketches: self.ctx.sketches.clone(),
            replay_sketches: false,
            datums: self.ctx.datums.clone(),
            sketch_planes: self.ctx.sketch_planes.clone(),
            datum_marks: self.ctx.datum_marks.clone(),
            diagnostics: self.ctx.diagnostics.clone(),
            errors: self.errors.to_vec(),
            id_events: self.ctx.ids.events().to_vec(),
            tools: self.ctx.tools.clone(),
        }
    }
}

/// Called after every replayed feature, with its wall time.
pub trait Tap {
    fn after_feature(&mut self, index: usize, state: &State<'_>, elapsed: Duration);
}

pub struct NoTap;
impl Tap for NoTap {
    fn after_feature(&mut self, _: usize, _: &State<'_>, _: Duration) {}
}

/// `_ids_resumable`: the document's `bodyIds` numbers the snapshot's prefix
/// the way the snapshot did.
pub fn ids_resumable(doc: &CadDocument, snap: &Snapshot) -> bool {
    BodyIds::new(doc.body_ids.clone()).restore(&snap.id_events)
}

/// Keys Python reads with a default the schema requires, filled before a
/// feature is typed so a document the Python engine builds types here too.
fn with_python_defaults(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let t = obj.get("type")?.as_str()?;
    let defaults: &[(&str, Value)] = match t {
        "extrude" | "sweep" => &[("operation", json!("new"))][..],
        "scale" => &[("factor", json!(1))][..],
        "revolve" => &[("axis", json!("Z")), ("angle", json!(360))][..],
        "removeBody" => &[("bodies", json!([]))][..],
        "sketch" => &[("entities", json!([]))][..],
        "patternLinear" => &[("spacing", json!(0)), ("axis", json!("X"))][..],
        "patternCircular" => &[("angle", json!(360)), ("axis", json!("Z"))][..],
        "draft" => &[("axis", json!("Z"))][..],
        "split" => &[("keep", json!("both"))][..],
        "simplifyMesh" => &[("tolerance", json!(1))][..],
        _ => &[][..],
    };
    let mut out = obj.clone();
    let mut changed = false;
    for (k, v) in defaults {
        let absent = match out.get(*k) {
            None => true,
            Some(Value::Null) => t == "removeBody",
            Some(_) => false,
        };
        if absent {
            out.insert((*k).to_owned(), v.clone());
            changed = true;
        }
    }
    if t == "sketch" {
        if let Some(Value::Array(ents)) = out.get_mut("entities") {
            for e in ents.iter_mut() {
                if let Some(m) = e.as_object_mut() {
                    if m.get("type").and_then(Value::as_str) == Some("polygon") {
                        for k in ["x", "y", "angle"] {
                            if !m.contains_key(k) {
                                m.insert(k.to_owned(), json!(0));
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
        if let Some(Value::Array(pats)) = out.get_mut("patterns") {
            for p in pats.iter_mut() {
                if let Some(m) = p.as_object_mut() {
                    if !m.contains_key("sources") {
                        m.insert("sources".into(), json!([]));
                        changed = true;
                    }
                }
            }
        }
    }
    changed.then_some(Value::Object(out))
}

/// The typed feature, and the raw object it came from.
fn typed(raw: &Value) -> Feature {
    let parsed: Feature =
        serde_json::from_value(raw.clone()).unwrap_or_else(|_| Feature::Unknown(raw.clone()));
    if parsed.is_invalid() {
        if let Some(patched) = with_python_defaults(raw) {
            if let Ok(f) = serde_json::from_value::<Feature>(patched) {
                if !f.is_invalid() {
                    return f;
                }
            }
        }
    }
    parsed
}

/// What a bug report needs beside the message: the kernel calls the feature
/// made, the bodies it was handed and the parameter values it resolved against.
fn failure_detail(ctx: &Ctx, index: usize, type_name: Option<&str>, took: Duration) -> Value {
    const BODIES: usize = 12;
    let bodies: Vec<Value> = ctx
        .bodies
        .iter()
        .take(BODIES)
        .map(|b| json!({ "id": b.id, "name": b.name, "shape": kernel::describe(&b.shape) }))
        .collect();
    let mut params: Vec<(&String, &f64)> = ctx.params.iter().collect();
    params.sort_by(|a, b| a.0.cmp(b.0));
    let params: Map<String, Value> = params
        .into_iter()
        .take(64)
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    json!({
        "index": index,
        "type": type_name,
        "ms": (took.as_secs_f64() * 1e5).round() / 100.0,
        "kernel": crate::trace::take().iter().map(crate::trace::Call::wire).collect::<Vec<_>>(),
        "bodies": bodies,
        "bodyCount": ctx.bodies.len(),
        "params": params,
        "occt": crate::OCCT_VERSION,
    })
}

fn label_of(raw: &Value) -> String {
    let s = |k: &str| raw.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    s("name")
        .or_else(|| s("type"))
        .unwrap_or("feature")
        .to_owned()
}

/// A serde complaint about a feature, as the Python handler would have failed.
fn invalid_to_fail(error: &str) -> Fail {
    if let Some(rest) = error.strip_prefix("missing field `") {
        if let Some(end) = rest.find('`') {
            return Fail::Missing(rest[..end].to_owned());
        }
    }
    Fail::Internal("TypeError".into())
}

const NOT_PROVENANCE: [&str; 4] = ["sketch", "datumPlane", "datumPoint", "datumAxis"];

/// `_is_inactive`: true when `activeWhen` resolves to 0. NaN is refused.
fn is_inactive(ctx: &Ctx, cond: Option<Num>) -> FResult<bool> {
    let Some(cond) = cond else {
        return Ok(false);
    };
    let v = ctx.val(&cond)?;
    if v.is_nan() {
        return Err(Fail::msg("activeWhen must resolve to a number (got nan)"));
    }
    Ok(v == 0.0)
}

/// `_references_any`: the first of `ids` spelled as a string anywhere inside
/// the feature, skipping its own `id`.
fn references_any<'a>(node: &Value, ids: &'a [String]) -> Option<&'a str> {
    match node {
        Value::String(s) => ids.iter().find(|i| *i == s).map(String::as_str),
        Value::Object(m) => m
            .iter()
            .filter(|(k, _)| k.as_str() != "id")
            .find_map(|(_, v)| references_any(v, ids)),
        Value::Array(a) => a.iter().find_map(|v| references_any(v, ids)),
        _ => None,
    }
}

/// `_switched_off_owner`: the switched off feature whose body a message names.
fn switched_off_owner(
    message: &str,
    recorded: &IndexMap<String, String>,
    inactive: &[String],
) -> Option<String> {
    for bid in body_tokens(message) {
        for (key, got) in recorded {
            if *got == bid {
                let fid = strip_key_suffix(key);
                if inactive.iter().any(|i| i == fid) {
                    return Some(fid.to_owned());
                }
            }
        }
    }
    None
}

/// `re.findall(r"\bbody\d+\b", message)`.
fn body_tokens(message: &str) -> Vec<String> {
    let bytes = message.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(off) = message[i..].find("body") {
        let start = i + off;
        let mut end = start + 4;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let boundary_before = start == 0 || !word(bytes[start - 1]);
        let boundary_after = end == bytes.len() || !word(bytes[end]);
        if end > start + 4 && boundary_before && boundary_after {
            out.push(message[start..end].to_owned());
        }
        i = start + 4;
    }
    out
}

/// `re.sub(r"(:\d+#?|/[^/]*)$", "", key)`.
fn strip_key_suffix(key: &str) -> &str {
    if let Some(slash) = key.rfind('/') {
        return &key[..slash];
    }
    let trimmed = key.strip_suffix('#').unwrap_or(key);
    if let Some(colon) = trimmed.rfind(':') {
        let digits = &trimmed[colon + 1..];
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            return &key[..colon];
        }
    }
    key
}

fn params_of(doc: &CadDocument) -> HashMap<String, f64> {
    doc.parameters
        .iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.get()))
        .collect()
}

/// A snapshot at `at` can be resumed only when it still holds the tool of
/// every feature before `at` that a feature pattern after it repeats. A disk
/// checkpoint keeps none, so that document replays from the start.
fn tools_kept(features: &[Feature], at: usize, tools: &HashMap<String, Vec<ToolRecord>>) -> bool {
    let before: HashSet<&str> = features[..at].iter().map(Feature::id).collect();
    features[at..]
        .iter()
        .filter_map(features::pattern_sources)
        .flatten()
        .all(|src| !before.contains(src.as_str()) || tools.contains_key(src))
}

/// Replays `doc`. `raw` is the same document as JSON, which is what a
/// feature's label and references are read from.
pub fn rebuild(doc: &CadDocument, raw: &Value, watch: &dyn Watch) -> Result<Rebuild, Cancelled> {
    rebuild_from(doc, raw, watch, None, &mut NoTap)
}

/// `rebuild` resuming at `resume.0` from the state after the feature before
/// it, reporting every replayed feature to `tap`. A snapshot the document
/// numbers differently is ignored and the whole timeline replays.
pub fn rebuild_from(
    doc: &CadDocument,
    raw: &Value,
    watch: &dyn Watch,
    resume: Option<(usize, Snapshot)>,
    tap: &mut dyn Tap,
) -> Result<Rebuild, Cancelled> {
    crate::par::configure_occt();
    let params: HashMap<String, f64> = doc
        .parameters
        .iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.get()))
        .collect();
    let hidden_bodies = doc
        .body_visibility
        .iter()
        .flatten()
        .filter(|(_, vis)| !**vis)
        .map(|(k, _)| k.clone())
        .collect();
    let recorded = doc.body_ids.clone();
    let mut ctx = Ctx {
        params,
        datums: IndexMap::new(),
        sketches: HashMap::new(),
        bodies: Vec::new(),
        diagnostics: Vec::new(),
        hidden_bodies,
        sketch_planes: IndexMap::new(),
        datum_marks: IndexMap::new(),
        projections: Vec::new(),
        tools: HashMap::new(),
        patterned: HashSet::new(),
        timeline: Vec::new(),
        ids: BodyIds::new(recorded.clone()),
    };
    let raw_features: Vec<Value> = raw
        .get("features")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let features: Vec<Feature> = raw_features.iter().map(typed).collect();
    ctx.patterned = features
        .iter()
        .filter_map(features::pattern_sources)
        .flatten()
        .cloned()
        .collect();
    ctx.timeline = raw_features
        .iter()
        .map(|r| Step {
            id: r.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
            kind: r.get("type").and_then(Value::as_str).unwrap_or("").to_owned(),
            label: label_of(r),
        })
        .collect();
    let mut errors: Vec<FeatureError> = Vec::new();

    let mut start = 0;
    if let Some((at, snap)) = resume {
        if at <= features.len()
            && tools_kept(&features, at, &snap.tools)
            && ctx.ids.restore(&snap.id_events)
        {
            start = at;
            ctx.tools = snap.tools;
            ctx.bodies = snap.bodies;
            ctx.sketches = snap.sketches;
            ctx.datums = snap.datums;
            ctx.sketch_planes = snap.sketch_planes;
            ctx.datum_marks = snap.datum_marks;
            ctx.diagnostics = snap.diagnostics;
            errors = snap.errors;
            if snap.replay_sketches {
                let kept = ctx.diagnostics.len();
                for f in &features[..start] {
                    if let Feature::Sketch(s) = f {
                        let _ = features::sketch::handle(&mut ctx, s);
                    }
                }
                ctx.diagnostics.truncate(kept);
            }
        } else {
            ctx.ids = BodyIds::new(recorded.clone());
        }
    }

    let mut inactive: Vec<String> = Vec::new();
    for f in &features {
        if let Ok(true) = is_inactive(&ctx, f.active_when()) {
            inactive.push(f.id().to_owned());
        }
    }

    for (i, (f, rawf)) in features.iter().zip(&raw_features).enumerate().skip(start) {
        if watch.cancelled() {
            return Err(Cancelled);
        }
        let began = Instant::now();
        crate::trace::begin();
        let fid = rawf.get("id").and_then(Value::as_str);
        ctx.ids.start_feature(fid.unwrap_or("None"));
        let type_name = rawf.get("type").and_then(Value::as_str);
        let prov = !type_name.is_some_and(|t| NOT_PROVENANCE.contains(&t))
            && !inactive.iter().any(|x| Some(x.as_str()) == fid);
        let pre: Vec<(u64, u64)> = if prov {
            ctx.bodies.iter().map(|b| (b.uid, b.generation)).collect()
        } else {
            Vec::new()
        };
        let pre_owners: Vec<(u64, Owners)> = if prov {
            ctx.bodies
                .iter()
                .map(|b| (b.uid, b.owners.clone()))
                .collect()
        } else {
            Vec::new()
        };
        let pre_shapes: Vec<(u64, u64, Shape)> = if prov {
            ctx.bodies
                .iter()
                .map(|b| (b.uid, b.generation, b.shape.clone()))
                .collect()
        } else {
            Vec::new()
        };

        let outcome = run_feature(&mut ctx, f, type_name, watch);
        // A feature a cancel cut short failed for no reason of its own, and
        // must not reach the cache as though it had.
        if watch.cancelled() {
            return Err(Cancelled);
        }
        let label = label_of(rawf);
        let detail = || Some(failure_detail(&ctx, i, type_name, began.elapsed()));
        match outcome {
            Ok(Ran::Inactive) => {}
            Ok(Ran::Built) => {
                if prov {
                    owners::update(&mut ctx, f, fid.unwrap_or(""), &pre, &pre_owners);
                    note_splits(&mut ctx, fid.unwrap_or(""), rawf, &pre_shapes);
                }
                if type_name == Some("sketch") {
                    crate::projection::refresh(&mut ctx, rawf, &raw_features[..i]);
                }
            }
            Err(Fail::Value { message, code }) => errors.push(FeatureError {
                feature_id: fid.map(str::to_owned),
                message,
                code: code.map(str::to_owned),
                detail: detail(),
            }),
            Err(Fail::Missing(key)) => errors.push(FeatureError {
                feature_id: fid.map(str::to_owned),
                message: format!("{label} is missing the field \"{key}\""),
                code: Some(BAD_REQUEST.to_owned()),
                detail: detail(),
            }),
            Err(Fail::Internal(name)) => {
                eprintln!("feature {} ({label}) failed: {name}", fid.unwrap_or("None"));
                errors.push(FeatureError {
                    feature_id: fid.map(str::to_owned),
                    message: format!("{label} failed ({name})"),
                    code: None,
                    detail: detail(),
                });
            }
        }
        tap.after_feature(
            i,
            &State {
                ctx: &ctx,
                errors: &errors,
            },
            began.elapsed(),
        );
        watch.feature(i);
    }

    if !inactive.is_empty() && !errors.is_empty() {
        let resulting = ctx.ids.resulting_map();
        for e in &mut errors {
            if e.message.contains("switched off") {
                continue;
            }
            let index = raw_features
                .iter()
                .position(|r| r.get("id").and_then(Value::as_str) == e.feature_id.as_deref());
            let by_id = index.map(|k| &raw_features[k]);
            if let Some(off) = by_id.and_then(|node| references_any(node, &inactive)) {
                e.message
                    .push_str(&format!(" ({off} is switched off by its activeWhen)"));
                continue;
            }
            if recorded.is_some() {
                if let Some(owner) = switched_off_owner(&e.message, &resulting, &inactive) {
                    e.message
                        .push_str(&format!(" ({owner} is switched off by its activeWhen)"));
                }
                continue;
            }
            let upstream: Vec<&str> = raw_features[..index.unwrap_or(0)]
                .iter()
                .filter_map(|r| r.get("id").and_then(Value::as_str))
                .filter(|id| inactive.iter().any(|x| x == id))
                .collect();
            if let Some(last) = upstream.last() {
                if e.message.to_lowercase().contains("body") {
                    e.message.push_str(&format!(
                        " ({last} is switched off by its activeWhen and makes no bodies, so the body ids after it shift)"
                    ));
                }
            }
        }
    }

    let body_ids = ctx.ids.resulting_map();
    let bodies = std::mem::take(&mut ctx.bodies)
        .into_iter()
        .map(|b| BuiltBody {
            identity: (b.uid, b.generation),
            shape: if b.intact {
                b.shape
            } else {
                kernel::drop_debris(&b.shape)
            },
            id: b.id,
            name: b.name,
            owners: b.owners,
            mesh_passes: b.mesh_passes,
            node_ref: b.node_ref,
            face_colors: b.face_colors,
            part_color: b.part_color,
        })
        .collect();
    Ok(Rebuild {
        bodies,
        errors,
        diagnostics: ctx.diagnostics,
        datum_planes: ctx.datums,
        sketch_planes: ctx.sketch_planes,
        datum_marks: ctx.datum_marks,
        body_ids,
        projection_updates: ctx.projections,
    })
}

enum Ran {
    Built,
    Inactive,
}

fn run_feature(
    ctx: &mut Ctx,
    f: &Feature,
    type_name: Option<&str>,
    watch: &dyn Watch,
) -> FResult<Ran> {
    let Some(t) = type_name else {
        return Err(Fail::Missing("type".into()));
    };
    if is_inactive(ctx, f.active_when())? {
        return Ok(Ran::Inactive);
    }
    match f {
        Feature::Invalid(inv) => Err(invalid_to_fail(&inv.error)),
        #[cfg(feature = "plugins")]
        Feature::Unknown(raw) => match crate::plugins::run_feature(ctx, t, raw, watch.cancel_token()) {
            Some(r) => r.map(|()| Ran::Built),
            None => Err(Fail::msg(format!("unknown feature type: {t}"))),
        },
        #[cfg(not(feature = "plugins"))]
        Feature::Unknown(_) => {
            let _ = watch;
            Err(Fail::msg(format!("unknown feature type: {t}")))
        }
        known => features::dispatch(ctx, known).map(|()| Ran::Built),
    }
}

/// The engine's result object, server.py `_rebuild_job` minus the meshes:
/// everything but `bodies`, which the reply fills in.
pub fn result_fields(doc: &CadDocument, r: &Rebuild) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("protocol".into(), json!(2));
    m.insert("bodies".into(), json!([]));
    m.insert("bbox".into(), Value::Null);
    let changed = match &doc.body_ids {
        Some(old) => *old != r.body_ids,
        None => true,
    };
    if changed {
        m.insert("bodyIds".into(), json!(r.body_ids));
    }
    if r.bodies.is_empty() && !r.projection_updates.is_empty() {
        m.insert("projectionUpdates".into(), Value::Array(r.projection_updates.clone()));
    }
    if !r.datum_planes.is_empty() {
        m.insert("datumPlanes".into(), json!(r.datum_planes));
    }
    if !r.sketch_planes.is_empty() {
        m.insert("sketchPlanes".into(), json!(r.sketch_planes));
    }
    if !r.datum_marks.is_empty() {
        m.insert("datumMarks".into(), json!(r.datum_marks));
    }
    if !r.bodies.is_empty() {
        if !r.diagnostics.is_empty() {
            m.insert("diagnostics".into(), Value::Array(r.diagnostics.clone()));
        }
        if !r.projection_updates.is_empty() {
            m.insert("projectionUpdates".into(), Value::Array(r.projection_updates.clone()));
        }
        if let Some(last) = r.errors.last() {
            m.insert("featureError".into(), last.wire());
            m.insert(
                "featureErrors".into(),
                Value::Array(r.errors.iter().map(FeatureError::wire_full).collect()),
            );
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_suffixes_strip_like_the_python_regex() {
        assert_eq!(strip_key_suffix("f1:0"), "f1");
        assert_eq!(strip_key_suffix("f1:12#"), "f1");
        assert_eq!(strip_key_suffix("imp/3"), "imp");
        assert_eq!(strip_key_suffix("plain"), "plain");
        assert_eq!(strip_key_suffix("a:b"), "a:b");
    }

    #[test]
    fn body_tokens_need_word_boundaries() {
        assert_eq!(
            body_tokens("no such body body3, body5 x"),
            vec!["body3", "body5"]
        );
        assert!(body_tokens("somebody12 body").is_empty());
    }
}
