//! The `printability` op: the document rebuilt through the warm cache, the
//! bodies asked for meshed finely, on copies so the viewport's stored
//! triangulation is left alone, and checked. The reply has every finding with
//! its face, for the app to colour, and the text report the MCP tool prints.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use fundacad_engine::error_result;
use fundacad_protocol::pyjson::g_format;
use fundacad_protocol::{JobResult, WireBody};
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

use super::{dot, report, run, settings_of, unit, Body, Finding, Kind, Mesh, Settings, Topology};
use crate::builder::{BuiltBody, FeatureError, Watch};
use crate::inspect::{inspect_bodies_at, InspectBody, Level, MAX_EDGES, MAX_FACES};

/// The mesh tolerance `section` uses: what gets printed is triangles, and
/// these are close enough to the exact faces for a 0.2 mm gap.
const TOLERANCE: f64 = 0.01;

pub fn printability_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let _beat = crate::heartbeat::install(watch.heartbeat());
    let _cancel = crate::cancel::install(watch.cancel_token());
    let s = match settings_of(req) {
        Ok(s) => s,
        Err(e) => return error_result(&e),
    };
    let (_, r) = match crate::inspect::rebuild_request(req, watch) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let errors: Vec<Value> = r.errors.iter().map(FeatureError::wire).collect();
    match check(req, &s, &r.bodies, watch) {
        Ok(mut m) => {
            m.insert("errors".into(), Value::Array(errors));
            JobResult::Json(m)
        }
        Err(e) => error_result(&e),
    }
}

