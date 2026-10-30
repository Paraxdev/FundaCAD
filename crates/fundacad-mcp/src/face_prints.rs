//! The saved print of a face, as src/document/faceRefs.ts measures it, so a face the MCP assigns a material to stays on
//! that face when a later feature reorders OCCT's face list. tests/vectors/materials.json pins the two together.

use serde_json::{json, Value};

use crate::materials::num;
use crate::mesh::MeshBody;

const SAMPLES: usize = 12;
const PLANE_ANG: f64 = 1e-4;
const MAX_CANDIDATE_TRIS: usize = 512;

type Vec3 = [f64; 3];

fn sub(a: &[f64], b: &[f64]) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn len(a: &[f64]) -> f64 {
    dot(a, a).sqrt()
}

// Math.round: halves go up, where f64::round takes them away from zero.
fn js_round(v: f64) -> f64 {
    let down = v.floor();
    if v - down >= 0.5 {
        down + 1.0
    } else {
        down
    }
}

fn rounded(v: &[f64], scale: f64) -> Vec<Value> {
    v.iter().map(|x| num(js_round(x * scale) / scale)).collect()
}

fn triangles_by_face(body: &MeshBody, faces: usize) -> Vec<Vec<usize>> {
    let mut lists = vec![Vec::new(); faces];
    for (t, f) in body.face_ids.iter().enumerate() {
        if let Some(list) = lists.get_mut(*f as usize) {
            list.push(t);
        }
    }
    lists
}

fn sample(tris: &[f64], centroid: &Vec3) -> Vec<f64> {
    let count = tris.len() / 9;
    let step = (count / MAX_CANDIDATE_TRIS).max(1);
    let mut cand: Vec<Vec3> = Vec::new();
    for k in (0..count).step_by(step) {
        let o = 9 * k;
        let at = |a: usize| (tris[o + a] + tris[o + 3 + a] + tris[o + 6 + a]) / 3.0;
        let m = [at(0), at(1), at(2)];
        cand.push(m);
        for j in 0..3 {
            let mid = |a: usize| (m[a] + tris[o + 3 * j + a]) / 2.0;
            cand.push([mid(0), mid(1), mid(2)]);
        }
    }
    let mut out = Vec::new();
    if cand.is_empty() {
        return out;
    }
    let mut top = f64::NEG_INFINITY;
    let mut pick = 0;
    for (i, p) in cand.iter().enumerate() {
        let d = len(&sub(p, centroid));
        if d > top {
            top = d;
            pick = i;
        }
    }
    let mut gap = vec![f64::INFINITY; cand.len()];
    for _ in 0..SAMPLES {
        let p = cand[pick];
        out.extend_from_slice(&p);
        let mut best = None;
        let mut far = 1e-9;
        for (i, q) in cand.iter().enumerate() {
            gap[i] = gap[i].min(len(&sub(q, &p)));
            if gap[i] > far {
                far = gap[i];
                best = Some(i);
            }
        }
        match best {
            Some(next) => pick = next,
            None => break,
        }
    }
    out
}

fn print_of(body: &MeshBody, list: &[usize], faces: usize) -> Value {
    let mut tris = vec![0.0; list.len() * 9];
    let mut centre: Vec3 = [0.0; 3];
    let mut n: Vec3 = [0.0; 3];
    let mut units: Vec<Vec3> = Vec::new();
    let mut area = 0.0;
    for (k, t) in list.iter().enumerate() {
        for j in 0..3 {
            let v = body.indices[3 * t + j] as usize;
            for a in 0..3 {
                tris[9 * k + 3 * j + a] = f64::from(body.positions[3 * v + a]);
            }
        }
        let o = 9 * k;
        let cr = cross(sub(&tris[o + 3..], &tris[o..]), sub(&tris[o + 6..], &tris[o..]));
        let a2 = len(&cr);
        area += a2 / 2.0;
        for a in 0..3 {
            centre[a] += (a2 / 2.0) * ((tris[o + a] + tris[o + 3 + a] + tris[o + 6 + a]) / 3.0);
            n[a] += cr[a] / 2.0;
        }
        if a2 > 0.0 {
            units.push([cr[0] / a2, cr[1] / a2, cr[2] / a2]);
        }
    }
    let nl = len(&n);
    let centroid: Vec3 = if area > 0.0 {
        [centre[0] / area, centre[1] / area, centre[2] / area]
    } else {
        [tris.first().copied().unwrap_or(0.0), tris.get(1).copied().unwrap_or(0.0), tris.get(2).copied().unwrap_or(0.0)]
    };
    // A closed or half round face's area vectors cancel, its mean normal says nothing.
    let normal: Vec3 = if nl > 0.05 * area && nl > 0.0 { [n[0] / nl, n[1] / nl, n[2] / nl] } else { [0.0; 3] };
    let plane = len(&normal) > 0.0 && units.iter().all(|u| 1.0 - dot(u, &normal) <= PLANE_ANG);
    json!({
        "centroid": rounded(&centroid, 1e4),
        "normal": rounded(&normal, 1e6),
        "area": num(js_round(area * 1e4) / 1e4),
        "surface": if plane { "plane" } else { "curved" },
        "points": rounded(&sample(&tris, &centroid), 1e4),
        "faces": faces,
    })
}

/// The print of each of the body's faces, by local face index.
pub fn body_prints(body: &MeshBody) -> Vec<Value> {
    let top = body.face_ids.iter().max().map_or(0, |f| *f as usize + 1);
    let faces = body.get("faceCount").and_then(Value::as_u64).map_or(top, |n| n as usize);
    triangles_by_face(body, faces).iter().map(|list| print_of(body, list, faces)).collect()
}
