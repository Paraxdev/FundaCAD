//! Selector resolution, replacing sidecar/geom_select.py (with its tuning,
//! sidecar/selector_tuning.json).
//!
//! Geometry is never referenced by index: a selector is a stored description
//! (a pick point, a fingerprint, a direction) re-resolved against the rebuilt
//! body every time. The forms and their rules are the Python module's, read as
//! JSON the way the Python reads a dict, so a document resolves to the same
//! entities, the same diagnostics and the same refusals in both engines.
//!
//! Edge forms: `axis`, `all`, `nearest`, `match`, `tangentChain`, `ofFace`, and a
//! face selector in an edge field (the edges around those faces). Face forms:
//! `normal`, `nearest`, `match`, `all`. A list of selectors is their union.

pub mod entity;
mod plane;
pub mod tuning;

use std::cmp::Ordering;
use std::collections::HashSet;

use fundacad_core::schema::{OneOrMany, Selector};
use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, CurveType};
use serde_json::{json, Map, Value};

use crate::builder::{Ctx, FResult, Fail};
use crate::kernel;
use entity::{
    circle_groups, edge_cost, edges_of, face_cost, faces_of, key_bits, key_cmp, need, num,
    py_round, unit, vector, EdgeEnt, FaceEnt, Key,
};
pub use plane::plane_fallback_reason;
pub use tuning::Tuning;

/// The reference codes of sidecar/errors.py.
pub const AMBIGUOUS_REFERENCE: &str = "ambiguousReference";
pub const REFERENCE_NOT_FOUND: &str = "referenceNotFound";
pub const PLANE_TILTED: &str = "planeTilted";

pub const REASON_SLID_OUT: &str = "this face moved out from under the saved pick point, it was recovered by the surface it still lies in, re-pick it if this is not the right face";

const SHARED_POINT_TOL: f64 = 1e-6;
const ON_SURFACE_TOL: f64 = 1e-4;

/// One resolution's settings and where its diagnostics go. A diagnostic is a
/// `ResolveDiag` object, pushed only when a resolution is worth acting on
/// (lossy, or below 0.5 confidence), exactly as `_push_diag` gates it.
pub struct Resolver<'a> {
    pub tuning: &'a Tuning,
    pub diag: Option<&'a mut Vec<Value>>,
    pub feature_id: Option<&'a str>,
}

enum Kind {
    Edge,
    Face,
}

impl Kind {
    fn name(&self) -> &'static str {
        match self {
            Kind::Edge => "edge",
            Kind::Face => "face",
        }
    }
}

/// What a `by:"nearest"` tie resolves to, or the refusal.
struct Nearest {
    index: usize,
}

fn as_object<'v>(sel: &'v Value) -> FResult<&'v Map<String, Value>> {
    sel.as_object()
        .ok_or_else(|| Fail::Internal("AttributeError".into()))
}

/// Python's `repr` of a `by` value in "unknown ... selector: {by}".
fn by_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// `nth` as `_resolve_one` reads it: whether one was given, and the int.
fn nth_of(sel: &Map<String, Value>) -> (bool, Option<i64>) {
    match sel.get("nth") {
        None | Some(Value::Null) => (false, None),
        Some(Value::Bool(b)) => (true, Some(i64::from(*b))),
        Some(Value::Number(n)) => (true, n.as_i64()),
        Some(_) => (true, None),
    }
}

fn pick_nth(nth: Option<i64>, len: usize) -> Option<usize> {
    nth.and_then(|n| usize::try_from(n).ok()).filter(|&n| n < len)
}

/// `_finite3(seq, want=3)`: three finite numbers rounded to 6 places.
pub(crate) fn finite3(v: Option<&Value>) -> Option<[f64; 3]> {
    let items = v?.as_array()?;
    if items.len() != 3 {
        return None;
    }
    let mut out = [0.0; 3];
    for (slot, item) in out.iter_mut().zip(items) {
        let x = item.as_f64().filter(|x| x.is_finite())?;
        *slot = py_round(x, 6);
    }
    Some(out)
}

