//! Flattening 3D geometry onto a sketch plane and recognising it again:
//! sidecar/projection.py (curves, the HLR silhouette, the silhouette
//! correspondence), sidecar/projection_refresh.py (the lenient refresh a
//! rebuild runs per sketch, and the strict `projectGeometry` op) and
//! builder.py `project_geometry`.
//!
//! Curves are JSON objects, the ProjectedCurve shapes the document stores.

use std::collections::{HashMap, HashSet};

use fundacad_core::schema::{PlaneSpec, SketchEntity, SketchFeature};
use fundacad_core::CadDocument;
use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use indexmap::IndexMap;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, CurveType};
use opencascade_sys::face_query as fq;
use opencascade_sys::hlr;
use serde_json::{json, Map, Value};

use crate::builder::plane::{plane_of, PlaneRecord, PlaneRef};
use crate::builder::{self, BuiltBody, Ctx, FResult, Fail, Watch};
use crate::features::sketch::entity_curve_edges;
use crate::kernel::{self, Frame, Kind};
use crate::select::entity::{edges_of, py_round};
use crate::select::{edge_fingerprint, Resolver};

const POLY_MIN_SEGS: usize = 16;
const POLY_MAX_SEGS: usize = 128;
const POLY_MM_PER_SEG: f64 = 0.5;

fn r6(v: f64) -> f64 {
    py_round(v, 6) + 0.0
}

fn project_pt(plane: &Frame, p: [f64; 3]) -> (f64, f64) {
    let d = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
    let dot = |a: [f64; 3]| d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    (dot(plane.x), dot(plane.y))
}

fn occt(e: cxx::Exception) -> Fail {
    Fail::Internal(e.what().split(':').next().unwrap_or("Standard_Failure").trim().to_owned())
}

fn positions(edge: &Shape, ts: &[f64]) -> FResult<Vec<[f64; 3]>> {
    let mut out = vec![0.0; ts.len() * 3];
    fq::FQ_edge_positions(edge.raw(), ts, &mut out).map_err(occt)?;
    Ok(out.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
}

/// `_project_edge_to_plane`: exact for a line, and for a circle whose axis is
/// the plane normal; sampled to a poly otherwise.
pub fn project_edge(edge: &Shape, plane: &Frame) -> FResult<Value> {
    let curve = sa::edge_probe(edge).map_or(CurveType::Other, |p| p.curve);
    let pt = |p: [f64; 3]| {
        let (x, y) = project_pt(plane, p);
        (r6(x), r6(y))
    };
    if curve == CurveType::Line {
        let ends = positions(edge, &[0.0, 1.0])?;
        let ((ax, ay), (bx, by)) = (pt(ends[0]), pt(ends[1]));
        if (bx - ax).hypot(by - ay) < 1e-6 {
            return Ok(json!({"kind": "poly", "pts": [[ax, ay], [bx, by]]}));
        }
        return Ok(json!({"kind": "line", "x1": ax, "y1": ay, "x2": bx, "y2": by}));
    }
    if curve == CurveType::Circle {
        let mut c = [0.0; 7];
        if fq::FQ_edge_circle(edge.raw(), &mut c).map_err(occt)? {
            let axis = [c[0], c[1], c[2]];
            let along = axis[0] * plane.z[0] + axis[1] * plane.z[1] + axis[2] * plane.z[2];
            if along.abs() > 1.0 - 1e-6 {
                if fq::FQ_edge_closed(edge.raw()).map_err(occt)? {
                    let (cx, cy) = pt([c[3], c[4], c[5]]);
                    return Ok(json!({"kind": "circle", "x": cx, "y": cy, "r": r6(c[6])}));
                }
                let p = positions(edge, &[0.0, 0.5, 1.0])?;
                let ((x1, y1), (mx, my), (x2, y2)) = (pt(p[0]), pt(p[1]), pt(p[2]));
                return Ok(json!({"kind": "arc", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "mx": mx, "my": my}));
            }
        }
    }
    let sampled = fq::FQ_edge_length(edge.raw()).map_err(occt).and_then(|len| {
        let n = (len / POLY_MM_PER_SEG).max(POLY_MIN_SEGS as f64).min(POLY_MAX_SEGS as f64) as usize;
        let ts: Vec<f64> = (0..=n).map(|i| i as f64 / n as f64).collect();
        positions(edge, &ts)
    });
    let samples = match sampled {
        Ok(s) => s,
        Err(e) => {
            let n = POLY_MIN_SEGS;
            let mut out = vec![0.0; (n + 1) * 3];
            match fq::FQ_edge_param_points(edge.raw(), n as i32, &mut out) {
                Ok(true) => out.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect(),
                _ => return Err(e),
            }
        }
    };
    let pts: Vec<Value> = samples
        .into_iter()
        .map(|p| {
            let (x, y) = pt(p);
            json!([x, y])
        })
        .collect();
    Ok(json!({"kind": "poly", "pts": pts}))
}

fn num(c: &Value, k: &str) -> Option<f64> {
    c.get(k).and_then(Value::as_f64)
}

fn kind(c: &Value) -> Option<&str> {
    c.get("kind").and_then(Value::as_str)
}

fn pts(c: &Value) -> Vec<(f64, f64)> {
    c.get("pts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|p| (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)))
                .collect()
        })
        .unwrap_or_default()
}

