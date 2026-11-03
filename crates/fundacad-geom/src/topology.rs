//! The `topology` op: one body's faces in plain numbers and which faces each wire edge joins, for a list that
//! describes them in words. `inspect` also has selectors, neighbours and whole body measures, and costs more.

use std::collections::HashSet;
use std::time::Duration;

use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use glam::DVec3;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::Shape;
use opencascade::select_access as sa;
use opencascade_sys::face_query as fq;
use serde_json::{json, Map, Value};

use crate::builder::{FeatureError, Watch};
use crate::features::resize::surface::{concave, surf, Surf};
use crate::inspect::{cap, rebuild_request};
use crate::kernel::{self, Kind};
use crate::mesh::{edge_walk, WalkedEdge};
use crate::select::entity::py_round;
use crate::topo::face_wraps;

/// At about 200 B a row this stays well under the 128 MiB frame cap.
pub const MAX_FACES: usize = 200_000;
const WALK_BEATS: Duration = Duration::from_secs(300);
/// An outline sampled at the wire's 0.01 mm reads a 9 mm disc as 8.98 by 8.98, this reads it as 8.9998.
const OUTLINE_DEFLECTION: f64 = 1e-4;

// Adding 0.0 turns -0.0 into 0.0, which a client would have to read as a sign.
fn num(x: f64) -> Value {
    json!(py_round(x, 6) + 0.0)
}

fn vector(v: impl Into<[f64; 3]>) -> Value {
    json!(v.into().map(|x| py_round(x, 6) + 0.0))
}

fn asked_faces(req: &Map<String, Value>) -> Result<Option<Vec<usize>>, JobResult> {
    let Some(v) = req.get("faces").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let list = v.as_array().and_then(|a| a.iter().map(|x| x.as_u64().map(|i| i as usize)).collect::<Option<Vec<_>>>());
    let Some(mut list) = list else {
        return Err(error_result(&format!("faces is a list of face numbers, got {v}")));
    };
    list.sort_unstable();
    list.dedup();
    Ok(Some(list))
}

pub fn topology_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let _beat = crate::heartbeat::install(watch.heartbeat());
    let _cancel = crate::cancel::install(watch.cancel_token());
    let Some(want) = req.get("body").and_then(Value::as_str) else {
        return error_result("give body, the id or name of the body to list");
    };
    let only = match asked_faces(req) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let (_, r) = match rebuild_request(req, watch) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let body = r.bodies.iter().find(|b| b.id == want).or_else(|| r.bodies.iter().find(|b| b.name == want));
    let Some(body) = body else {
        return error_result(&format!("the document has no body {want}"));
    };
    let Some(mut m) = lists(&body.shape, body.scan, only.as_deref(), cap(req, "maxFaces", MAX_FACES)) else {
        return error_result("cancelled");
    };
    m.insert("body".into(), json!(body.id));
    m.insert("errors".into(), Value::Array(r.errors.iter().map(FeatureError::wire).collect()));
    JobResult::Json(m)
}

/// None when cancelled. Every edge of a listed face counts toward its size, also one the outline leaves out:
/// a coplanar seam can be the far side of a flat face, and a seam can run to a cone's apex.
fn lists(shape: &Shape, scan: bool, only: Option<&[usize]>, max_faces: usize) -> Option<Map<String, Value>> {
    let faces = kernel::subshapes(shape, Kind::Face);
    let access = MeshAccess::new(shape);
    let every: Vec<usize>;
    let asked: &[usize] = match only {
        Some(list) => &list[..list.partition_point(|&i| i < faces.len())],
        None => {
            every = (0..faces.len()).collect();
            &every
        }
    };
    let shown = &asked[..asked.len().min(max_faces)];
    let mut wanted = vec![false; faces.len()];
    for &i in shown {
        wanted[i] = true;
    }
    let token = crate::cancel::token();
    let walked = crate::heartbeat::while_running(WALK_BEATS, || {
        edge_walk(&access, |of: &[usize]| {
            !token.as_ref().is_some_and(fundacad_protocol::CancelToken::is_cancelled)
                && (only.is_none() || of.iter().any(|&f| wanted.get(f) == Some(&true)))
        })
    });
    if crate::cancel::requested() {
        return None;
    }
    let mut around: Vec<Vec<usize>> = vec![Vec::new(); faces.len()];
    for (k, edge) in walked.iter().enumerate() {
        for &f in &edge.faces {
            if wanted.get(f) == Some(&true) && around[f].last() != Some(&k) {
                around[f].push(k);
            }
        }
    }
    let mut rows = Vec::with_capacity(shown.len());
    for &i in shown {
        if crate::cancel::requested() {
            return None;
        }
        crate::heartbeat::beat();
        let boundary: Vec<&WalkedEdge> = around[i].iter().map(|&k| &walked[k]).collect();
        rows.push(if scan { scan_row(i, &faces[i]) } else { face_row(i, &faces[i], &boundary, &access) });
    }
    let mut m = Map::new();
    m.insert("faceCount".into(), json!(faces.len()));
    m.insert("faces".into(), Value::Array(rows));
    if only.is_none() {
        m.insert("edgeFaces".into(), Value::Array(edge_faces(&walked)));
    }
    if shown.len() < asked.len() {
        m.insert("truncated".into(), json!({"faces": asked.len() - shown.len()}));
    }
    Some(m)
}