fn stable_sort_by_cost(scored: &mut [(f64, usize)]) {
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
}

fn margin_of(best: f64, runner: f64) -> f64 {
    if runner.is_finite() {
        (runner - best) / (runner + 1e-9)
    } else {
        1.0
    }
}

impl<'a> Resolver<'a> {
    /// The shipped tuning, diagnostics into `diag` tagged with `feature_id`.
    pub fn new(diag: Option<&'a mut Vec<Value>>, feature_id: Option<&'a str>) -> Resolver<'a> {
        Resolver {
            tuning: Tuning::shipped(),
            diag,
            feature_id,
        }
    }

    pub fn with_tuning(mut self, tuning: &'a Tuning) -> Resolver<'a> {
        self.tuning = tuning;
        self
    }

    /// Typed selectors from a feature field, resolved to edges.
    pub fn edge_selectors(&mut self, part: &Shape, sel: &OneOrMany<Selector>) -> FResult<Vec<Shape>> {
        let v = serde_json::to_value(sel).map_err(|_| Fail::Internal("TypeError".into()))?;
        self.edges(part, &v)
    }

    /// Typed selectors from a feature field, resolved to faces.
    pub fn face_selectors(&mut self, part: &Shape, sel: &OneOrMany<Selector>) -> FResult<Vec<Shape>> {
        let v = serde_json::to_value(sel).map_err(|_| Fail::Internal("TypeError".into()))?;
        self.faces(part, &v)
    }

    /// `resolve_edges`: a selector or a list of them to edges of `part`.
    pub fn edges(&mut self, part: &Shape, sel: &Value) -> FResult<Vec<Shape>> {
        if kernel::is_null(part) {
            return Err(Fail::msg("no part to select edges from"));
        }
        Ok(self.edge_ents(part, sel)?.into_iter().map(|e| e.shape).collect())
    }

    /// `resolve_faces`: a selector or a list of them to faces of `part`.
    pub fn faces(&mut self, part: &Shape, sel: &Value) -> FResult<Vec<Shape>> {
        if kernel::is_null(part) {
            return Err(Fail::msg("no part to select faces from"));
        }
        Ok(self.face_ents(part, sel)?.into_iter().map(|f| f.shape).collect())
    }

    fn edge_ents(&mut self, part: &Shape, sel: &Value) -> FResult<Vec<EdgeEnt>> {
        if let Value::Array(list) = sel {
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for s in list {
                for e in self.edge_ents(part, s)? {
                    if seen.insert(key_bits(&e.dedup_key())) {
                        out.push(e);
                    }
                }
            }
            return Ok(out);
        }
        let m = as_object(sel)?;
        // A face selector in an edge field means the edges around those faces.
        // Read as an edge `nearest`, its point would round to whichever edge
        // happened to be closest.
        if m.get("kind").and_then(Value::as_str) == Some("face") {
            let faces = self.face_ents(part, sel)?;
            return union_face_edges(&faces);
        }
        match m.get("by").and_then(Value::as_str) {
            Some("axis") => {
                let axis = match need(m, "axis")? {
                    Value::String(s) => match s.as_str() {
                        "X" => [1.0, 0.0, 0.0],
                        "Y" => [0.0, 1.0, 0.0],
                        "Z" => [0.0, 0.0, 1.0],
                        other => return Err(Fail::Missing(other.to_owned())),
                    },
                    _ => return Err(Fail::Internal("TypeError".into())),
                };
                let tol = 1e-5_f64.to_radians();
                let mut out = Vec::new();
                for e in edges_of(part)? {
                    if sa::edge_line_parallel(&e.shape, axis, tol).ok_or_else(entity::internal)? {
                        out.push(e);
                    }
                }
                Ok(out)
            }
            Some("all") => edges_of(part),
            Some("nearest") => {
                let p = vector(need(m, "point")?)?;
                let edges = edges_of(part)?;
                let dists: Vec<f64> = edges.iter().map(|e| (e.mid - p).length()).collect();
                let keys: Vec<Key> = edges.iter().map(EdgeEnt::canonical_key).collect();
                let described = |i: usize| Ok(edges[i].describe());
                let pick = self.nearest_one(Kind::Edge, m, &dists, &keys, described, |_: &[usize]| None)?;
                Ok(take(edges, &[pick.index]))
            }
            Some("match") => {
                let fp = as_object(need(m, "fp")?)?;
                let mut edges = edges_of(part)?;
                // A circle reference stays on a circle while any exist, so a rim
                // cannot collapse onto a straight edge when its position drifts.
                if fp.get("curve").and_then(Value::as_str) == Some("circle")
                    && edges.iter().any(|e| e.curve == CurveType::Circle)
                {
                    edges.retain(|e| e.curve == CurveType::Circle);
                }
                let (best, conf, lossy, reason) = self.match_edge(part, &edges, fp, nth_of(m))?;
                self.push(
                    "edge",
                    usize::from(best.is_some()),
                    conf,
                    lossy,
                    reason.map(Value::from),
                    None,
                    None,
                    None,
                );
                Ok(best.map(|i| take(edges, &[i])).unwrap_or_default())
            }
            Some("ofFace") => {
                let faces = self.faces_matching(part, need(m, "face")?, (false, None))?;
                union_face_edges(&faces)
            }
            Some("tangentChain") => {
                let fp = as_object(need(m, "seed")?)?;
                let edges = edges_of(part)?;
                let (seed, conf, lossy, reason) = self.match_edge(part, &edges, fp, (false, None))?;
                let Some(seed) = seed else {
                    self.push(
                        "edge",
                        0,
                        0.0,
                        true,
                        Some(Value::from("tangentChain seed not found")),
                        None,
                        None,
                        None,
                    );
                    return Ok(Vec::new());
                };
                let chain = tangent_chain(self.tuning, &edges, seed);
                self.push(
                    "edge",
                    chain.len(),
                    conf,
                    lossy,
                    reason.map(Value::from),
                    None,
                    None,
                    None,
                );
                Ok(take(edges, &chain))
            }
            _ => Err(Fail::msg(format!(
                "unknown edge selector: {}",
                by_text(m.get("by"))
            ))),
        }
    }

    fn face_ents(&mut self, part: &Shape, sel: &Value) -> FResult<Vec<FaceEnt>> {
        if let Value::Array(list) = sel {
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for s in list {
                for f in self.face_ents(part, s)? {
                    if seen.insert(key_bits(&f.dedup_key())) {
                        out.push(f);
                    }
                }
            }
            return Ok(out);
        }
        let m = as_object(sel)?;
        match m.get("by").and_then(Value::as_str) {
            Some("normal") => {
                let d = unit(vector(need(m, "dir")?)?);
                let mut faces = faces_of(part)?;
                faces.retain(|f| f.normal().dot(d) > 0.99);
                Ok(faces)
            }
            Some("nearest") => {
                let p = vector(need(m, "point")?)?;
                let faces = faces_of(part)?;
                // Bounded distance, or centre distance for every face when any
                // face cannot be measured, so the margin compares like with like.
                let bounded: Option<Vec<f64>> =
                    faces.iter().map(|f| f.distance(p).map(|d| d.0)).collect();
                let dists = bounded.unwrap_or_else(|| {
                    faces.iter().map(|f| (f.centroid() - p).length()).collect()
                });
                let keys: Vec<Key> = faces.iter().map(FaceEnt::canonical_key).collect();
                let tie_band = self.tuning.nearest_tie_band;
                let described = |i: usize| faces[i].describe();
                let pick = self.nearest_one(Kind::Face, m, &dists, &keys, described, |tied: &[usize]| {
                    slid_out_winner(&faces, tied, p, tie_band)
                })?;
                Ok(take(faces, &[pick.index]))
            }
            Some("all") => faces_of(part),
            Some("match") => self.faces_matching(part, need(m, "fp")?, nth_of(m)),
            _ => Err(Fail::msg(format!(
                "unknown face selector: {}",
                by_text(m.get("by"))
            ))),
        }
    }

    /// `_resolve_one` over edge costs, `(index, confidence, lossy, reason)`.
    fn match_edge(
        &self,
        part: &Shape,
        edges: &[EdgeEnt],
        fp: &Map<String, Value>,
        nth: (bool, Option<i64>),
    ) -> FResult<(Option<usize>, f64, bool, Option<&'static str>)> {
        let tol_pos = self.tuning.pos_tol(sa::bbox_diagonal(part));
        let ranks = circle_groups(edges, tol_pos);
        let costs = edges
            .iter()
            .zip(&ranks)
            .map(|(e, r)| edge_cost(self.tuning, e, fp, tol_pos, *r))
            .collect::<FResult<Vec<f64>>>()?;
        let keys: Vec<Key> = edges.iter().map(EdgeEnt::canonical_key).collect();
        Ok(resolve_one(self.tuning, &costs, &keys, nth))
    }

    /// `_faces_matching`: one face by fingerprint, never a refusal.
    fn faces_matching(
        &mut self,
        part: &Shape,
        fp: &Value,
        nth: (bool, Option<i64>),
    ) -> FResult<Vec<FaceEnt>> {
        let fp = as_object(fp)?;
        let tol_pos = self.tuning.pos_tol(sa::bbox_diagonal(part));
        let faces = faces_of(part)?;
        let costs = faces
            .iter()
            .map(|f| face_cost(self.tuning, f, fp, tol_pos))
            .collect::<FResult<Vec<f64>>>()?;
        let keys: Vec<Key> = faces.iter().map(FaceEnt::canonical_key).collect();
        let (best, conf, lossy, reason) = resolve_one(self.tuning, &costs, &keys, nth);
        self.push(
            "face",
            usize::from(best.is_some()),
            conf,
            lossy,
            reason.map(Value::from),
            None,
            None,
            None,
        );
        Ok(best.map(|i| take(faces, &[i])).unwrap_or_default())
    }

    /// `_nearest_one`: the nearest candidate, or a refusal when the runner-up is
    /// within NEAREST_TIE_BAND. Ambiguity is the discriminator, not distance: a
    /// face that moved far from its pick point still resolves while it is the
    /// unique nearest.
    fn nearest_one(
        &mut self,
        kind: Kind,
        sel: &Map<String, Value>,
        dists: &[f64],
        keys: &[Key],
        describe: impl Fn(usize) -> FResult<String>,
        tie_breaker: impl Fn(&[usize]) -> Option<(usize, f64)>,
    ) -> FResult<Nearest> {
        let name = kind.name();
        if dists.is_empty() {
            return Err(Fail::Value {
                message: format!("no {name} to select from"),
                code: Some(REFERENCE_NOT_FOUND),
            });
        }
        // Candidates no pick could tell apart collapse first: two prisms fused at
        // one corner line carry that edge twice, and it must not tie with itself.
        let mut seen = HashSet::new();
        let mut scored: Vec<(f64, usize)> = (0..dists.len())
            .filter(|&i| seen.insert(key_bits(&keys[i])))
            .map(|i| (dists[i], i))
            .collect();
        stable_sort_by_cost(&mut scored);
        let (best_d, best) = scored[0];
        let runner = scored.get(1).map_or(f64::INFINITY, |s| s.0);
        let margin = margin_of(best_d, runner);
        let band = self.tuning.nearest_tie_band;
        // A clear winner records nothing, however slim: `confidence` here would
        // be a distance margin, and a consumer reads anything under 0.5 as a
        // poor fingerprint match.
        if margin >= band {
            return Ok(Nearest { index: best });
        }

        let mut tied: Vec<usize> = scored
            .iter()
            .filter(|(d, _)| (d - best_d) / (runner + 1e-9) < band)
            .map(|s| s.1)
            .collect();
        tied.sort_by(|a, b| key_cmp(&keys[*a], &keys[*b]));
        if let Some(n) = pick_nth(nth_of(sel).1, tied.len()) {
            self.push(name, 1, margin, true, Some("tie broken by nth".into()), None, None, None);
            return Ok(Nearest { index: tied[n] });
        }

        let pt = sel.get("point").filter(|p| entity::truthy(Some(p)));
        if let Some((won, won_margin)) = tie_breaker(&tied) {
            self.push(
                name,
                1,
                won_margin,
                true,
                Some(REASON_SLID_OUT.into()),
                pt,
                None,
                Some(AMBIGUOUS_REFERENCE),
            );
            return Ok(Nearest { index: won });
        }

        let where_ = pt
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|v| format!("{:.2}", num(v).unwrap_or(f64::NAN)))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let described = tied
            .iter()
            .take(3)
            .map(|&i| describe(i))
            .collect::<FResult<Vec<String>>>()?;
        self.push(
            name,
            0,
            margin,
            true,
            Some("ambiguous nearest pick".into()),
            pt,
            Some(&described),
            None,
        );
        Err(Fail::Value {
            message: format!(
                "ambiguous {name} reference at ({where_}): {} are equally close ({best_d:.3}mm vs {runner:.3}mm), re-pick the {name}",
                described.join(" and ")
            ),
            code: Some(AMBIGUOUS_REFERENCE),
        })
    }

    /// `_push_diag`.
    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        kind: &str,
        resolved: usize,
        confidence: f64,
        lossy: bool,
        reason: Option<Value>,
        at: Option<&Value>,
        candidates: Option<&[String]>,
        code: Option<&str>,
    ) {
        let Some(diag) = self.diag.as_deref_mut() else {
            return;
        };
        if !(lossy || confidence < 0.5) {
            return;
        }
        let mut entry = json!({
            "feature_id": self.feature_id,
            "kind": kind,
            "resolved": resolved,
            "confidence": py_round(confidence, 3),
            "lossy": lossy,
            "reason": reason.unwrap_or(Value::Null),
        });
        let Value::Object(m) = &mut entry else {
            return;
        };
        // `at` is the selector's own stored point, how the frontend knows which
        // selector of a feature to offer a re-pick for. A malformed one is dropped.
        if let Some(pt) = at.and_then(|a| finite3(Some(a))) {
            m.insert("at".into(), json!(pt));
        }
        if let Some(code) = code.filter(|c| !c.is_empty()) {
            m.insert("code".into(), json!(code));
        }
        if let Some(c) = candidates.filter(|c| !c.is_empty()) {
            m.insert("candidates".into(), json!(c));
        }
        diag.push(entry);
    }

    /// `resolve_face_on_plane`: the planar face a sketch or datum plane is
    /// anchored to, or `None` with the reason recorded. Never a refusal.
    pub fn face_on_plane(
        &mut self,
        part: Option<&Shape>,
        sel: &Value,
        normal: [f64; 3],
        label: &str,
    ) -> Option<Shape> {
        plane::resolve_face_on_plane(self, part, sel, normal, label)
    }
}