/// `_curve_close`: same kind and every number within `tol`.
pub fn curve_close(a: &Value, b: &Value, tol: f64) -> bool {
    if kind(a) != kind(b) {
        return false;
    }
    if kind(a) == Some("poly") {
        let (pa, pb) = (pts(a), pts(b));
        return pa.len() == pb.len()
            && pa.iter().zip(&pb).all(|(p, q)| (p.0 - q.0).abs() <= tol && (p.1 - q.1).abs() <= tol);
    }
    let Some(m) = a.as_object() else {
        return false;
    };
    m.iter().filter(|(k, _)| k.as_str() != "kind").all(|(k, v)| {
        match (v.as_f64(), num(b, k)) {
            (Some(x), Some(y)) => (x - y).abs() <= tol,
            _ => false,
        }
    })
}

/// `_curve_reversed`.
pub fn curve_reversed(c: &Value) -> Value {
    match kind(c) {
        Some("line") | Some("arc") => {
            let mut r = c.clone();
            for (a, b) in [("x1", "x2"), ("y1", "y2")] {
                r[a] = c[b].clone();
                r[b] = c[a].clone();
            }
            r
        }
        Some("poly") => {
            let mut p = c.get("pts").and_then(Value::as_array).cloned().unwrap_or_default();
            p.reverse();
            json!({"kind": "poly", "pts": p})
        }
        _ => c.clone(),
    }
}

type P2 = (f64, f64);

fn f(c: &Value, k: &str) -> f64 {
    num(c, k).unwrap_or(0.0)
}

/// `_curve_rep`: (end, end, mid).
fn curve_rep(c: &Value) -> (P2, P2, P2) {
    match kind(c) {
        Some("line") => (
            (f(c, "x1"), f(c, "y1")),
            (f(c, "x2"), f(c, "y2")),
            ((f(c, "x1") + f(c, "x2")) / 2.0, (f(c, "y1") + f(c, "y2")) / 2.0),
        ),
        Some("arc") => ((f(c, "x1"), f(c, "y1")), (f(c, "x2"), f(c, "y2")), (f(c, "mx"), f(c, "my"))),
        Some("circle") => ((f(c, "x"), f(c, "y")), (f(c, "x"), f(c, "y")), (f(c, "x") + f(c, "r"), f(c, "y"))),
        _ => {
            let mut p = pts(c);
            if p.is_empty() {
                p.push((0.0, 0.0));
            }
            (p[0], p[p.len() - 1], p[p.len() / 2])
        }
    }
}

fn dist(p: P2, q: P2) -> f64 {
    (p.0 - q.0).hypot(p.1 - q.1)
}

/// `_curve_dist`: endpoint distance either way round plus the midpoint's.
pub fn curve_dist(a: &Value, b: &Value) -> f64 {
    if kind(a) != kind(b) {
        return f64::INFINITY;
    }
    let ((a1, a2, am), (b1, b2, bm)) = (curve_rep(a), curve_rep(b));
    (dist(a1, b1) + dist(a2, b2)).min(dist(a1, b2) + dist(a2, b1)) + dist(am, bm)
}

pub fn curve_close_either(a: &Value, b: &Value) -> bool {
    curve_close(a, b, 1e-4) || curve_close(&curve_reversed(a), b, 1e-4)
}

