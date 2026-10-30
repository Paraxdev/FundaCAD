//! The saved print of a face, and how a saved face finds itself in a new build, as src/document/faceRefs.ts does it, so
//! a face the MCP assigns a material to stays on that face when a later feature reorders OCCT's face list.
//! tests/vectors/materials.json pins the two together.

use serde_json::{json, Map, Value};

use crate::materials::num;
use crate::materials_doc::{face_key, parse_face_key};
use crate::mesh::MeshBody;

const SAMPLES: usize = 12;
const PLANE_ANG: f64 = 1e-4;
const ANG_TOL: f64 = 0.02;
const AREA_REL: f64 = 0.05;
const MAX_CANDIDATE_TRIS: usize = 512;
// Prints keep points to 1e-4, so a point within 1e-3 of a face is on it.
const ON2: f64 = 1e-6;

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

fn rounded<const N: usize>(v: [f64; N], scale: f64) -> [f64; N] {
    v.map(|x| js_round(x * scale) / scale)
}

fn numbers(v: &[f64]) -> Vec<Value> {
    v.iter().map(|x| num(*x)).collect()
}

#[derive(Debug, Clone)]
struct Print {
    centroid: Vec3,
    normal: Vec3,
    area: f64,
    plane: bool,
    points: Vec<f64>,
    faces: u64,
}

impl Print {
    fn to_value(&self) -> Value {
        json!({
            "centroid": numbers(&self.centroid),
            "normal": numbers(&self.normal),
            "area": num(self.area),
            "surface": if self.plane { "plane" } else { "curved" },
            "points": numbers(&self.points),
            "faces": self.faces,
        })
    }

    /// isPrint: anything else counts as no print, as the app reads it.
    fn from_value(v: &Value) -> Option<Print> {
        let vec3 = |key: &str| -> Option<Vec3> {
            let list = v.get(key)?.as_array()?;
            let [x, y, z] = list.as_slice() else { return None };
            Some([x.as_f64()?, y.as_f64()?, z.as_f64()?])
        };
        let plane = match v.get("surface")?.as_str()? {
            "plane" => true,
            "curved" => false,
            _ => return None,
        };
        let points = v.get("points")?.as_array()?.iter().map(Value::as_f64).collect::<Option<Vec<f64>>>()?;
        let faces = v.get("faces")?.as_u64().filter(|n| *n <= 9_007_199_254_740_991)?;
        Some(Print {
            centroid: vec3("centroid")?,
            normal: vec3("normal")?,
            area: v.get("area")?.as_f64()?,
            plane,
            points,
            faces,
        })
    }
}

struct FaceGeom {
    print: Print,
    tris: Vec<f64>,
    lo: Vec3,
    hi: Vec3,
}

