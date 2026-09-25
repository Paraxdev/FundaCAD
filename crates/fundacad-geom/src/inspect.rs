//! Exact B-rep measurements and clash checks of the live bodies: the `inspect`
//! op (the Python engine's `inspect_model.py`, server.py `_inspect_job`) and the
//! `interference` op (server.py `_interference_job`, `_min_distance`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

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
    // Through the rebuild's own cache: an inspect right after a build of the
    // same document replays nothing, where a cold rebuild of an import is
    // most of a minute.
    let mut cache = crate::cache::global().lock().unwrap_or_else(|p| p.into_inner());
    let r = cache.rebuild(&typed, doc, watch).map_err(|_| error_result("cancelled"))?;
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

/// How much `inspect_bodies` reports per body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Sizes, mass properties and counts.
    Plain,
    /// Plain, and the surface census and the seam, wrapping and open lists a
    /// one line summary reads, without measuring any face or edge.
    Summary,
    /// Plain, and every face and edge with its selector.
    Detail,
}

/// What inspect reports of a shape that its placement does not change.
struct Local {
    volume: Option<(f64, [f64; 3])>,
    area: Option<(f64, [f64; 3])>,
    bbox: Option<[f64; 6]>,
    faces: usize,
    edges: usize,
    solids: usize,
    surfaces: Vec<(&'static str, usize)>,
    wraps: Vec<usize>,
    seams: Vec<usize>,
    open: Vec<usize>,
}

fn union(boxes: impl IntoIterator<Item = Option<[f64; 6]>>) -> Option<[f64; 6]> {
    boxes.into_iter().flatten().reduce(|a, b| {
        [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2]), a[3].max(b[3]), a[4].max(b[4]), a[5].max(b[5])]
    })
}

fn face_box(face: &Shape) -> Option<[f64; 6]> {
    let mut o = [0.0; 6];
    matches!(fq::FQ_face_bbox(face.raw(), &mut o), Ok(true)).then_some(o)
}

/// `bbox` face by face on the engine's threads. AddOptimal is the union of the
/// same per face boxes, so the result is the same to the bit.
fn optimal_bbox(shape: &Shape, faces: &[Shape]) -> Option<[f64; 6]> {
    if faces.len() < 2 || fq::FQ_free_parts(shape.raw()) {
        let mut o = [0.0; 6];
        return matches!(fq::FQ_bbox(shape.raw(), true, &mut o), Ok(true)).then_some(o);
    }
    let work = crate::par::Shared(faces);
    union(crate::par::map_indexed(faces.len(), move |k| face_box(&work.get()[k])))
}

