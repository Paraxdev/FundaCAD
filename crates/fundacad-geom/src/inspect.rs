//! Exact B-rep measurements and clash checks of the live bodies: the `inspect`
//! op (the Python engine's `inspect_model.py`, server.py `_inspect_job`) and the
//! `interference` op (server.py `_interference_job`, `_min_distance`).

use std::collections::HashSet;

use fundacad_core::CadDocument;
use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::{Shape, ShapeType};
use opencascade::select_access::{self as sa, ItemKind};
use opencascade_sys::face_query as fq;
use serde_json::{json, Map, Value};

use crate::builder::{self, BuiltBody, FeatureError, Rebuild, Watch};
use crate::kernel::{self, BoolKind};
use crate::mesh::{tessellate, MeshParams};
use crate::select::entity::py_round;
use crate::select::{edge_fingerprints, face_fingerprint};
use crate::topo::{face_wraps, FaceAdjacency};

pub const MAX_FACES: usize = 400;
pub const MAX_EDGES: usize = 800;
pub const MAX_INTERFERENCE_OPS: usize = 400;

/// The document of a request, rebuilt; the error reply when it cannot be.
pub fn rebuild_request(req: &Map<String, Value>, watch: &dyn Watch) -> Result<(Value, Rebuild), JobResult> {
    let Some(doc) = req.get("document") else {
        return Err(error_result("'document'"));
    };
    let typed: CadDocument = serde_json::from_value(doc.clone())
        .map_err(|e| error_result(&format!("the document does not parse: {e}")))?;
    let r = builder::rebuild(&typed, doc, watch).map_err(|_| error_result("cancelled"))?;
    Ok((doc.clone(), r))
}

fn r6(x: f64) -> Value {
    json!(py_round(x, 6))
}

fn r3(v: [f64; 3]) -> Value {
    json!(v.map(|x| py_round(x, 6)))
}

fn vec3(v: &Value) -> [f64; 3] {
    std::array::from_fn(|k| v[k].as_f64().unwrap_or(0.0))
}

/// build123d `bounding_box()`: zeros when the box is void.
fn bbox(shape: &Shape) -> [f64; 6] {
    let mut o = [0.0; 6];
    match fq::FQ_bbox(shape.raw(), true, &mut o) {
        Ok(true) => o,
        _ => [0.0; 6],
    }
}

fn mass(shape: &Shape, kind: i32) -> Option<(f64, [f64; 3])> {
    let mut o = [0.0; 4];
    fq::FQ_mass(shape.raw(), kind, &mut o).ok()?;
    Some((o[0], [o[1], o[2], o[3]]))
}

/// `_mass_props`: volume, area and centre of mass, each independently absent.
fn mass_props(shape: &Shape) -> (Value, Value, Value) {
    let (mut vol, mut area, mut com) = (Value::Null, Value::Null, Value::Null);
    if let Some((v, c)) = mass(shape, 3) {
        if v.abs() > 1e-12 {
            vol = r6(v.abs());
            com = r3(c);
        }
    }
    if let Some((a, c)) = mass(shape, 2) {
        area = r6(a);
        if com.is_null() {
            com = r3(c);
        }
    }
    (vol, area, com)
}

/// `_axis_of`: the axis of a cylinder, cone, torus or surface of revolution.
fn axis_of(face: &Shape) -> Option<[f64; 3]> {
    let mut o = [0.0; 13];
    let kind = fq::FQ_surface(face.raw(), &mut o).ok()?;
    matches!(kind, 1 | 2 | 4 | 5).then(|| [o[1], o[2], o[3]])
}

fn face_entry(
    i: usize,
    face: &Shape,
    adj: &FaceAdjacency,
    renum: &dyn Fn(usize) -> Option<usize>,
    body_id: &Value,
) -> builder::FResult<Value> {
    let fp = face_fingerprint(face)?;
    let mut neighbors: Vec<usize> = adj
        .neighbors(adj.index_of(face))
        .into_iter()
        .filter_map(renum)
        .collect();
    neighbors.sort_unstable();
    let mut e = Map::new();
    e.insert("i".into(), json!(i));
    e.insert("surface".into(), fp["surface"].clone());
    e.insert("area".into(), r6(fp["area"].as_f64().unwrap_or(0.0)));
    e.insert("centroid".into(), r3(vec3(&fp["centroid"])));
    e.insert("normal".into(), r3(vec3(&fp["normal"])));
    e.insert("wraps".into(), json!(face_wraps(face)));
    e.insert("neighbors".into(), json!(neighbors));
    let point = sa::distance_to_point(face, vec3(&fp["centroid"])).map(|(_, p)| p);
    let radius = fp.get("radius").and_then(Value::as_f64);
    e.insert(
        "selector".into(),
        json!({"kind": "face", "by": "match", "fp": fp, "body": body_id}),
    );
    if let Some(p) = point {
        e.insert("point".into(), r3(p));
    }
    if let Some(r) = radius {
        e.insert("radius".into(), r6(r));
    }
    if let Some(ax) = axis_of(face) {
        e.insert("axis".into(), r3(ax));
    }
    Ok(Value::Object(e))
}