struct BodyGeom {
    faces: Vec<FaceGeom>,
    diag: f64,
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

fn measure_face(body: &MeshBody, list: &[usize], faces: usize) -> FaceGeom {
    let mut tris = vec![0.0; list.len() * 9];
    let mut lo: Vec3 = [f64::INFINITY; 3];
    let mut hi: Vec3 = [f64::NEG_INFINITY; 3];
    let mut centre: Vec3 = [0.0; 3];
    let mut n: Vec3 = [0.0; 3];
    let mut units: Vec<Vec3> = Vec::new();
    let mut area = 0.0;
    for (k, t) in list.iter().enumerate() {
        for j in 0..3 {
            let v = body.indices[3 * t + j] as usize;
            for a in 0..3 {
                let x = f64::from(body.positions[3 * v + a]);
                tris[9 * k + 3 * j + a] = x;
                lo[a] = lo[a].min(x);
                hi[a] = hi[a].max(x);
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
    let print = Print {
        centroid: rounded(centroid, 1e4),
        normal: rounded(normal, 1e6),
        area: js_round(area * 1e4) / 1e4,
        plane,
        points: sample(&tris, &centroid).into_iter().map(|x| js_round(x * 1e4) / 1e4).collect(),
        faces: faces as u64,
    };
    FaceGeom { print, tris, lo, hi }
}

fn measure(body: &MeshBody) -> BodyGeom {
    let top = body.face_ids.iter().max().map_or(0, |f| *f as usize + 1);
    let count = body.get("faceCount").and_then(Value::as_u64).map_or(top, |n| n as usize);
    let mut lists = vec![Vec::new(); count];
    for (t, f) in body.face_ids.iter().enumerate() {
        if let Some(list) = lists.get_mut(*f as usize) {
            list.push(t);
        }
    }
    let faces: Vec<FaceGeom> = lists.iter().map(|list| measure_face(body, list, count)).collect();
    let mut lo: Vec3 = [f64::INFINITY; 3];
    let mut hi: Vec3 = [f64::NEG_INFINITY; 3];
    for f in &faces {
        for a in 0..3 {
            lo[a] = lo[a].min(f.lo[a]);
            hi[a] = hi[a].max(f.hi[a]);
        }
    }
    let diag = if lo[0].is_finite() { len(&sub(&hi, &lo)) } else { 0.0 };
    BodyGeom { faces, diag }
}

/// The print of each of the body's faces, by local face index.
pub fn body_prints(body: &MeshBody) -> Vec<Value> {
    measure(body).faces.iter().map(|f| f.print.to_value()).collect()
}

/// Squared distance from `p` to the triangle at `o` in `t` (Ericson, closest point on triangle).
fn tri_dist2(p: &Vec3, t: &[f64], o: usize) -> f64 {
    let (a, b, c) = (&t[o..o + 3], &t[o + 3..o + 6], &t[o + 6..o + 9]);
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(&ab, &ap), dot(&ac, &ap));
    let at = |q: &[f64]| {
        let d = sub(p, q);
        dot(&d, &d)
    };
    let along = |s: &[f64], e: &Vec3, v: f64| at(&[s[0] + v * e[0], s[1] + v * e[1], s[2] + v * e[2]]);
    if d1 <= 0.0 && d2 <= 0.0 {
        return at(a);
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(&ab, &bp), dot(&ac, &bp));
    if d3 >= 0.0 && d4 <= d3 {
        return at(b);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return along(a, &ab, d1 / (d1 - d3));
    }
    let cp = sub(p, c);
    let (d5, d6) = (dot(&ab, &cp), dot(&ac, &cp));
    if d6 >= 0.0 && d5 <= d6 {
        return at(c);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return along(a, &ac, d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return along(b, &sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
    }
    let den = 1.0 / (va + vb + vc);
    let (v, w) = (vb * den, vc * den);
    at(&[a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w])
}

/// Squared distance from `p` to the face, infinite past `tol` of its box.
fn dist2(p: &Vec3, g: &FaceGeom, tol: f64) -> f64 {
    if (0..3).any(|a| p[a] < g.lo[a] - tol || p[a] > g.hi[a] + tol) {
        return f64::INFINITY;
    }
    let mut best = f64::INFINITY;
    let mut o = 0;
    while o < g.tris.len() && best > ON2 {
        best = best.min(tri_dist2(p, &g.tris, o));
        o += 9;
    }
    best
}

#[derive(Debug, Clone, Copy)]
struct Claim {
    face: usize,
    /// 0 stayed put, 1 kept its index.
    rank: u8,
    hits: usize,
}

// The app's face grid only narrows this down, each face it would skip fails the box test below too.
fn stay_put(o: &Print, g: &BodyGeom) -> Vec<Claim> {
    let near = if o.plane { 1e-3 + 1e-5 * g.diag } else { 0.5 + 1e-3 * g.diag };
    let plane_tol = 1e-3 + 1e-5 * g.diag;
    let mut lo: Vec3 = [f64::INFINITY; 3];
    let mut hi: Vec3 = [f64::NEG_INFINITY; 3];
    for p in o.points.chunks_exact(3) {
        for a in 0..3 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    let mut cands = vec![];
    for (face, f) in g.faces.iter().enumerate() {
        let n = &f.print;
        if n.plane != o.plane || (0..3).any(|a| hi[a] < f.lo[a] - near || lo[a] > f.hi[a] + near) {
            continue;
        }
        if o.plane
            && (1.0 - dot(&o.normal, &n.normal) > PLANE_ANG
                || dot(&n.normal, &sub(&o.centroid, &n.centroid)).abs() > plane_tol)
        {
            continue;
        }
        cands.push(face);
    }
    // Each point counts for the nearest face only: a face narrower than the
    // tolerance would otherwise hand its material to its neighbours.
    let mut hits = vec![0; g.faces.len()];
    for chunk in o.points.chunks_exact(3) {
        let p = [chunk[0], chunk[1], chunk[2]];
        let mut best = None;
        let mut best_d = near * near;
        for &face in &cands {
            let d = dist2(&p, &g.faces[face], near);
            if d <= best_d {
                best_d = d;
                best = Some(face);
            }
            if best_d <= ON2 {
                break;
            }
        }
        if let Some(face) = best {
            hits[face] += 1;
        }
    }
    let most = hits.iter().copied().max().unwrap_or(0);
    hits.iter()
        .enumerate()
        // A curved face's points near its edge can lie nearer a round cut next to it,
        // so only the faces holding a fair share of them count.
        .filter(|(_, h)| **h > 0 && (o.plane || 3 * **h >= most))
        .map(|(face, h)| Claim { face, rank: 0, hits: *h })
        .collect()
}

fn looks_like(o: &Print, n: &Print) -> bool {
    o.plane == n.plane
        && ((n.area - o.area).abs() <= AREA_REL * n.area.max(o.area) || 1.0 - dot(&n.normal, &o.normal) <= ANG_TOL)
}

fn by_index(o: Option<&Print>, face: usize, g: &BodyGeom) -> Vec<Claim> {
    let Some(n) = g.faces.get(face).map(|f| &f.print) else { return vec![] };
    if o.is_some_and(|o| o.faces != g.faces.len() as u64 || !looks_like(o, n)) {
        return vec![];
    }
    vec![Claim { face, rank: 1, hits: 0 }]
}

struct Ref<'a> {
    body: &'a str,
    face: u64,
    material: &'a Value,
    at: Option<Print>,
    on: Vec<usize>,
}

struct Located<'a> {
    refs: Vec<Ref<'a>>,
    foreign: Vec<&'a String>,
    geoms: Vec<(&'a str, BodyGeom)>,
}

/// resolveFaceRefs without a track.
fn locate<'a>(materials: &'a Map<String, Value>, prints: &Map<String, Value>, mesh: &[MeshBody]) -> Located<'a> {
    let mut refs: Vec<Ref> = vec![];
    let mut foreign = vec![];
    for (key, material) in materials {
        match parse_face_key(key).filter(|_| material.is_string()) {
            Some((body, face)) => {
                let at = prints.get(key).and_then(Print::from_value);
                refs.push(Ref { body, face, material, at, on: vec![] });
            }
            None => foreign.push(key),
        }
    }
    let mut bodies: Vec<&str> = vec![];
    for r in &refs {
        if !bodies.contains(&r.body) {
            bodies.push(r.body);
        }
    }
    let mut geoms: Vec<(&str, BodyGeom)> = vec![];
    for id in bodies {
        let Some(body) = mesh.iter().find(|b| b.id() == id) else { continue };
        let g = measure(body);
        let mut claims: Vec<(usize, Claim)> = vec![];
        for (i, r) in refs.iter().enumerate().filter(|(_, r)| r.body == id) {
            let mut mine = r.at.as_ref().map_or(vec![], |at| stay_put(at, &g));
            if mine.is_empty() {
                mine = by_index(r.at.as_ref(), r.face as usize, &g);
            }
            claims.extend(mine.into_iter().map(|c| (i, c)));
        }
        claims.sort_by(|(_, a), (_, b)| a.rank.cmp(&b.rank).then(b.hits.cmp(&a.hits)));
        let mut taken = vec![false; g.faces.len()];
        for (i, c) in claims {
            if !std::mem::replace(&mut taken[c.face], true) {
                refs[i].on.push(c.face);
            }
        }
        geoms.push((id, g));
    }
    Located { refs, foreign, geoms }
}

/// One saved face and the faces of `mesh` it draws on, none when it is lost.
pub struct Placed<'a> {
    pub body: &'a str,
    pub face: u64,
    pub material: &'a Value,
    pub on: Vec<usize>,
}

/// Where the app draws each saved face. A lost face draws nothing, whatever now holds its old number.
pub fn placed<'a>(
    materials: &'a Map<String, Value>,
    prints: &Map<String, Value>,
    mesh: &[MeshBody],
) -> Vec<Placed<'a>> {
    let refs = locate(materials, prints, mesh).refs;
    refs.into_iter().map(|r| Placed { body: r.body, face: r.face, material: r.material, on: r.on }).collect()
}

