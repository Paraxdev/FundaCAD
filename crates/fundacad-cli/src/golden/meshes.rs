//! diff_meshes.py against a golden: the viewport mesh of every body, the ASCII
//! STL export, and this engine's etags.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::kdtree::KdTree;
use super::{absolute_image_paths, floats, indices, ivec, ivec_rows, table, verdict, Ctx, Session};

type P3 = [f64; 3];

struct Tols {
    vertex: f64,
    surface: f64,
    normal: f64,
    neighbours: usize,
}

fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: P3) -> f64 {
    dot(a, a).sqrt()
}

/// diff_meshes.point_triangle_distance for one point.
fn point_triangle_distance(p: P3, a: P3, b: P3, c: P3) -> f64 {
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    let cp = sub(p, c);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    let va = d3 * d6 - d5 * d4;
    let vb = d5 * d2 - d1 * d6;
    let vc = d1 * d4 - d3 * d2;
    let mut denom = va + vb + vc;
    if denom.abs() < 1e-300 {
        denom = 1e-300;
    }
    let (v, w) = (vb / denom, vc / denom);
    let q = [
        a[0] + ab[0] * v + ac[0] * w,
        a[1] + ab[1] * v + ac[1] * w,
        a[2] + ab[2] * v + ac[2] * w,
    ];
    let seg = |p0: P3, p1: P3| {
        let d = sub(p1, p0);
        let t = (dot(sub(p, p0), d) / dot(d, d).max(1e-300)).clamp(0.0, 1.0);
        norm(sub(
            p,
            [p0[0] + d[0] * t, p0[1] + d[1] * t, p0[2] + d[2] * t],
        ))
    };
    let inside = va >= 0.0 && vb >= 0.0 && vc >= 0.0;
    let dist = if inside {
        norm(sub(p, q))
    } else {
        f64::INFINITY
    };
    dist.min(seg(a, b).min(seg(b, c).min(seg(c, a))))
}

fn centroids(p: &[P3], tris: &[[usize; 3]]) -> Vec<P3> {
    tris.iter()
        .map(|t| {
            let (a, b, c) = (p[t[0]], p[t[1]], p[t[2]]);
            [
                (a[0] + b[0] + c[0]) / 3.0,
                (a[1] + b[1] + c[1]) / 3.0,
                (a[2] + b[2] + c[2]) / 3.0,
            ]
        })
        .collect()
}