fn edge_entry(
    i: usize,
    edge: &Shape,
    fp: Value,
    adj: &FaceAdjacency,
    renum: &dyn Fn(usize) -> Option<usize>,
    body_id: &Value,
) -> builder::FResult<Value> {
    let faces: Vec<usize> = adj.faces_of_edge(edge).into_iter().filter_map(renum).collect();
    let mut e = Map::new();
    e.insert("i".into(), json!(i));
    e.insert("curve".into(), fp["curve"].clone());
    e.insert("length".into(), r6(fp["length"].as_f64().unwrap_or(0.0)));
    e.insert("mid".into(), r3(vec3(&fp["mid"])));
    e.insert("dir".into(), r3(vec3(&fp["dir"])));
    e.insert("faces".into(), json!(faces));
    let radius = fp.get("radius").and_then(Value::as_f64);
    let center = fp.get("center").map(vec3);
    e.insert(
        "selector".into(),
        json!({"kind": "edge", "by": "match", "fp": fp, "body": body_id}),
    );
    if faces.len() == 2 && faces[0] == faces[1] {
        e.insert("seam".into(), json!(true));
    } else if faces.len() < 2 {
        e.insert("openBoundary".into(), json!(true));
    }
    if let Some(r) = radius {
        e.insert("radius".into(), r6(r));
    }
    if let Some(c) = center {
        e.insert("center".into(), r3(c));
    }
    Ok(Value::Object(e))
}

/// A body as `inspect_bodies` takes it.
pub struct InspectBody<'a> {
    pub id: Value,
    pub name: Value,
    pub shape: Option<&'a Shape>,
}

/// `inspect_bodies`.
pub fn inspect_bodies(
    bodies: &[InspectBody<'_>],
    detail: bool,
    max_faces: usize,
    max_edges: usize,
) -> builder::FResult<Vec<Value>> {
    let mut out = Vec::new();
    for b in bodies {
        let Some(comp) = b.shape else {
            out.push(json!({"id": b.id, "name": b.name, "empty": true}));
            continue;
        };
        let (vol, area, com) = mass_props(comp);
        let bb = bbox(comp);
        let mut entry = Map::new();
        entry.insert("id".into(), b.id.clone());
        entry.insert("name".into(), b.name.clone());
        entry.insert(
            "bbox".into(),
            json!({
                "min": r3([bb[0], bb[1], bb[2]]),
                "max": r3([bb[3], bb[4], bb[5]]),
                "size": r3([bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]]),
            }),
        );
        entry.insert("volume".into(), vol);
        entry.insert("area".into(), area);
        entry.insert("centerOfMass".into(), com);
        let faces = sa::items(comp, ItemKind::Face);
        let edges = sa::items(comp, ItemKind::Edge);
        entry.insert("faceCount".into(), json!(faces.len()));
        entry.insert("edgeCount".into(), json!(edges.len()));
        entry.insert("solidCount".into(), json!(comp.shape_map(ShapeType::Solid).len()));
        if detail {
            let adj = FaceAdjacency::new(comp);
            let mut renum_map = std::collections::HashMap::new();
            for (k, f) in faces.iter().enumerate() {
                renum_map.insert(adj.index_of(f), k);
            }
            let renum = |j: usize| renum_map.get(&j).copied();
            let fs = &faces[..faces.len().min(max_faces)];
            let es = &edges[..edges.len().min(max_edges)];
            let face_list = fs
                .iter()
                .enumerate()
                .map(|(k, f)| face_entry(k, f, &adj, &renum, &b.id))
                .collect::<Result<Vec<_>, _>>()?;
            let fps = edge_fingerprints(es, comp)?;
            let edge_list = es
                .iter()
                .zip(fps)
                .enumerate()
                .map(|(k, (e, fp))| edge_entry(k, e, fp, &adj, &renum, &b.id))
                .collect::<Result<Vec<_>, _>>()?;
            entry.insert("faces".into(), Value::Array(face_list));
            entry.insert("edges".into(), Value::Array(edge_list));
            if faces.len() > fs.len() || edges.len() > es.len() {
                entry.insert(
                    "truncated".into(),
                    json!({"faces": faces.len() - fs.len(), "edges": edges.len() - es.len()}),
                );
            }
        }
        out.push(Value::Object(entry));
    }
    Ok(out)
}

fn cap(req: &Map<String, Value>, key: &str, default: usize) -> usize {
    match req.get(key) {
        None | Some(Value::Null) => default,
        Some(v) => v
            .as_f64()
            .map_or(default, |x| if x < 0.0 { 0 } else { x.trunc() as usize }),
    }
}