fn check(args: &Map<String, Value>, s: &Settings, built: &[BuiltBody], watch: &dyn Watch) -> Result<Map<String, Value>, String> {
    let wanted: Vec<String> = args
        .get("bodies")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let named = |b: &BuiltBody, w: &str| b.id == w || b.name == w;
    if built.is_empty() {
        // The feature failures say why; a body asked for by name is not the
        // thing to look at.
        return Ok(nothing(s));
    }
    let missing: Vec<&String> = wanted.iter().filter(|w| !built.iter().any(|b| named(b, w))).collect();
    if !missing.is_empty() {
        return Err(format!(
            "no body {} in this build. Check the ids or names against `build`.",
            missing.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(", ")
        ));
    }
    let chosen: Vec<&BuiltBody> =
        built.iter().filter(|b| wanted.is_empty() || wanted.iter().any(|w| named(b, w))).collect();
    if chosen.is_empty() {
        return Ok(nothing(s));
    }
    let stopped = || watch.cancelled() || crate::cancel::requested();

    // What the exact shapes know and the mesh cannot: open edges, separate
    // solids, an inside-out volume.
    let summary = inspect(&chosen, Level::Summary)?;
    let mut topo: HashMap<String, Topology> = HashMap::new();
    for b in &summary {
        let open_edges = b.get("openEdges").and_then(Value::as_array).map_or(0, Vec::len);
        // Signed, which inspect's is not: a closed shell wound inside out
        // encloses a negative volume. An open one encloses nothing to sign.
        let id = id_of(b);
        let volume = match chosen.iter().find(|c| c.id == id) {
            Some(c) if open_edges == 0 => crate::kernel::volume(&c.shape),
            _ => 1.0,
        };
        topo.insert(
            id,
            Topology { open_edges, solids: b.get("solidCount").and_then(Value::as_i64).unwrap_or(1), volume },
        );
    }
    if stopped() {
        return Err("cancelled".into());
    }

    let mut detail: Option<Vec<Value>> = None;
    let mut ups: HashMap<String, [f64; 3]> = HashMap::new();
    let mut beds: HashMap<String, i64> = HashMap::new();
    let header = match &s.lay_flat {
        Some(how) => {
            let asked = asked_faces(how, built)?;
            let faces = inspect(&chosen, Level::Detail)?;
            let mut on = Vec::new();
            for b in &chosen {
                let Some(body) = faces.iter().find(|f| id_of(f) == b.id) else { continue };
                let want = asked.iter().find(|(id, _)| *id == b.id).map(|(_, i)| *i);
                match pick_face(body, want)? {
                    Some((i, n)) => {
                        ups.insert(b.id.clone(), [-n[0], -n[1], -n[2]]);
                        beds.insert(b.id.clone(), i);
                        on.push(format!("{} on F{i}", b.id));
                    }
                    None => on.push(format!("{} as modelled, no flat face", b.id)),
                }
            }
            detail = Some(faces);
            if stopped() {
                return Err("cancelled".into());
            }
            format!("laid flat as export would ({}), each on its own bed; coordinates are the model's", on.join(", "))
        }
        None => String::new(),
    };

    let meshes = mesh_copies(&chosen, watch)?;
    if stopped() {
        return Err("cancelled".into());
    }
    let mut bodies: Vec<Body> = meshes
        .iter()
        .map(|m| {
            let mesh = Mesh {
                id: m.fields.get("id").and_then(Value::as_str).unwrap_or_default(),
                name: m.fields.get("name").and_then(Value::as_str).unwrap_or_default(),
                positions: &m.positions,
                indices: &m.indices,
                face_ids: &m.face_ids,
            };
            let up = ups.get(mesh.id).copied().unwrap_or(s.up.0);
            Body::new(&mesh, up)
        })
        .collect();
    let header = if s.lay_flat.is_some() {
        header
    } else {
        // One object on one bed: the lowest point of any of them.
        let bed = bodies.iter().map(|b| b.bed).fold(f64::INFINITY, f64::min);
        for b in &mut bodies {
            b.bed = bed;
        }
        let axis = s.up.1[1..].to_ascii_lowercase();
        let sign = if s.up.1.starts_with('-') { -1.0 } else { 1.0 };
        format!("{} up as modelled, bed at {axis} = {}", s.up.1, g_format(((bed * sign) * 1000.0).round() / 1000.0))
    };
    // The rays are one long call: it beats for the job, and stops early
    // between bodies once cancelled.
    let mut findings = crate::heartbeat::while_running(Duration::from_secs(300), || {
        run(&bodies, s, s.lay_flat.is_none(), &topo, &stopped)
    });
    if stopped() {
        return Err("cancelled".into());
    }

    // A sideways round hole is the overhang everyone prints: say what fixes it.
    let flagged: BTreeSet<&str> =
        findings.iter().filter(|f| f.kind == Kind::Overhang).map(|f| bodies[f.body].id.as_str()).collect();
    // Only a hint: faces it cannot measure leave the findings as they are.
    if !flagged.is_empty() {
        let faces = match detail {
            Some(d) => Some(d),
            None => {
                let some: Vec<&BuiltBody> = chosen.iter().copied().filter(|b| flagged.contains(b.id.as_str())).collect();
                inspect(&some, Level::Detail).ok()
            }
        };
        if let Some(faces) = faces {
            hint_holes(&mut findings, &bodies, &faces);
        }
    }

    let mut m = Map::new();
    m.insert("header".into(), json!(header));
    m.insert("report".into(), json!(report(&bodies, &findings, s, &header, &topo)));
    m.insert("settings".into(), settings_json(s));
    m.insert(
        "bodies".into(),
        Value::Array(
            bodies
                .iter()
                .map(|b| {
                    let t = topo.get(&b.id).cloned().unwrap_or_default();
                    json!({
                        "id": b.id,
                        "name": b.name,
                        "up": b.up,
                        "bed": b.bed,
                        "bedFace": beds.get(&b.id),
                        "openEdges": t.open_edges,
                        "solids": t.solids,
                        "insideOut": t.volume < 0.0,
                    })
                })
                .collect(),
        ),
    );
    m.insert("findings".into(), Value::Array(ordered(&findings).into_iter().map(|f| finding_json(f, &bodies)).collect()));
    Ok(m)
}