/// `_curve_oriented`: `c` or its reverse, whichever keeps `cached`'s end order.
fn curve_oriented(c: &Value, cached: &Value) -> Value {
    let ((c1, c2, _), (q1, q2, _)) = (curve_rep(c), curve_rep(cached));
    if dist(c1, q2) + dist(c2, q1) < dist(c1, q1) + dist(c2, q2) {
        curve_reversed(c)
    } else {
        c.clone()
    }
}

/// `_project_silhouette`: the visible outline of `shape` on `plane`.
pub fn silhouette(shape: &Shape, plane: &Frame) -> FResult<Vec<Value>> {
    let (o, n, x) = (plane.origin, plane.z, plane.x);
    let frame = [o[0], o[1], o[2], n[0], n[1], n[2], x[0], x[1], x[2]];
    let raw = hlr::HLR_visible_outline(shape.raw(), &frame).map_err(occt)?;
    let buckets = Shape::from_raw(raw);
    let xy = Frame { origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0] };
    let mut curves: Vec<Value> = Vec::new();
    for bucket in kernel::children(&buckets) {
        for edge in kernel::subshapes(&bucket, Kind::Edge) {
            let c = project_edge(&edge, &xy)?;
            if kind(&c) == Some("poly") {
                let p = pts(&c);
                let span = |g: fn(&P2) -> f64| {
                    let v: Vec<f64> = p.iter().map(g).collect();
                    v.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - v.iter().cloned().fold(f64::INFINITY, f64::min)
                };
                if span(|q| q.0) < 1e-6 && span(|q| q.1) < 1e-6 {
                    continue;
                }
            }
            if curves.iter().any(|q| curve_close_either(&c, q)) {
                continue;
            }
            curves.push(c);
        }
    }
    Ok(curves)
}

/// `_assign_silhouette`: one group's fresh curves to its siblings, `None` stale.
pub fn assign_silhouette(sibs: &[&Value], fresh: Option<&[Value]>) -> Vec<(String, Option<Value>)> {
    let id = |e: &Value| e.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
    let cached = |e: &Value| e.get("curve").filter(|c| truthy(c)).cloned().unwrap_or_else(|| json!({}));
    let Some(fresh) = fresh.filter(|f| !f.is_empty()) else {
        return sibs.iter().map(|e| (id(e), None)).collect();
    };
    let mut remaining: Vec<Value> = fresh.to_vec();
    let mut out: Vec<(String, Option<Value>)> = Vec::new();
    let mut movers: Vec<&Value> = Vec::new();
    for e in sibs {
        let c = cached(e);
        match remaining.iter().position(|r| curve_close_either(r, &c)) {
            Some(k) => {
                let m = remaining.remove(k);
                out.push((id(e), Some(curve_oriented(&m, &c))));
            }
            None => movers.push(e),
        }
    }
    let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
    for (i, e) in movers.iter().enumerate() {
        let c = cached(e);
        for (j, r) in remaining.iter().enumerate() {
            let d = curve_dist(r, &c);
            if d < f64::INFINITY {
                pairs.push((d, i, j));
            }
        }
    }
    pairs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let (mut taken_sibs, mut taken_curves) = (HashSet::new(), HashSet::new());
    for (_, i, j) in pairs {
        if taken_sibs.contains(&i) || taken_curves.contains(&j) {
            continue;
        }
        out.push((id(movers[i]), Some(curve_oriented(&remaining[j], &cached(movers[i])))));
        taken_sibs.insert(i);
        taken_curves.insert(j);
    }
    let rest: Vec<&Value> = remaining
        .iter()
        .enumerate()
        .filter(|(j, _)| !taken_curves.contains(j))
        .map(|(_, c)| c)
        .collect();
    let unmatched = movers.iter().enumerate().filter(|(i, _)| !taken_sibs.contains(i));
    for (k, (_, e)) in unmatched.enumerate() {
        out.push((id(e), rest.get(k).map(|c| (*c).clone())));
    }
    out
}

fn truthy(v: &Value) -> bool {
    fundacad_protocol::pyjson::truthy(Some(v))
}

fn fail_text(f: &Fail) -> String {
    match f {
        Fail::Value { message, .. } => message.clone(),
        Fail::Missing(k) => format!("'{k}'"),
        Fail::Internal(n) => n.clone(),
    }
}