fn take<T>(items: Vec<T>, idxs: &[usize]) -> Vec<T> {
    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    idxs.iter()
        .filter_map(|&i| slots.get_mut(i).and_then(Option::take))
        .collect()
}

fn union_face_edges(faces: &[FaceEnt]) -> FResult<Vec<EdgeEnt>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for f in faces {
        for e in f.edges()? {
            if seen.insert(key_bits(&e.dedup_key())) {
                out.push(e);
            }
        }
    }
    Ok(out)
}

/// `_resolve_one`: the lowest cost, never a refusal. A runner-up within
/// TIE_BAND is a tie, broken by `nth` over the canonical key order.
fn resolve_one(
    t: &Tuning,
    costs: &[f64],
    keys: &[Key],
    nth: (bool, Option<i64>),
) -> (Option<usize>, f64, bool, Option<&'static str>) {
    if costs.is_empty() {
        return (None, 0.0, true, Some("no candidates on this body"));
    }
    let mut scored: Vec<(f64, usize)> = costs.iter().copied().zip(0..).collect();
    stable_sort_by_cost(&mut scored);
    let (best_cost, best) = scored[0];
    let runner = scored.get(1).map_or(f64::INFINITY, |s| s.0);
    let margin = margin_of(best_cost, runner);
    if margin < t.tie_band {
        let mut tied: Vec<usize> = scored
            .iter()
            .filter(|(c, _)| (c - best_cost) / (runner + 1e-9) < t.tie_band)
            .map(|s| s.1)
            .collect();
        tied.sort_by(|a, b| key_cmp(&keys[*a], &keys[*b]));
        let idx = pick_nth(nth.1, tied.len()).unwrap_or(0);
        let reason = if nth.0 {
            "tie broken by nth"
        } else {
            "tie; canonical-first"
        };
        return (Some(tied[idx]), margin, !nth.0, Some(reason));
    }
    let lossy = best_cost > t.accept_max;
    (Some(best), margin, lossy, lossy.then_some("marginal match"))
}