/// `faceMaterials` and `facePrints` as the app saves them after a first build of `mesh`: resolveFaceRefs without a
/// track, then savedFaceRefs. A key that is not the app's, or a key with no material, rides along untouched.
pub fn rekeyed(
    materials: &Map<String, Value>,
    prints: &Map<String, Value>,
    mesh: &[MeshBody],
) -> (Map<String, Value>, Map<String, Value>) {
    let Located { mut refs, foreign, geoms } = locate(materials, prints, mesh);
    let mut out_materials = Map::new();
    let mut out_prints = Map::new();
    // Lost refs first: a ref found on a face wins that key.
    for r in refs.iter().filter(|r| r.on.is_empty()) {
        let key = face_key(r.body, r.face);
        out_materials.insert(key.clone(), r.material.clone());
        match &r.at {
            Some(at) => out_prints.insert(key, at.to_value()),
            None => out_prints.shift_remove(&key),
        };
    }
    for r in refs.iter_mut().filter(|r| !r.on.is_empty()) {
        r.on.sort_unstable();
        let g = geoms.iter().find(|(id, _)| *id == r.body).map(|(_, g)| g).expect("a ref on a face has its body");
        for f in &r.on {
            let key = face_key(r.body, *f as u64);
            out_materials.insert(key.clone(), r.material.clone());
            out_prints.insert(key, g.faces[*f].print.to_value());
        }
    }
    for key in foreign {
        out_materials.insert(key.clone(), materials[key].clone());
        if let Some(print) = prints.get(key) {
            out_prints.insert(key.clone(), print.clone());
        }
    }
    (out_materials, out_prints)
}