fn measure(shape: &Shape) -> Local {
    let faces = sa::items(shape, ItemKind::Face);
    let edges = sa::items(shape, ItemKind::Edge);
    let mut surfaces: Vec<(&'static str, usize)> = Vec::new();
    let mut wraps = Vec::new();
    for (k, f) in faces.iter().enumerate() {
        let name = sa::surface_type(f).name();
        match surfaces.iter_mut().find(|(n, _)| *n == name) {
            Some((_, c)) => *c += 1,
            None => surfaces.push((name, 1)),
        }
        if face_wraps(f) {
            wraps.push(k);
        }
    }
    surfaces.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let adj = FaceAdjacency::new(shape);
    let (mut seams, mut open) = (Vec::new(), Vec::new());
    for (k, e) in edges.iter().enumerate() {
        let on = adj.faces_of_edge(e);
        if on.len() == 2 && on[0] == on[1] {
            seams.push(k);
        } else if on.len() < 2 {
            open.push(k);
        }
    }
    Local {
        volume: mass(shape, 3),
        area: mass(shape, 2),
        bbox: optimal_bbox(shape, &faces),
        faces: faces.len(),
        edges: edges.len(),
        solids: shape.shape_map(ShapeType::Solid).len(),
        surfaces,
        wraps,
        seams,
        open,
    }
}

type LocalKey = (u64, i32);

struct Cached {
    // Holds the TShape, so its address cannot be reused while it is a key.
    _keep: Shape,
    local: Arc<Local>,
    /// Boxes under placements no axis swap reaches, by the matrix's bits.
    placed: HashMap<[u64; 12], Option<[f64; 6]>>,
    used: u64,
}

#[derive(Default)]
struct LocalCache {
    calls: u64,
    entries: HashMap<LocalKey, Cached>,
}

/// Calls an entry survives unused, so a few one body inspects between two
/// whole document ones do not throw the document's measurements away.
const KEEP_FOR: u64 = 16;

fn local_cache() -> &'static Mutex<LocalCache> {
    static CACHE: OnceLock<Mutex<LocalCache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

fn local_key(shape: &Shape) -> LocalKey {
    (fq::FQ_tshape(shape.raw()), fq::FQ_orientation(shape.raw()))
}

/// Each shape's [`Local`], measured once per TShape: an assembly places one
/// screw many times, and a measurement outlives the call for the next one.
fn locals_of(shapes: &[Option<&Shape>]) -> Vec<Option<Arc<Local>>> {
    let keys: Vec<Option<LocalKey>> = shapes.iter().map(|s| s.map(local_key)).collect();
    let mut missing: Vec<(LocalKey, Shape)> = Vec::new();
    {
        let cache = local_cache().lock().unwrap_or_else(|p| p.into_inner());
        let mut queued = HashSet::new();
        for (k, s) in keys.iter().zip(shapes) {
            if let (Some(k), Some(s)) = (k, s) {
                if !cache.entries.contains_key(k) && queued.insert(*k) {
                    missing.push((*k, sa::unlocated(s)));
                }
            }
        }
    }
    let reps: Vec<&Shape> = missing.iter().map(|(_, s)| s).collect();
    let groups = crate::par::share_groups(&reps);
    let work = crate::par::Shared((&reps, crate::heartbeat::current()));
    let measured = crate::par::map_grouped(&groups, move |i| {
        let (reps, beat) = work.get();
        if let Some(b) = beat {
            b();
        }
        measure(reps[i])
    });
    let mut cache = local_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.calls += 1;
    let now = cache.calls;
    for ((k, s), (_, local)) in missing.into_iter().zip(measured) {
        cache.entries.insert(k, Cached { _keep: s, local: Arc::new(local), placed: HashMap::new(), used: now });
    }
    let out = keys
        .iter()
        .map(|k| {
            let e = cache.entries.get_mut(k.as_ref()?)?;
            e.used = now;
            Some(e.local.clone())
        })
        .collect();
    cache.entries.retain(|_, e| e.used + KEEP_FOR > now);
    out
}

/// `b` placed by `m` when `m` only swaps and flips axes and translates, which
/// carries an axis aligned box onto the placed shape's own.
fn permuted_box(m: &[f64; 12], b: &[f64; 6]) -> Option<[f64; 6]> {
    let mut out = [0.0; 6];
    let mut taken = [false; 3];
    for r in 0..3 {
        let row = &m[r * 4..r * 4 + 3];
        let j = (0..3).find(|&j| (row[j].abs() - 1.0).abs() <= 1e-12)?;
        if taken[j] || (0..3).any(|k| k != j && row[k].abs() > 1e-12) {
            return None;
        }
        taken[j] = true;
        let t = m[r * 4 + 3];
        (out[r], out[r + 3]) = if row[j] > 0.0 { (t + b[j], t + b[j + 3]) } else { (t - b[j + 3], t - b[j]) };
    }
    Some(out)
}

fn place_point(m: &Option<[f64; 12]>, p: [f64; 3]) -> [f64; 3] {
    match m {
        None => p,
        Some(m) => std::array::from_fn(|r| m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]),
    }
}

/// Each placed shape's box: its TShape's own box carried over where the
/// placement allows it exactly, measured again where it does not.
fn placed_boxes(
    shapes: &[Option<&Shape>],
    locals: &[Option<Arc<Local>>],
    placements: &[Option<[f64; 12]>],
) -> Vec<Option<[f64; 6]>> {
    let bits = |m: &[f64; 12]| m.map(f64::to_bits);
    let mut out: Vec<Option<[f64; 6]>> = Vec::with_capacity(shapes.len());
    let mut again: Vec<usize> = Vec::new();
    {
        let cache = local_cache().lock().unwrap_or_else(|p| p.into_inner());
        for (i, (l, m)) in locals.iter().zip(placements).enumerate() {
            let bb = l.as_ref().and_then(|l| l.bbox);
            out.push(match (m, bb) {
                (_, None) => None,
                (None, b) => b,
                (Some(m), Some(b)) => permuted_box(m, &b).or_else(|| {
                    let known = shapes[i]
                        .and_then(|s| cache.entries.get(&local_key(s)))
                        .and_then(|e| e.placed.get(&bits(m)));
                    if known.is_none() {
                        again.push(i);
                    }
                    known.copied().flatten()
                }),
            });
        }
    }
    let shapes_again: Vec<&Shape> = again.iter().filter_map(|&i| shapes[i]).collect();
    let groups = crate::par::share_groups(&shapes_again);
    let work = crate::par::Shared(&shapes_again);
    let measured = crate::par::map_grouped(&groups, move |k| {
        let s = work.get()[k];
        optimal_bbox(s, &sa::items(s, ItemKind::Face))
    });
    let mut cache = local_cache().lock().unwrap_or_else(|p| p.into_inner());
    for (k, b) in measured {
        let i = again[k];
        out[i] = b;
        if let (Some(s), Some(m)) = (shapes[i], &placements[i]) {
            if let Some(e) = cache.entries.get_mut(&local_key(s)) {
                e.placed.insert(bits(m), b);
            }
        }
    }
    out
}