/// `_slid_out_winner`: a `nearest` face tie at a shared edge, re-scored on the
/// untrimmed surfaces, which do separate a face the point still lies in from
/// the wall it merely touches. Narrower than the refusal it replaces.
fn slid_out_winner(faces: &[FaceEnt], tied: &[usize], p: DVec3, band: f64) -> Option<(usize, f64)> {
    if tied.len() < 2 {
        return None;
    }
    let closest: Vec<DVec3> = tied
        .iter()
        .map(|&i| faces[i].distance(p).map(|d| d.1))
        .collect::<Option<_>>()?;
    let first = closest[0];
    if closest[1..]
        .iter()
        .any(|c| (*c - first).length() > SHARED_POINT_TOL)
    {
        return None;
    }
    let mut scored: Vec<(f64, usize)> = tied
        .iter()
        .map(|&i| (sa::surface_distance(&faces[i].shape, p.to_array()), i))
        .collect();
    stable_sort_by_cost(&mut scored);
    let (best_d, best) = scored[0];
    let runner = scored[1].0;
    if !(best_d <= ON_SURFACE_TOL) || !(runner > ON_SURFACE_TOL) {
        return None;
    }
    let margin = margin_of(best_d, runner);
    if margin < band {
        return None;
    }
    Some((best, margin))
}