/// The faces each drawn edge joins, in wire order. An edge that runs through one face twice names it once.
pub fn edge_faces(walked: &[WalkedEdge]) -> Vec<Value> {
    walked
        .iter()
        .filter(|e| e.drawn)
        .map(|e| {
            let mut of = e.faces.clone();
            of.dedup();
            json!(of)
        })
        .collect()
}

// A scan's face has no surface, and measuring the missing surface segfaults on Linux.
fn scan_row(i: usize, face: &Shape) -> Value {
    let mut e = Map::new();
    e.insert("i".into(), json!(i));
    e.insert("surface".into(), json!(sa::SurfaceType::Other.name()));
    if let Some(area) = sa::face_probe(face).and_then(|p| p.area) {
        e.insert("area".into(), num(area));
    }
    Value::Object(e)
}

/// `center()` as selectors use it is a point on a curved face, this is the middle of the area, on the axis of a bore.
fn area_and_centre(face: &Shape) -> Option<(f64, [f64; 3])> {
    let mut o = [0.0; 4];
    fq::FQ_mass(face.raw(), 2, &mut o).ok()?;
    Some((o[0], [o[1], o[2], o[3]]))
}

/// A plane's own direction ignores the face's orientation.
fn outward(face: &Shape) -> Option<DVec3> {
    let f = face.as_face()?;
    let b = f.uv_bounds().ok()?;
    Some(f.point_and_normal(0.5 * (b.u_min + b.u_max), 0.5 * (b.v_min + b.v_max)).ok()?.1)
}

fn face_row(i: usize, face: &Shape, boundary: &[&WalkedEdge], access: &MeshAccess) -> Value {
    let mut e = Map::new();
    e.insert("i".into(), json!(i));
    e.insert("surface".into(), json!(sa::surface_type(face).name()));
    if let Some((area, centre)) = area_and_centre(face) {
        e.insert("area".into(), num(area));
        e.insert("centroid".into(), vector(centre));
    }
    let s = surf(face);
    let spread = |axis: DVec3| spread(boundary.iter().flat_map(|w| &w.points).map(|p| DVec3::from_array(*p)), axis);
    let round = |e: &mut Map<String, Value>, axis: DVec3| {
        e.insert("axis".into(), vector(axis));
        e.insert("wraps".into(), json!(face_wraps(face)));
    };
    match s {
        Surf::Plane { n, .. } => {
            if let Some(normal) = outward(face) {
                e.insert("normal".into(), vector(normal));
            }
            if let Some(size) = flat_size(boundary, n, access) {
                e.insert("size".into(), json!(size.map(|x| py_round(x, 6) + 0.0)));
            }
        }
        Surf::Cyl { dir, r, .. } => {
            round(&mut e, dir);
            e.insert("radius".into(), num(r));
            if let Some(l) = spread(dir) {
                e.insert("length".into(), num(l));
            }
        }
        Surf::Cone { dir, semi, .. } => {
            round(&mut e, dir);
            e.insert("semiAngle".into(), num(semi.abs()));
            if let Some(l) = spread(dir) {
                e.insert("length".into(), num(l));
            }
        }
        Surf::Sphere { r, .. } => {
            e.insert("radius".into(), num(r));
        }
        Surf::Torus { dir, big, small, .. } => {
            round(&mut e, dir);
            e.insert("major".into(), num(big));
            e.insert("radius".into(), num(small));
        }
        Surf::Other => {}
    }
    if s.analytic_curved() {
        if let Some(c) = concave(face, &s) {
            e.insert("concave".into(), json!(c));
        }
    }
    Value::Object(e)
}