/// `_resolve_sketch_curve`: the source sketch's plane and the entity's local edges.
fn resolve_sketch_curve(
    ctx: &Ctx,
    features: &[Value],
    src: &Value,
    datums: &IndexMap<String, PlaneRecord>,
) -> FResult<(Frame, Vec<Shape>)> {
    let sid = src.get("sketch");
    let sf = features
        .iter()
        .find(|f| f.get("type").and_then(Value::as_str) == Some("sketch") && f.get("id") == sid)
        .ok_or_else(|| {
            Fail::msg(format!(
                "source sketch \"{}\" is not available here, it may have been created after this sketch",
                py_str(sid)
            ))
        })?;
    let ent = sf
        .get("entities")
        .and_then(Value::as_array)
        .and_then(|es| es.iter().find(|e| e.get("id") == src.get("entity")))
        .ok_or_else(|| Fail::msg("the source curve no longer exists in its sketch"))?;
    let typed: SketchEntity =
        serde_json::from_value(ent.clone()).map_err(|_| Fail::Internal("TypeError".into()))?;
    let eds = entity_curve_edges(ctx, &typed)?;
    if eds.is_empty() {
        return Err(Fail::msg(format!(
            "a \"{}\" entity has no curve to project",
            py_str(ent.get("type"))
        )));
    }
    let spec: PlaneSpec = sf
        .get("plane")
        .cloned()
        .ok_or_else(|| Fail::Missing("plane".into()))
        .and_then(|p| serde_json::from_value(p).map_err(|_| Fail::Internal("TypeError".into())))?;
    Ok((plane_of(PlaneRef::from(&spec), datums)?, eds))
}

/// Python `str()` of a JSON value, `None` when absent.
fn py_str(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn located_projection(edges: &[Shape], from: &Frame, to: &Frame) -> FResult<Vec<Value>> {
    edges.iter().map(|e| project_edge(&from.locate(e)?, to)).collect()
}

/// `_fresh_projection`, `None` when the source no longer resolves.
fn fresh_projection(
    ctx: &Ctx,
    e: &Value,
    plane: &Frame,
    prefix: &[Value],
    memo: &mut HashMap<(String, String), Option<Vec<Value>>>,
) -> Option<Value> {
    let src = e.get("source").cloned().unwrap_or(Value::Null);
    match src.get("kind").and_then(Value::as_str) {
        Some("edge") | Some("faceBoundary") => {
            let body = src.get("body").and_then(Value::as_str).and_then(|b| ctx.find_body(b))?;
            let shape = ctx.bodies[body].shape();
            let sel = src.get("sel").cloned().unwrap_or(Value::Null);
            let edges = Resolver::new(None, None).edges(shape, &sel).ok()?;
            project_edge(edges.first()?, plane).ok()
        }
        Some("sketchCurve") => {
            let key = (py_str(src.get("sketch")), py_str(src.get("entity")));
            let fresh = memo
                .entry(key)
                .or_insert_with(|| {
                    resolve_sketch_curve(ctx, prefix, &src, &ctx.datums)
                        .and_then(|(from, eds)| located_projection(&eds, &from, plane))
                        .ok()
                })
                .clone()?;
            match fresh.len() {
                0 => None,
                1 => fresh.into_iter().next(),
                n => {
                    let idx = src.get("index").filter(|i| i.is_i64() || i.is_u64())?.as_i64()?;
                    (0 <= idx && (idx as usize) < n).then(|| fresh[idx as usize].clone())
                }
            }
        }
        _ => None,
    }
}

/// `_recompute_projections`: the lenient refresh of one built sketch's
/// projected entities against the bodies built before it.
pub fn refresh(ctx: &mut Ctx, feature: &Value, prefix: &[Value]) {
    let ents: Vec<&Value> = feature
        .get("entities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| {
            e.get("type").and_then(Value::as_str) == Some("projected")
                && e.get("id").is_some_and(truthy)
        })
        .collect();
    if ents.is_empty() {
        return;
    }
    let Ok(typed) = serde_json::from_value::<SketchFeature>(feature.clone()) else {
        return;
    };
    let plane_ref = match typed.plane_id.as_deref() {
        Some(id) if !id.is_empty() => PlaneRef::Name(id),
        _ => PlaneRef::from(&typed.plane),
    };
    let Ok(plane) = plane_of(plane_ref, &ctx.datums) else {
        return;
    };
    let sketch_id = feature.get("id").cloned().unwrap_or(Value::Null);
    let source = |e: &Value, k: &str| e.get("source").and_then(|s| s.get(k)).cloned().unwrap_or(Value::Null);

    let mut groups: IndexMap<(String, String), Vec<&Value>> = IndexMap::new();
    for e in &ents {
        if source(e, "kind") == json!("silhouette") {
            groups
                .entry((source(e, "body").to_string(), source(e, "group").to_string()))
                .or_default()
                .push(e);
        }
    }
    let mut assigned: HashMap<String, Option<Value>> = HashMap::new();
    let mut fresh_by_body: HashMap<String, Option<Vec<Value>>> = HashMap::new();
    for ((body_key, _), group) in groups.iter_mut() {
        group.sort_by(|a, b| {
            let (ia, ib) = (py_str(a.get("id")), py_str(b.get("id")));
            (ia.len(), ia).cmp(&(ib.len(), ib))
        });
        let body_id = source(group[0], "body");
        let fresh = fresh_by_body
            .entry(body_key.clone())
            .or_insert_with(|| {
                let b = body_id.as_str().and_then(|id| ctx.find_body(id))?;
                silhouette(ctx.bodies[b].shape(), &plane).ok()
            })
            .clone();
        assigned.extend(assign_silhouette(group, fresh.as_deref()));
    }

    let mut memo = HashMap::new();
    let mut updates = Vec::new();
    for e in &ents {
        let id = py_str(e.get("id"));
        let fresh = if source(e, "kind") == json!("silhouette") {
            assigned.get(&id).cloned().flatten()
        } else {
            fresh_projection(ctx, e, &plane, prefix, &mut memo)
        };
        let stale = e.get("stale").is_some_and(truthy);
        match fresh {
            None => {
                if !stale {
                    updates.push(json!({"sketch": sketch_id, "entity": e["id"], "stale": true}));
                }
            }
            Some(c) => {
                let cached = e.get("curve").filter(|c| truthy(c)).cloned().unwrap_or_else(|| json!({}));
                if stale || !curve_close(&c, &cached, 1e-4) {
                    updates.push(json!({"sketch": sketch_id, "entity": e["id"], "curve": c, "stale": false}));
                }
            }
        }
    }
    ctx.projections.extend(updates);
}

