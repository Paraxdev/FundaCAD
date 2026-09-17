//! Timeline replay, replacing sidecar/builder.py `rebuild` and the helpers of
//! sidecar/handler_util.py.
//!
//! The document's features run in order against an ordered list of bodies. A
//! feature that fails is a no-op with an error naming it, and the build goes
//! on. Bodies get their ids from `BodyIds` exactly as the Python engine assigns
//! them, so a document keeps its ids whichever engine built it.

mod fmt;
pub mod owners;
pub mod plane;

use std::collections::{HashMap, HashSet};

use fundacad_core::body_ids::{number, BodyIds};
use fundacad_core::schema::{CadDocument, Feature, Num, UnresolvedNum};
use indexmap::IndexMap;
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

use crate::features;
use crate::kernel::{self, KernelError};
pub use fmt::py_g;
pub use owners::Owners;
pub use plane::PlaneRecord;

/// Machine codes of sidecar/errors.py.
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
        Fail::Internal(e.0)
    }
}

pub type FResult<T = ()> = Result<T, Fail>;

/// One entry of the build's error list, `{feature_id, message, code?}`.
#[derive(Debug, Clone, PartialEq)]
pub struct FeatureError {
    pub feature_id: Option<String>,
    pub message: String,
    pub code: Option<String>,
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
}

pub struct Body {
    uid: u64,
    generation: u64,
    pub id: String,
    pub name: String,
    shape: Shape,
    pub owners: Owners,
    /// Mesh pass specs a plugin stashed, `plugin_geometry.BODY_KEY`.
    pub mesh_passes: Vec<Value>,
}

impl Body {
    pub fn shape(&self) -> &Shape {
        &self.shape
    }
}

/// A located sketch: the whole profile, its region cells, the hole positions
/// and sweep path it offers, and its plane.
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

/// What a handler reads and edits, sidecar/builder.py `_RebuildCtx`.
pub struct Ctx {
    params: HashMap<String, f64>,
    pub datums: IndexMap<String, PlaneRecord>,
    pub sketches: HashMap<String, SketchEntry>,
    pub bodies: Vec<Body>,
    pub diagnostics: Vec<Value>,
    pub hidden_bodies: HashSet<String>,
    pub sketch_planes: IndexMap<String, Value>,
    pub datum_marks: IndexMap<String, Value>,
    ids: BodyIds,
    next_uid: u64,
}

impl Ctx {
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
            ids: BodyIds::new(None),
            next_uid: 0,
        }
    }

    fn bump(&mut self) -> u64 {
        self.next_uid += 1;
        self.next_uid
    }

    /// `new_body`: the next id for this feature, `Body<n>` unless named.
    pub fn new_body(&mut self, shape: Shape, name: Option<String>, inherit: Option<&str>) -> usize {
        let key = self.ids.key(None);
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

    pub fn shapes(&self) -> Vec<&Shape> {
        self.bodies.iter().map(|b| &b.shape).collect()
    }
}

/// A body as the build leaves it, debris dropped.
pub struct BuiltBody {
    pub id: String,
    pub name: String,
    pub shape: Shape,
    pub owners: Owners,
    pub mesh_passes: Vec<Value>,
}

pub struct Rebuild {
    pub bodies: Vec<BuiltBody>,
    pub errors: Vec<FeatureError>,
    pub diagnostics: Vec<Value>,
    pub datum_planes: IndexMap<String, PlaneRecord>,
    pub sketch_planes: IndexMap<String, Value>,
    pub datum_marks: IndexMap<String, Value>,
    pub body_ids: IndexMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// Hooks the engine hands a rebuild: progress per feature, cancel between them.
pub trait Watch {
    fn feature(&self, _index: usize) {}
    fn cancelled(&self) -> bool {
        false
    }
    /// The flag behind `cancelled`, for work that polls it off this thread.
    fn cancel_token(&self) -> Option<fundacad_protocol::CancelToken> {
        None
    }
}

pub struct NoWatch;
impl Watch for NoWatch {}

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

/// Replays `doc`. `raw` is the same document as JSON, which is what a
/// feature's label and references are read from.
pub fn rebuild(doc: &CadDocument, raw: &Value, watch: &dyn Watch) -> Result<Rebuild, Cancelled> {
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
        ids: BodyIds::new(recorded.clone()),
        next_uid: 0,
    };
    let raw_features: Vec<Value> = raw
        .get("features")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let features: Vec<Feature> = raw_features.iter().map(typed).collect();
    let mut errors: Vec<FeatureError> = Vec::new();

    let mut inactive: Vec<String> = Vec::new();
    for f in &features {
        if let Ok(true) = is_inactive(&ctx, f.active_when()) {
            inactive.push(f.id().to_owned());
        }
    }

    for (i, (f, rawf)) in features.iter().zip(&raw_features).enumerate() {
        if watch.cancelled() {
            return Err(Cancelled);
        }
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

        let outcome = run_feature(&mut ctx, f, type_name, watch);
        let label = label_of(rawf);
        match outcome {
            Ok(Ran::Inactive) => {}
            Ok(Ran::Built) => {
                if prov {
                    owners::update(&mut ctx, f, fid.unwrap_or(""), &pre, &pre_owners);
                }
            }
            Err(Fail::Value { message, code }) => errors.push(FeatureError {
                feature_id: fid.map(str::to_owned),
                message,
                code: code.map(str::to_owned),
            }),
            Err(Fail::Missing(key)) => errors.push(FeatureError {
                feature_id: fid.map(str::to_owned),
                message: format!("{label} is missing the field \"{key}\""),
                code: Some(BAD_REQUEST.to_owned()),
            }),
            Err(Fail::Internal(name)) => {
                eprintln!("feature {} ({label}) failed: {name}", fid.unwrap_or("None"));
                errors.push(FeatureError {
                    feature_id: fid.map(str::to_owned),
                    message: format!("{label} failed ({name})"),
                    code: None,
                });
            }
        }
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
            id: b.id,
            name: b.name,
            shape: kernel::drop_debris(&b.shape),
            owners: b.owners,
            mesh_passes: b.mesh_passes,
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
        if let Some(last) = r.errors.last() {
            m.insert("featureError".into(), last.wire());
            m.insert(
                "featureErrors".into(),
                Value::Array(r.errors.iter().map(FeatureError::wire).collect()),
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