/// `_tangent_chain`: the seed and every edge reached through a shared vertex
/// with a collinear tangent. Visited by geometric key, as the Python does.
fn tangent_chain(t: &Tuning, edges: &[EdgeEnt], seed: usize) -> Vec<usize> {
    let tangent_at_point = |e: &EdgeEnt, p: DVec3| -> DVec3 {
        let at_start = match e.ends {
            Some((a, b)) => (a - p).length() < (b - p).length(),
            None => false,
        };
        e.tangent_at(if at_start { 0.0 } else { 1.0 })
            .unwrap_or_else(|| e.dir())
    };
    let mut seen = HashSet::from([key_bits(&edges[seed].dedup_key())]);
    let mut chain = vec![seed];
    let mut frontier = vec![seed];
    while let Some(cur) = frontier.pop() {
        let Some((a, b)) = edges[cur].ends else {
            continue;
        };
        for (i, e) in edges.iter().enumerate() {
            let k = key_bits(&e.dedup_key());
            if seen.contains(&k) {
                continue;
            }
            let Some((ea, eb)) = e.ends else {
                continue;
            };
            for shared in [a, b] {
                if (ea - shared).length() < 1e-6 || (eb - shared).length() < 1e-6 {
                    let dot = tangent_at_point(&edges[cur], shared)
                        .dot(tangent_at_point(e, shared))
                        .abs();
                    if dot > 1.0 - t.ang_tol {
                        seen.insert(k);
                        chain.push(i);
                        frontier.push(i);
                    }
                    break;
                }
            }
        }
    }
    chain
}