/// diff_meshes.surface_gap: the largest distance from a triangle centroid of
/// (p, i) to the surface (q, j), each measured against the triangles whose
/// centroids are the nearest few.
fn surface_gap(p: &[P3], i: &[[usize; 3]], q: &[P3], j: &[[usize; 3]], k: usize) -> f64 {
    if i.is_empty() || j.is_empty() {
        return if i.len() == j.len() {
            0.0
        } else {
            f64::INFINITY
        };
    }
    let cen = centroids(p, i);
    let tree = KdTree::new(&centroids(q, j));
    let k = k.min(j.len());
    cen.iter()
        .map(|c| {
            tree.knn(*c, k)
                .into_iter()
                .map(|t| {
                    let t = j[t];
                    point_triangle_distance(*c, q[t[0]], q[t[1]], q[t[2]])
                })
                .fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max)
}

fn vertex_gap(p: &[P3], q: &[P3]) -> f64 {
    if p.is_empty() || q.is_empty() {
        return if p.len() == q.len() {
            0.0
        } else {
            f64::INFINITY
        };
    }
    let (tp, tq) = (KdTree::new(p), KdTree::new(q));
    let a = p.iter().map(|x| tq.nearest(*x).0).fold(0.0, f64::max);
    let b = q.iter().map(|x| tp.nearest(*x).0).fold(0.0, f64::max);
    a.max(b)
}

/// diff_meshes.unmatched: triangles of (p, i) with no triangle of (q, j) on
/// the same three corners.
fn unmatched(p: &[P3], i: &[[usize; 3]], q: &[P3], j: &[[usize; 3]], tol: f64) -> usize {
    if i.is_empty() || j.is_empty() {
        return i.len();
    }
    let tree = KdTree::new(&centroids(q, j));
    let cen = centroids(p, i);
    i.iter()
        .zip(&cen)
        .filter(|(t, c)| {
            let near = j[tree.nearest(**c).1];
            let gap = t
                .iter()
                .map(|a| {
                    near.iter()
                        .map(|b| norm(sub(p[*a], q[*b])))
                        .fold(f64::INFINITY, f64::min)
                })
                .fold(0.0, f64::max);
            gap > tol
        })
        .count()
}

fn compare_mesh(
    tol: &Tols,
    p: &[P3],
    i: &[[usize; 3]],
    q: &[P3],
    j: &[[usize; 3]],
    what: &str,
) -> (Vec<String>, Vec<String>) {
    let (mut diffs, mut notes) = (Vec::new(), Vec::new());
    if i.len() != j.len() {
        return (
            vec![format!("{what}: {} triangles vs {}", j.len(), i.len())],
            notes,
        );
    }
    let gap = vertex_gap(p, q);
    if gap > tol.vertex {
        diffs.push(format!(
            "{what}: a vertex {gap:.3e} from the other engine's nearest"
        ));
    }
    let s = surface_gap(p, i, q, j, tol.neighbours).max(surface_gap(q, j, p, i, tol.neighbours));
    if s > tol.surface {
        diffs.push(format!(
            "{what}: a triangle {s:.3e} off the other engine's surface"
        ));
    }
    let moved = unmatched(p, i, q, j, tol.vertex);
    if moved > 0 {
        notes.push(format!(
            "{what}: {moved} triangle(s) on the other diagonal, same surface"
        ));
    }
    (diffs, notes)
}

fn rows3(v: &[f64]) -> Vec<P3> {
    v.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

fn tris(v: &[usize]) -> Vec<[usize; 3]> {
    v.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

fn golden_tris(v: &Value) -> Result<Vec<[usize; 3]>, String> {
    Ok(tris(
        &ivec(v)?.into_iter().map(|x| x as usize).collect::<Vec<_>>(),
    ))
}

fn bodies(reply: &Value) -> BTreeMap<String, Value> {
    reply["result"]["bodies"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|b| (b["id"].as_str().unwrap_or("").to_owned(), b.clone()))
        .collect()
}

fn histogram(face_ids: &[usize]) -> Vec<u64> {
    let mut h = vec![0u64; face_ids.iter().max().map_or(0, |m| m + 1)];
    for f in face_ids {
        h[*f] += 1;
    }
    while h.last() == Some(&0) {
        h.pop();
    }
    h
}

fn read_stl(path: &std::path::Path) -> (Vec<P3>, Vec<[usize; 3]>) {
    let text = std::fs::read(path).unwrap_or_default();
    let text = String::from_utf8_lossy(&text);
    let pts: Vec<P3> = text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("vertex"))
        .map(|l| {
            let v: Vec<f64> = l
                .split_whitespace()
                .skip(1)
                .take(3)
                .map(|x| x.parse().unwrap_or(f64::NAN))
                .collect();
            [v[0], v[1], v[2]]
        })
        .collect();
    let n = pts.len() / 3;
    (pts, (0..n).map(|t| [3 * t, 3 * t + 1, 3 * t + 2]).collect())
}

fn deeper(doc: &Value) -> Option<Value> {
    let mut d = doc.clone();
    let mut hit = false;
    for f in d["features"].as_array_mut().into_iter().flatten() {
        if f["type"] == "texture" {
            let depth = f.get("depth").and_then(Value::as_f64).unwrap_or(0.4);
            f["depth"] = json!(depth * 1.5);
            hit = true;
        }
    }
    hit.then_some(d)
}

struct Rust {
    first: Value,
    again: Value,
    changed: Option<Value>,
    export: Value,
    stl: std::path::PathBuf,
}

fn compare_doc(
    ctx: &Ctx,
    tol: &Tols,
    py: &Value,
    rs: &Rust,
) -> Result<(Vec<String>, Vec<String>), String> {
    let (mut diffs, mut notes) = (Vec::new(), Vec::new());
    let ok = rs.first["ok"] == true;
    if py["ok"].as_bool() != Some(ok) {
        return Ok((vec![format!("rebuild ok {ok} vs {}", py["ok"])], notes));
    }
    let pb = py["bodies"].as_object().cloned().unwrap_or_default();
    let rb = bodies(&rs.first);
    if pb.keys().ne(rb.keys()) {
        return Ok((
            vec![format!(
                "bodies {:?} vs {:?}",
                rb.keys().collect::<Vec<_>>(),
                pb.keys().collect::<Vec<_>>()
            )],
            notes,
        ));
    }
    let pq = ctx.header()["positionQuantum"].as_f64().unwrap_or(1e-6);
    let nq = ctx.header()["normalQuantum"].as_f64().unwrap_or(1e-5);
    for (bid, want) in &pb {
        let got = &rb[bid];
        let hp: Vec<u64> = {
            let mut h: Vec<u64> = want["faceTriangles"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|x| x.as_u64().unwrap_or(0))
                .collect();
            while h.last() == Some(&0) {
                h.pop();
            }
            h
        };
        let hr = histogram(&indices(&got["faceIds"]));
        if hp != hr {
            let n = hp.len().max(hr.len());
            let at = |h: &Vec<u64>, k: usize| h.get(k).copied().unwrap_or(0);
            let bad: Vec<usize> = (0..n).filter(|k| at(&hp, *k) != at(&hr, *k)).collect();
            let mut msg = format!(
                "{bid}: face {} has {} triangles vs {}",
                bad[0],
                at(&hr, bad[0]),
                at(&hp, bad[0])
            );
            if bad.len() > 1 {
                msg.push_str(&format!(" ({} faces differ)", bad.len()));
            }
            diffs.push(msg);
            continue;
        }
        let p = ivec_rows(&want["positions"], pq)?;
        let i = golden_tris(&want["indices"])?;
        let q = rows3(&floats(&got["positions"]));
        let j = tris(&indices(&got["indices"]));
        let (d, n) = compare_mesh(tol, &p, &i, &q, &j, &format!("{bid} viewport"));
        diffs.extend(d);
        notes.extend(n);
        let nrm = ivec_rows(&want["normals"], nq)?;
        let m = rows3(&floats(&got["normals"]));
        if !nrm.is_empty() && !m.is_empty() && nrm.len() == p.len() && m.len() == q.len() {
            let flat: std::collections::BTreeSet<usize> =
                indices(&want["flatVertices"]).into_iter().collect();
            let tree = KdTree::new(&p);
            let mut worst: f64 = 0.0;
            for (k, qk) in q.iter().enumerate() {
                if tree.nearest(*qk).0 > tol.vertex {
                    continue;
                }
                let best = tree
                    .within(*qk, tol.vertex)
                    .into_iter()
                    .map(|c| {
                        (
                            (0..3)
                                .map(|a| (nrm[c][a] - m[k][a]).abs())
                                .fold(0.0, f64::max),
                            c,
                        )
                    })
                    .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                if let Some((gap, c)) = best {
                    if !flat.contains(&c) {
                        worst = worst.max(gap);
                    }
                }
            }
            if worst > tol.normal {
                diffs.push(format!("{bid}: a normal off by {worst:.3e}"));
            }
        } else if nrm.is_empty() != m.is_empty() {
            diffs.push(format!("{bid}: normals on one engine only"));
        }
        let slots = got.get("faceColorSlots").cloned().unwrap_or(Value::Null);
        if slots != want["faceColorSlots"] {
            diffs.push(format!(
                "{bid}: faceColorSlots {slots} vs {}",
                want["faceColorSlots"]
            ));
        }
    }
    let (a, b) = (bodies(&rs.first), bodies(&rs.again));
    let etags = |m: &BTreeMap<String, Value>| -> BTreeMap<String, Value> {
        m.iter()
            .map(|(k, v)| (k.clone(), v.get("etag").cloned().unwrap_or(Value::Null)))
            .collect()
    };
    if etags(&a) != etags(&b) {
        diffs.push("rust: an etag changed on an identical rebuild".into());
    }
    if let Some(changed) = &rs.changed {
        let c = bodies(changed);
        let kept: Vec<&String> = a
            .iter()
            .filter(|(k, v)| {
                let other = c.get(*k);
                v.get("etag") == other.and_then(|o| o.get("etag"))
                    && v.get("positions") != other.and_then(|o| o.get("positions"))
            })
            .map(|(k, _)| k)
            .collect();
        if !kept.is_empty() {
            diffs.push(format!(
                "rust: {kept:?} kept its etag with a deeper texture"
            ));
        }
    }
    let pe = &py["export"];
    let eok = rs.export["ok"] == true;
    if pe["ok"].as_bool() != Some(eok) {
        diffs.push(format!(
            "export ok {eok} vs {}: {} vs {}",
            pe["ok"],
            ctx.normalise_all(&rs.export["error"]),
            pe["error"]
        ));
    } else if eok {
        let warnings = ctx.normalise_all(&rs.export["result"]["warnings"]);
        if warnings != pe["warnings"] {
            diffs.push(format!("export warnings {warnings} vs {}", pe["warnings"]));
        }
        let p = ivec_rows(&pe["positions"], pq)?;
        let i = golden_tris(&pe["indices"])?;
        let (q, j) = read_stl(&rs.stl);
        let (d, n) = compare_mesh(tol, &p, &i, &q, &j, "export");
        diffs.extend(d);
        notes.extend(n.into_iter().filter(|x| !x.contains("diagonal")));
    }
    Ok((diffs, notes))
}

pub fn check(ctx: &Ctx) -> Result<bool, String> {
    let docs = ctx.corpus["documents"]
        .as_array()
        .ok_or("the corpus has no documents")?;
    let cases = ctx.cases().as_object().ok_or("the golden has no cases")?;
    if docs.len() != cases.len() {
        return Err(format!(
            "the golden has {} cases, the corpus {}",
            cases.len(),
            docs.len()
        ));
    }
    let tolerance = ctx.header()["rebuildTolerance"].as_f64().unwrap_or(0.1);
    let tol = Tols {
        vertex: ctx.tol("vertex"),
        surface: ctx.tol("surface"),
        normal: ctx.tol("normal"),
        neighbours: ctx.tol("surfaceNeighbours") as usize,
    };
    let prepared: Vec<(String, Value)> = docs
        .iter()
        .map(|d| {
            let mut doc = d["document"].clone();
            absolute_image_paths(&mut doc, &ctx.repo);
            (d["name"].as_str().unwrap_or("").to_owned(), doc)
        })
        .collect();
    // Rebuilds and exports each in a fresh engine, as diff_meshes.run_engine runs them.
    let mut runs = Vec::new();
    {
        let mut s = Session::start();
        for (_, doc) in &prepared {
            let req = |d: &Value| json!({"document": d, "tolerance": tolerance, "binary": false});
            let first = s.call("rebuild", req(doc));
            let again = s.call("rebuild", req(doc));
            let changed = deeper(doc).map(|d| s.call("rebuild", req(&d)));
            runs.push((first, again, changed));
        }
    }
    let mut exports = Vec::new();
    {
        let mut s = Session::start();
        for (i, (_, doc)) in prepared.iter().enumerate() {
            let stl = ctx.work.join(format!("rs-{i}.stl"));
            let export = s.call(
                "export",
                json!({"document": doc, "format": "stl", "path": stl.to_string_lossy(), "mesh": {"binary": false}}),
            );
            exports.push((export, stl));
        }
    }
    let mut rows = Vec::new();
    let mut bad = 0;
    for (((name, _), (first, again, changed)), (export, stl)) in
        prepared.iter().zip(runs).zip(exports)
    {
        let py = cases
            .get(name)
            .ok_or_else(|| format!("the golden has no case {name}"))?;
        let rs = Rust {
            first,
            again,
            changed,
            export,
            stl,
        };
        let (diffs, notes) = compare_doc(ctx, &tol, py, &rs)?;
        bad += usize::from(!diffs.is_empty());
        rows.push(vec![
            name.clone(),
            if diffs.is_empty() {
                "match"
            } else {
                "MISMATCH"
            }
            .into(),
            if diffs.is_empty() {
                notes.join("; ")
            } else {
                diffs.join("; ")
            },
        ]);
    }
    table(&rows, &["document", "status", "detail"]);
    Ok(verdict(bad, rows.len()))
}