/// The `inspect` op.
pub fn inspect_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let (_, r) = match rebuild_request(req, watch) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let detail = req.get("detail").map_or(true, |v| fundacad_protocol::pyjson::truthy(Some(v)));
    let want: Option<HashSet<String>> = req
        .get("bodies")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect());
    let live: Vec<InspectBody<'_>> = r
        .bodies
        .iter()
        .filter(|b| want.as_ref().map_or(true, |w| w.contains(&b.id) || w.contains(&b.name)))
        .map(|b| InspectBody { id: json!(b.id), name: json!(b.name), shape: Some(&b.shape) })
        .collect();
    let bodies = match inspect_bodies(
        &live,
        detail,
        cap(req, "maxFaces", MAX_FACES),
        cap(req, "maxEdges", MAX_EDGES),
    ) {
        Ok(b) => b,
        Err(e) => return error_result(&fail_text(&e)),
    };
    let mut m = Map::new();
    m.insert("bodies".into(), Value::Array(bodies));
    m.insert("errors".into(), Value::Array(r.errors.iter().map(FeatureError::wire).collect()));
    JobResult::Json(m)
}

fn fail_text(f: &builder::Fail) -> String {
    match f {
        builder::Fail::Value { message, .. } => message.clone(),
        builder::Fail::Missing(k) => format!("'{k}'"),
        builder::Fail::Internal(n) => n.clone(),
    }
}

fn overlap(a: &[f64; 6], b: &[f64; 6], tol: f64) -> bool {
    a[0] <= b[3] + tol
        && a[3] >= b[0] - tol
        && a[1] <= b[4] + tol
        && a[4] >= b[1] - tol
        && a[2] <= b[5] + tol
        && a[5] >= b[2] - tol
}

/// `_min_distance`: the distance and a nearest point on each shape.
pub fn min_distance(a: &Shape, b: &Shape) -> Option<(f64, [f64; 3], [f64; 3])> {
    let d = a.distance(b, 0.0).ok()?;
    let s = d.solutions.first()?;
    Some((d.value, s.on_first.point.to_array(), s.on_second.point.to_array()))
}

/// The pairwise sweep of `_interference_job`, `max_ops` candidate pairs at most.
pub fn interference(bodies: &[BuiltBody], clearance: Option<f64>, max_ops: usize, watch: &dyn Watch) -> Map<String, Value> {
    let boxes: Vec<[f64; 6]> = bodies.iter().map(|b| bbox(&b.shape)).collect();
    let threshold = clearance.filter(|t| *t > 0.0);
    let reject = threshold.unwrap_or(1e-6);
    let (mut pairs, mut clearances) = (Vec::new(), Vec::new());
    let (mut ops, mut truncated) = (0usize, false);
    'rows: for i in 0..bodies.len() {
        if watch.cancelled() {
            break;
        }
        for j in i + 1..bodies.len() {
            let (a, b) = (&bodies[i], &bodies[j]);
            if !overlap(&boxes[i], &boxes[j], reject) {
                continue;
            }
            if ops >= max_ops {
                truncated = true;
                break 'rows;
            }
            ops += 1;
            let common = kernel::boolean_op(&a.shape, &[&b.shape], BoolKind::Common).ok();
            let vol = common.as_ref().map_or(0.0, |c| kernel::volume(c).abs());
            match common {
                Some(c) if vol > 1e-6 => {
                    let bb = bbox(&c);
                    let mut entry = json!({
                        "a": a.id, "b": b.id, "aName": a.name, "bName": b.name,
                        "volume": vol,
                        "bbox": {"min": [bb[0], bb[1], bb[2]], "max": [bb[3], bb[4], bb[5]]},
                    });
                    let access = MeshAccess::new(&c);
                    let t = tessellate(
                        &c,
                        &access,
                        MeshParams { linear: 0.25, angular: 0.6, relative: false, display: false, force_remesh: false },
                    );
                    if let Value::Object(m) = &mut entry {
                        m.insert("positions".into(), json!(t.positions));
                        m.insert("indices".into(), json!(t.indices));
                    }
                    pairs.push(entry);
                }
                _ => {
                    if let Some(t) = threshold {
                        if let Some((d, pa, pb)) = min_distance(&a.shape, &b.shape) {
                            if d <= t {
                                clearances.push(json!({
                                    "a": a.id, "b": b.id, "aName": a.name, "bName": b.name,
                                    "distance": d, "pointA": pa, "pointB": pb,
                                }));
                            }
                        }
                    }
                }
            }
        }
    }
    let mut res = Map::new();
    res.insert("pairs".into(), Value::Array(pairs));
    if threshold.is_some() {
        res.insert("clearances".into(), Value::Array(clearances));
    }
    if truncated {
        res.insert("truncated".into(), json!(true));
        res.insert(
            "message".into(),
            json!(format!(
                "Stopped after checking {max_ops} candidate pairs; pick a smaller set of bodies for a full sweep."
            )),
        );
    }
    res
}

/// The `interference` op.
pub fn interference_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let (_, r) = match rebuild_request(req, watch) {
        Ok(x) => x,
        Err(e) => return e,
    };
    if r.bodies.is_empty() {
        if let Some(e) = r.errors.first() {
            let mut m = Map::new();
            m.insert("error".into(), e.wire());
            return JobResult::Json(m);
        }
    }
    let clearance = req.get("clearance").and_then(Value::as_f64);
    JobResult::Json(interference(&r.bodies, clearance, MAX_INTERFERENCE_OPS, watch))
}