fn spread(points: impl Iterator<Item = DVec3>, axis: DVec3) -> Option<f64> {
    let (low, high) = points.map(|p| p.dot(axis)).fold((f64::MAX, f64::MIN), |(l, h), x| (l.min(x), h.max(x)));
    (low <= high).then_some(high - low)
}

/// Only a curve on the coarse outline is sampled again, so a plate's thousand holes cost nothing more.
fn flat_size(edges: &[&WalkedEdge], normal: DVec3, access: &MeshAccess) -> Option<[f64; 2]> {
    let (u, v) = normal.any_orthonormal_pair();
    let flat = |p: &[f64; 3]| {
        let p = DVec3::from_array(*p);
        [p.dot(u), p.dot(v)]
    };
    let mut points: Vec<[f64; 2]> = edges.iter().flat_map(|e| &e.points).map(flat).collect();
    if edges.iter().any(|e| e.points.len() > 2) {
        let outline: HashSet<[u64; 2]> = convex_hull(&points).iter().map(|p| p.map(f64::to_bits)).collect();
        for e in edges {
            if e.points.len() > 2 && e.points.iter().any(|p| outline.contains(&flat(p).map(f64::to_bits))) {
                if let Some((fine, _)) = access.edge_deflection(e.edge, OUTLINE_DEFLECTION) {
                    points.extend(fine.iter().map(flat));
                }
            }
        }
    }
    min_rect(&points)
}

fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn turn(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn apart(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn half_hull<'a>(walk: impl Iterator<Item = &'a [f64; 2]>) -> Vec<[f64; 2]> {
    let mut out: Vec<[f64; 2]> = Vec::new();
    for &p in walk {
        while out.len() >= 2 && turn(out[out.len() - 2], out[out.len() - 1], p) <= 0.0 {
            out.pop();
        }
        out.push(p);
    }
    out.pop();
    out
}

/// Counter-clockwise. The ends of two edges at one vertex differ by noise, and a hull side that short has no direction.
fn convex_hull(points: &[[f64; 2]]) -> Vec<[f64; 2]> {
    const SAME: f64 = 1e-7;
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let mut hull = half_hull(sorted.iter());
    hull.extend(half_hull(sorted.iter().rev()));
    let mut out: Vec<[f64; 2]> = Vec::with_capacity(hull.len());
    for p in hull {
        if out.last().map_or(true, |&q| apart(p, q) > SAME) {
            out.push(p);
        }
    }
    while out.len() > 1 && apart(out[0], out[out.len() - 1]) <= SAME {
        out.pop();
    }
    if out.is_empty() {
        out.extend(sorted.first());
    }
    out
}

/// `[long, short]` of the smallest area rectangle around the points. It has a side along the hull, and the other
/// three extremes only move forward as that side turns (rotating calipers), so this is linear in the hull.
pub(crate) fn min_rect(points: &[[f64; 2]]) -> Option<[f64; 2]> {
    let hull = convex_hull(points);
    let n = hull.len();
    match n {
        0 => return None,
        1 => return Some([0.0, 0.0]),
        2 => return Some([apart(hull[0], hull[1]), 0.0]),
        _ => {}
    }
    let at = |k: usize| hull[k % n];
    let (mut right, mut top, mut left) = (1, 1, 1);
    let mut best: Option<(f64, [f64; 2])> = None;
    for i in 0..n {
        let (a, b) = (at(i), at(i + 1));
        let len = apart(a, b);
        let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let up = [-d[1], d[0]];
        right = right.max(i + 1);
        while dot(at(right + 1), d) > dot(at(right), d) {
            right += 1;
        }
        top = top.max(right);
        while dot(at(top + 1), up) > dot(at(top), up) {
            top += 1;
        }
        left = left.max(top);
        while dot(at(left + 1), d) < dot(at(left), d) {
            left += 1;
        }
        let wide = dot(at(right), d) - dot(at(left), d);
        let tall = dot(at(top), up) - dot(a, up);
        if best.map_or(true, |(area, _)| wide * tall < area) {
            best = Some((wide * tall, if wide >= tall { [wide, tall] } else { [tall, wide] }));
        }
    }
    best.map(|(_, sides)| sides)
}

#[cfg(test)]
#[path = "topology_tests.rs"]
mod tests;