fn require_body<'a>(bodies: &'a [BuiltBody], bid: Option<&Value>) -> FResult<&'a BuiltBody> {
    bodies
        .iter()
        .find(|b| bid.and_then(Value::as_str) == Some(b.id.as_str()))
        .ok_or_else(|| {
            Fail::msg(format!(
                "source body \"{}\" is not available here, it may have been created after this sketch",
                py_str(bid)
            ))
        })
}

/// `_project_source`: one source strictly, `[{fp?, curve}]` or a refusal.
fn project_source(
    ctx: &Ctx,
    src: &Value,
    plane: &Frame,
    document: &Value,
    bodies: &[BuiltBody],
    datums: &IndexMap<String, PlaneRecord>,
) -> FResult<Vec<Value>> {
    let kind = src.get("kind").and_then(Value::as_str);
    match kind {
        Some(k @ ("edge" | "faceBoundary")) => {
            let body = require_body(bodies, src.get("body"))?;
            let shape = &body.shape;
            let sel = src.get("sel").ok_or_else(|| Fail::Missing("sel".into()))?;
            let mut diag = Vec::new();
            let edges: Vec<Shape> = if k == "edge" {
                Resolver::new(Some(&mut diag), None).edges(shape, sel)?
            } else {
                let faces = Resolver::new(Some(&mut diag), None).faces(shape, sel)?;
                let mut seen = HashSet::new();
                let mut out = Vec::new();
                for fc in faces {
                    for e in edges_of(&fc)? {
                        if seen.insert(crate::select::entity::key_bits(&e.dedup_key())) {
                            out.push(e.shape);
                        }
                    }
                }
                out
            };
            if edges.is_empty() {
                return Err(Fail::msg("the source geometry no longer exists on the body"));
            }
            if let Some(lossy) = diag.iter().find(|d| d.get("lossy").is_some_and(truthy)) {
                let reason = lossy
                    .get("reason")
                    .filter(|r| truthy(r))
                    .and_then(Value::as_str)
                    .unwrap_or("low-confidence match");
                return Err(Fail::msg(format!("the source selection is ambiguous on this body, {reason}")));
            }
            edges
                .iter()
                .map(|e| Ok(json!({"fp": edge_fingerprint(e, shape)?, "curve": project_edge(e, plane)?})))
                .collect()
        }
        Some("sketchCurve") => {
            let features = document.get("features").and_then(Value::as_array).cloned().unwrap_or_default();
            let (from, eds) = resolve_sketch_curve(ctx, &features, src, datums)?;
            Ok(located_projection(&eds, &from, plane)?
                .into_iter()
                .map(|c| json!({"curve": c}))
                .collect())
        }
        Some("silhouette") => {
            let body = require_body(bodies, src.get("body"))?;
            let curves = silhouette(&body.shape, plane)?;
            if curves.is_empty() {
                return Err(Fail::msg("the body has no visible silhouette on this plane"));
            }
            Ok(curves.into_iter().map(|c| json!({"curve": c})).collect())
        }
        _ => Err(Fail::msg(format!(
            "unknown projection source kind: {}",
            py_str(src.get("kind"))
        ))),
    }
}