type Lists = (Vec<Value>, Vec<Value>);

fn detail_lists(comp: &Shape, body_id: &Value, max_faces: usize, max_edges: usize) -> builder::FResult<Lists> {
    let faces = sa::items(comp, ItemKind::Face);
    let edges = sa::items(comp, ItemKind::Edge);
    let adj = FaceAdjacency::new(comp);
    let mut renum_map = HashMap::new();
    for (k, f) in faces.iter().enumerate() {
        renum_map.insert(adj.index_of(f), k);
    }
    let renum = |j: usize| renum_map.get(&j).copied();
    let fs = &faces[..faces.len().min(max_faces)];
    let es = &edges[..edges.len().min(max_edges)];
    let face_list = fs
        .iter()
        .enumerate()
        .map(|(k, f)| face_entry(k, f, &adj, &renum, body_id))
        .collect::<Result<Vec<_>, _>>()?;
    let fps = edge_fingerprints(es, comp)?;
    let edge_list = es
        .iter()
        .zip(fps)
        .enumerate()
        .map(|(k, (e, fp))| edge_entry(k, e, fp, &adj, &renum, body_id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((face_list, edge_list))
}

/// `inspect_bodies`.
pub fn inspect_bodies(
    bodies: &[InspectBody<'_>],
    detail: bool,
    max_faces: usize,
    max_edges: usize,
) -> builder::FResult<Vec<Value>> {
    inspect_bodies_at(bodies, if detail { Level::Detail } else { Level::Plain }, max_faces, max_edges)
}

pub fn inspect_bodies_at(
    bodies: &[InspectBody<'_>],
    level: Level,
    max_faces: usize,
    max_edges: usize,
) -> builder::FResult<Vec<Value>> {
    let shapes: Vec<Option<&Shape>> = bodies.iter().map(|b| b.shape).collect();
    let locals = crate::bench::phase("inspect_locals", || locals_of(&shapes));
    let placements: Vec<Option<[f64; 12]>> = shapes.iter().map(|s| s.and_then(sa::placement)).collect();
    let boxes = crate::bench::phase("inspect_boxes", || placed_boxes(&shapes, &locals, &placements));
    let mut lists: Vec<Option<builder::FResult<Lists>>> = (0..bodies.len()).map(|_| None).collect();
    if level == Level::Detail {
        let live: Vec<usize> = (0..bodies.len()).filter(|&i| shapes[i].is_some()).collect();
        let live_shapes: Vec<&Shape> = live.iter().filter_map(|&i| shapes[i]).collect();
        let groups = crate::par::share_groups(&live_shapes);
        let work = crate::par::Shared((bodies, &live, crate::heartbeat::current()));
        let found = crate::bench::phase("inspect_detail", || {
            crate::par::map_grouped(&groups, move |k| {
                let (bodies, live, beat) = work.get();
                if let Some(b) = beat {
                    b();
                }
                let b = &bodies[live[k]];
                b.shape.map(|s| detail_lists(s, &b.id, max_faces, max_edges))
            })
        });
        for (k, l) in found {
            lists[live[k]] = l;
        }
    }
    let mut out = Vec::with_capacity(bodies.len());
    for (i, b) in bodies.iter().enumerate() {
        let Some(local) = &locals[i] else {
            out.push(json!({"id": b.id, "name": b.name, "empty": true}));
            continue;
        };
        let m = &placements[i];
        let (mut vol, mut area, mut com) = (Value::Null, Value::Null, Value::Null);
        if let Some((v, c)) = local.volume {
            if v.abs() > 1e-12 {
                vol = r6(v.abs());
                com = r3(place_point(m, c));
            }
        }
        if let Some((a, c)) = local.area {
            area = r6(a);
            if com.is_null() {
                com = r3(place_point(m, c));
            }
        }
        let bb = boxes[i].unwrap_or([0.0; 6]);
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
        entry.insert("faceCount".into(), json!(local.faces));
        entry.insert("edgeCount".into(), json!(local.edges));
        entry.insert("solidCount".into(), json!(local.solids));
        match level {
            Level::Plain => {}
            Level::Summary => {
                let census: Vec<Value> = local.surfaces.iter().map(|(n, c)| json!([n, c])).collect();
                entry.insert("surfaces".into(), Value::Array(census));
                entry.insert("wraps".into(), json!(local.wraps));
                entry.insert("seams".into(), json!(local.seams));
                entry.insert("openEdges".into(), json!(local.open));
            }
            Level::Detail => {
                if let Some(l) = lists[i].take() {
                    let (face_list, edge_list) = l?;
                    let (nf, ne) = (face_list.len(), edge_list.len());
                    entry.insert("faces".into(), Value::Array(face_list));
                    entry.insert("edges".into(), Value::Array(edge_list));
                    if local.faces > nf || local.edges > ne {
                        entry.insert(
                            "truncated".into(),
                            json!({"faces": local.faces - nf, "edges": local.edges - ne}),
                        );
                    }
                }
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
    let _beat = crate::heartbeat::install(watch.heartbeat());
    let (_, r) = match rebuild_request(req, watch) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let detail = req.get("detail").map_or(true, |v| fundacad_protocol::pyjson::truthy(Some(v)));
    let level = if detail {
        Level::Detail
    } else if fundacad_protocol::pyjson::truthy(req.get("summary")) {
        Level::Summary
    } else {
        Level::Plain
    };
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
    let bodies = match inspect_bodies_at(
        &live,
        level,
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

/// What one candidate pair of the sweep found.
enum Clash {
    Overlap(Value),
    Near(Value),
    Clear,
}

/// One pair of the sweep. Common runs on copies: BOPAlgo may raise the
/// tolerances of its arguments in place and meshing the result writes into
/// faces it kept from them, so two pairs sharing a body cannot run at once on
/// the originals, and the live bodies stay untouched.
fn clash(a: &BuiltBody, b: &BuiltBody, threshold: Option<f64>) -> Clash {
    let common = kernel::copy(&a.shape)
        .and_then(|ca| kernel::copy(&b.shape).and_then(|cb| kernel::boolean_op(&ca, &[&cb], BoolKind::Common)))
        .ok();
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
            Clash::Overlap(entry)
        }
        _ => match threshold.and_then(|t| min_distance(&a.shape, &b.shape).filter(|(d, _, _)| *d <= t)) {
            Some((d, pa, pb)) => Clash::Near(json!({
                "a": a.id, "b": b.id, "aName": a.name, "bName": b.name,
                "distance": d, "pointA": pa, "pointB": pb,
            })),
            None => Clash::Clear,
        },
    }
}

/// The pairwise sweep of `_interference_job`, `max_ops` candidate pairs at most,
/// the pairs checked on the engine's threads and reported in row order.
pub fn interference(bodies: &[BuiltBody], clearance: Option<f64>, max_ops: usize, watch: &dyn Watch) -> Map<String, Value> {
    let boxes: Vec<[f64; 6]> = bodies.iter().map(|b| bbox(&b.shape)).collect();
    let threshold = clearance.filter(|t| *t > 0.0);
    let reject = threshold.unwrap_or(1e-6);
    let mut candidates = Vec::new();
    let mut truncated = false;
    'rows: for i in 0..bodies.len() {
        for j in i + 1..bodies.len() {
            if !overlap(&boxes[i], &boxes[j], reject) {
                continue;
            }
            if candidates.len() >= max_ops {
                truncated = true;
                break 'rows;
            }
            candidates.push((i, j));
        }
    }
    let cancel = watch.cancel_token();
    let work = crate::par::Shared((bodies, &candidates));
    let found = crate::par::map_indexed(candidates.len(), move |k| {
        if cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
            return Clash::Clear;
        }
        let (bodies, candidates) = *work.get();
        let (i, j) = candidates[k];
        clash(&bodies[i], &bodies[j], threshold)
    });
    let (mut pairs, mut clearances) = (Vec::new(), Vec::new());
    for c in found {
        match c {
            Clash::Overlap(v) => pairs.push(v),
            Clash::Near(v) => clearances.push(v),
            Clash::Clear => {}
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