/// `_rank_in_center_group`: (rank, group size) of a circle among the circles of
/// `part` sharing its centre.
fn rank_in_centre_group(e: &EdgeEnt, part_edges: &[EdgeEnt], tol: f64) -> Option<(usize, usize)> {
    let (c, r) = (e.centre()?, e.radius()?);
    let sibs: Vec<f64> = part_edges
        .iter()
        .filter(|x| x.curve == CurveType::Circle)
        .filter_map(|x| Some((x.centre()?, x.radius()?)))
        .filter(|(cc, _)| (*cc - c).length() < tol)
        .map(|s| s.1)
        .collect();
    let rank = sibs.iter().filter(|&&rr| rr < r - 1e-9).count();
    Some((rank, sibs.len()))
}

/// `edge_fingerprint`: what a pick of `edge` persists for `by:"match"`.
pub fn edge_fingerprint(edge: &Shape, part: &Shape) -> FResult<Value> {
    edge_fingerprint_with(Tuning::shipped(), edge, part)
}

pub fn edge_fingerprint_with(t: &Tuning, edge: &Shape, part: &Shape) -> FResult<Value> {
    let e = EdgeEnt::new(edge.clone())?;
    let (m, d) = (e.mid, e.dir());
    let mut fp = json!({
        "mid": [m.x, m.y, m.z],
        "dir": [d.x, d.y, d.z],
        "length": e.length,
        "curve": e.curve_name(),
    });
    if e.curve == CurveType::Circle {
        if let Value::Object(o) = &mut fp {
            if let Some(r) = e.radius() {
                o.insert("radius".into(), json!(r));
            }
            if let Some(c) = e.centre() {
                o.insert("center".into(), json!([c.x, c.y, c.z]));
            }
            let tol = t.pos_tol(sa::bbox_diagonal(part));
            if let Some((rank, size)) = rank_in_centre_group(&e, &edges_of(part)?, tol) {
                o.insert("radius_rank".into(), json!(rank));
                o.insert("radius_group".into(), json!(size));
            }
        }
    }
    Ok(fp)
}