/// The `projectGeometry` op, builder.py `project_geometry`.
pub fn project_geometry_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let (Some(document), Some(plane_spec)) = (req.get("document"), req.get("plane")) else {
        return error_result(if req.contains_key("document") { "'plane'" } else { "'document'" });
    };
    let typed: CadDocument = match serde_json::from_value(document.clone()) {
        Ok(d) => d,
        Err(e) => return error_result(&format!("the document does not parse: {e}")),
    };
    let Ok(r) = builder::rebuild(&typed, document, watch) else {
        return error_result("cancelled");
    };
    let plane = match serde_json::from_value::<PlaneSpec>(plane_spec.clone()) {
        Ok(spec) => match plane_of(PlaneRef::from(&spec), &r.datum_planes) {
            Ok(p) => p,
            Err(f) => return error_result(&fail_text(&f)),
        },
        Err(_) => return error_result(&format!("unknown plane reference: {plane_spec}")),
    };
    let ctx = Ctx::with_params(&typed);
    let sources = req.get("sources").and_then(Value::as_array).cloned().unwrap_or_default();
    let results: Vec<Value> = sources
        .iter()
        .enumerate()
        .map(|(i, src)| match project_source(&ctx, src, &plane, document, &r.bodies, &r.datum_planes) {
            Ok(curves) => json!({"source_index": i, "ok": true, "curves": curves}),
            Err(f) => json!({"source_index": i, "ok": false, "curves": [], "error": fail_text(&f)}),
        })
        .collect();
    let mut m = Map::new();
    m.insert("results".into(), Value::Array(results));
    JobResult::Json(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_close_is_structural_and_reversal_aware() {
        let a = json!({"kind": "line", "x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 0.0});
        let b = json!({"kind": "line", "x1": 1.0, "y1": 0.0, "x2": 0.0, "y2": 0.00005});
        assert!(!curve_close(&a, &b, 1e-4));
        assert!(curve_close_either(&a, &b));
        assert!(!curve_close(&a, &json!({"kind": "poly", "pts": []}), 1e-4));
        assert_eq!(curve_oriented(&b, &a), curve_reversed(&b));
    }

    #[test]
    fn silhouette_assignment_consumes_nearest_pairs_first() {
        let line = |y: f64| json!({"kind": "line", "x1": -1.0, "y1": y, "x2": 1.0, "y2": y});
        let e1 = json!({"id": "a", "curve": line(0.0)});
        let e2 = json!({"id": "bb", "curve": line(5.0)});
        let fresh = vec![line(5.5), line(0.5), line(9.0)];
        let got: HashMap<String, Option<Value>> = assign_silhouette(&[&e1, &e2], Some(&fresh)).into_iter().collect();
        assert_eq!(got["a"], Some(line(0.5)));
        assert_eq!(got["bb"], Some(line(5.5)));
        let stale: HashMap<_, _> = assign_silhouette(&[&e1], None).into_iter().collect();
        assert_eq!(stale["a"], None);
    }
}