/// The reply when no body was built, or none of those asked for.
fn nothing(s: &Settings) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("header".into(), json!(""));
    m.insert("report".into(), json!("Nothing built to check."));
    m.insert("settings".into(), settings_json(s));
    m.insert("bodies".into(), json!([]));
    m.insert("findings".into(), json!([]));
    m
}

fn id_of(b: &Value) -> String {
    b.get("id").and_then(Value::as_str).unwrap_or_default().to_string()
}

fn inspect(bodies: &[&BuiltBody], level: Level) -> Result<Vec<Value>, String> {
    let live: Vec<InspectBody<'_>> =
        bodies.iter().map(|b| InspectBody { id: json!(b.id), name: json!(b.name), shape: Some(&b.shape) }).collect();
    inspect_bodies_at(&live, level, MAX_FACES, MAX_EDGES).map_err(|e| format!("Could not measure the bodies: {}", crate::inspect::fail_text(&e)))
}

/// Each body meshed on a copy of its shape. The live shape keeps the
/// triangulation the viewport has, which a fine mesh written into it would
/// replace for every later rebuild.
fn mesh_copies(chosen: &[&BuiltBody], watch: &dyn Watch) -> Result<Vec<fundacad_protocol::FullBody>, String> {
    let copies: Vec<Shape> = chosen
        .iter()
        .map(|b| crate::kernel::copy(&b.shape).map_err(|e| format!("{} could not be copied for meshing, {e}", b.id)))
        .collect::<Result<_, _>>()?;
    let meshed: Vec<crate::mesh::MeshBody<'_>> = chosen
        .iter()
        .zip(&copies)
        .map(|(b, c)| crate::mesh::MeshBody { shape: Some(c), owner_map: None, ..crate::reply::mesh_body(b) })
        .collect();
    let result = crate::mesh::mesh_result_watched(&meshed, TOLERANCE, &Map::new(), &mut |done, total| {
        watch.meshing(done, total)
    });
    Ok(result
        .bodies
        .into_iter()
        .filter_map(|b| match b {
            WireBody::Full(f) => Some(f),
            WireBody::Stub(_) => None,
        })
        .collect())
}

/// `layFlat`'s {body: face index}, by body id. Any built body may be named,
/// as `export {layFlat}` takes it.
fn asked_faces(how: &Value, built: &[BuiltBody]) -> Result<Vec<(String, i64)>, String> {
    let mut asked = Vec::new();
    if let Value::Object(map) = how {
        for (k, v) in map {
            let Some(b) = built.iter().find(|b| b.id == *k).or_else(|| built.iter().find(|b| b.name == *k)) else {
                return Err(no_such_body(k, built));
            };
            let Some(i) = v.as_i64() else {
                return Err(format!("layFlat's {k} is a face index from `inspect`, got {v}"));
            };
            asked.push((b.id.clone(), i));
        }
    }
    Ok(asked)
}

fn no_such_body(wanted: &str, built: &[BuiltBody]) -> String {
    let have: Vec<String> = built
        .iter()
        .map(|b| if b.name.is_empty() || b.name == b.id { b.id.clone() } else { format!("{} \"{}\"", b.id, b.name) })
        .collect();
    format!("no body '{wanted}' in this build, have {}", have.join(", "))
}

/// The face a body goes down on, as `export {layFlat}` picks it in the MCP
/// crate's layflat.rs: the one asked for, else its largest flat face. None
/// for a body with no flat face at all.
fn pick_face(body: &Value, asked: Option<i64>) -> Result<Option<(i64, [f64; 3])>, String> {
    let faces = body.get("faces").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let vec3 = |v: Option<&Value>| -> Option<[f64; 3]> {
        let a = v?.as_array()?;
        Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
    };
    let as_pick = |f: &Value| -> Option<(i64, [f64; 3], f64)> {
        Some((f.get("i")?.as_i64()?, vec3(f.get("normal"))?, f.get("area")?.as_f64()?))
    };
    let plane = |f: &Value| f.get("surface").and_then(Value::as_str) == Some("plane");
    if let Some(i) = asked {
        let Some(f) = faces.iter().find(|f| f.get("i").and_then(Value::as_i64) == Some(i)) else {
            return Err(format!("{} has no face {i}, `inspect` lists its faces", id_of(body)));
        };
        if !plane(f) {
            return Err(format!("face {i} of {} is not flat, a part can only sit on a flat face", id_of(body)));
        }
        return Ok(as_pick(f).map(|(i, n, _)| (i, n)));
    }
    Ok(faces.iter().filter(|f| plane(f)).filter_map(as_pick).max_by(|a, b| a.2.total_cmp(&b.2)).map(|(i, n, _)| (i, n)))
}