/// `face_fingerprint`.
pub fn face_fingerprint(face: &Shape) -> FResult<Value> {
    let f = FaceEnt::new(face.clone())?;
    let (c, n) = (f.centroid(), f.normal());
    let mut fp = json!({
        "centroid": [c.x, c.y, c.z],
        "normal": [n.x, n.y, n.z],
        "area": f.area,
        "surface": f.surface_name(),
    });
    if let (Some(r), Value::Object(o)) = (f.radius, &mut fp) {
        o.insert("radius".into(), json!(r));
    }
    Ok(fp)
}

/// blends.py `_group_sels_by_body`: selectors grouped by the body each one
/// names, first seen first, an unbound selector on the active body. A named
/// body that is gone refuses the feature rather than editing another one.
pub fn group_by_body<'s>(
    ctx: &Ctx,
    sels: &'s OneOrMany<Selector>,
    label: &str,
) -> FResult<Vec<(usize, Vec<&'s Selector>)>> {
    let mut groups: Vec<(usize, Vec<&Selector>)> = Vec::new();
    for s in sels.as_slice() {
        let body = match s.body().filter(|b| !b.is_empty()) {
            Some(id) => ctx
                .find_body(id)
                .ok_or_else(|| Fail::msg(format!("{label}: the target body no longer exists")))?,
            None => ctx.require_active(label)?,
        };
        let id = &ctx.bodies[body].id;
        match groups.iter_mut().find(|(b, _)| &ctx.bodies[*b].id == id) {
            Some((_, list)) => list.push(s),
            None => groups.push((body, vec![s])),
        }
    }
    Ok(groups)
}