/// Notes "a sideways hole" on an overhang that is the top of a round hole
/// lying down, the overhang a teardrop or a flat roof prints without support.
fn hint_holes(findings: &mut [Finding], bodies: &[Body], detail: &[Value]) {
    for f in findings.iter_mut().filter(|f| f.kind == Kind::Overhang) {
        let b = &bodies[f.body];
        let Some(face) = detail
            .iter()
            .find(|d| d.get("id").and_then(Value::as_str) == Some(b.id.as_str()))
            .and_then(|d| d.get("faces"))
            .and_then(Value::as_array)
            .and_then(|fs| fs.iter().find(|x| x.get("i").and_then(Value::as_u64) == Some(f.face as u64)))
        else {
            continue;
        };
        let axis = face
            .get("axis")
            .and_then(Value::as_array)
            .and_then(|a| Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?]));
        // Round the air, lying down, and more of a turn than a fillet into a
        // corner makes.
        let sideways = face.get("surface").and_then(Value::as_str) == Some("cylinder")
            && b.hollow(f.face)
            && axis.is_some_and(|a| dot(unit(a), b.up).abs() < 0.2 && b.turns(f.face, a) > 120.0);
        if sideways {
            if !f.note.is_empty() {
                f.note.push_str(", ");
            }
            f.note.push_str("a sideways hole: teardropHole or roofBridge fixes it");
        }
    }
}

fn settings_json(s: &Settings) -> Value {
    json!({
        "nozzle": s.nozzle,
        "layer": s.layer,
        "overhang": s.overhang,
        "minGap": s.min_gap,
        "maxBridge": s.max_bridge,
        "up": if s.lay_flat.is_some() { Value::Null } else { json!(s.up.1) },
        "layFlat": s.lay_flat.is_some(),
    })
}

/// Every finding in the order the report lists them: by body, by kind, the
/// worst first, then the pairs between bodies.
fn ordered(findings: &[Finding]) -> Vec<&Finding> {
    let mut out: Vec<&Finding> = findings.iter().collect();
    let rank = |f: &Finding| match f.kind {
        Kind::Overhang => -f.area,
        Kind::Bridge => -f.value,
        _ => f.value,
    };
    out.sort_by(|a, b| match (a.kind == Kind::Fused, b.kind == Kind::Fused) {
        (false, false) => a.body.cmp(&b.body).then(a.kind.cmp(&b.kind)).then(rank(a).total_cmp(&rank(b))),
        (x, y) => x.cmp(&y).then(rank(a).total_cmp(&rank(b))),
    });
    out
}

fn finding_json(f: &Finding, bodies: &[Body]) -> Value {
    let kind = match f.kind {
        Kind::Overhang => "overhang",
        Kind::Bridge => "bridge",
        Kind::Wall => "wall",
        Kind::Floor => "floor",
        Kind::Gap => "gap",
        Kind::Fused => "fused",
        Kind::MeshHole => "meshHole",
    };
    json!({
        "kind": kind,
        "body": bodies[f.body].id,
        "face": f.face,
        "other": f.other.map(|(b, face)| json!({"body": bodies[b].id, "face": face})),
        "value": f.value,
        "limit": f.limit,
        "area": f.area,
        "low": f.low,
        "at": f.at,
        "extent": f.extent,
        "note": f.note,
    })
}
