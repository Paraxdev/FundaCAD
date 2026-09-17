//! Mesh file import, replaces the STL, 3MF, OBJ and GLB half of
//! `sidecar/mesh_import.py` (`_peek_triangle_count`, `_stl_distinct_normals`,
//! `_sew_mesh_file`, `_read_obj_triangles`, `_glb_dominant_color`,
//! `_read_glb`) with `shape_util._maybe_unify`, `_refacet_clean` and
//! `_explode_solids`. The file parsers stand in for lib3mf, which build123d's
//! `Mesher` reads through.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use indexmap::IndexMap;
use opencascade::mesh_access::MeshAccess;
use opencascade::mesh_import::{self as occ, FaceFacts, PlanarRebuild};
use opencascade::primitives::Shape;

use crate::export::pyfmt::thousands;
use crate::kernel::{self, Kind};
use crate::mesh::{self, MeshParams};

pub const MAX_IMPORT_TRIANGLES: u64 = 150_000;
pub const MAX_IMPORT_TOTAL_FACES: usize = 60_000;
pub const MAX_IMPORT_SCAN_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_IMPORT_FACET_DIRECTIONS: usize = 20_000;
pub const GLB_MM_AS_UNITS_ABOVE: f64 = 10_000.0;
const REFACET_TOL: f64 = 0.12;

type Triangles = (Vec<f64>, Vec<u32>);

fn count_stream(r: impl Read, needle: &[u8], limit: u64, max_bytes: Option<u64>) -> u64 {
    let mut r = r;
    let mut count = 0;
    let mut total = 0u64;
    let mut carry: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 1 << 20];
    loop {
        let n = match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        total += n as u64;
        let mut buf = std::mem::take(&mut carry);
        buf.extend_from_slice(&chunk[..n]);
        count += buf.windows(needle.len()).filter(|w| *w == needle).count() as u64;
        let keep = needle.len().saturating_sub(1).min(buf.len());
        carry = buf[buf.len() - keep..].to_vec();
        if count > limit || max_bytes.is_some_and(|m| total >= m) {
            return count;
        }
    }
    count
}

/// `_peek_triangle_count`: the file's own count, before any geometry is built.
pub fn peek_triangle_count(path: &Path, fmt: &str) -> Option<u64> {
    let cap = MAX_IMPORT_TRIANGLES;
    match fmt {
        "stl" => {
            let mut head = [0u8; 84];
            let mut f = std::fs::File::open(path).ok()?;
            let got = f.read(&mut head).ok()?;
            if got >= 5 && head[..5].eq_ignore_ascii_case(b"solid") {
                let f = std::fs::File::open(path).ok()?;
                return Some(count_stream(f, b"facet normal", cap, Some(MAX_IMPORT_SCAN_BYTES)));
            }
            (got == 84).then(|| u64::from(u32::from_le_bytes([head[80], head[81], head[82], head[83]])))
        }
        "3mf" => {
            let mut z = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
            let parts: Vec<String> =
                z.file_names().filter(|n| n.to_lowercase().ends_with(".model")).map(String::from).collect();
            if parts.is_empty() {
                return None;
            }
            let mut sizes = Vec::new();
            for n in &parts {
                sizes.push(z.by_name(n).ok()?.size());
            }
            if sizes.iter().sum::<u64>() > MAX_IMPORT_SCAN_BYTES {
                return Some(cap + 1);
            }
            let mut total = 0;
            let mut budget = MAX_IMPORT_SCAN_BYTES;
            for (n, size) in parts.iter().zip(sizes) {
                total += count_stream(z.by_name(n).ok()?, b"<triangle", cap, Some(budget));
                budget -= size;
            }
            Some(total)
        }
        "obj" => {
            let text = std::fs::read(path).ok()?;
            let mut n = 0;
            for line in text.split(|&b| b == b'\n') {
                if line.starts_with(b"f ") {
                    n += 1;
                    if n > cap {
                        return Some(n);
                    }
                }
            }
            Some(n)
        }
        _ => None,
    }
}

pub fn too_dense_error(ntri: u64) -> String {
    format!(
        "This mesh has ~{} triangles, too dense to import as an editable model (limit ~{}). \
         It's almost certainly an organic/scanned model; reduce it first, or import a STEP / clean CAD mesh.",
        thousands(ntri as usize),
        thousands(MAX_IMPORT_TRIANGLES as usize)
    )
}

fn distinct(normals: impl Iterator<Item = [f32; 3]>) -> Option<usize> {
    let mut seen = HashSet::new();
    let mut any = false;
    for n in normals {
        if !n.iter().all(|v| v.is_finite()) {
            continue;
        }
        any = true;
        let q = n.map(|v| {
            let r = (v * 1000.0).round_ties_even() / 1000.0;
            if r == 0.0 { 0u32 } else { r.to_bits() }
        });
        seen.insert(q);
    }
    any.then_some(seen.len())
}

/// `_stl_distinct_normals` on a binary STL's stored facet normals.
pub fn stl_distinct_normals(data: &[u8]) -> Option<usize> {
    if data.len() < 84 {
        return None;
    }
    let ntri = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    if ntri == 0 || data.len() != 84 + 50 * ntri {
        return None;
    }
    distinct(data[84..].chunks_exact(50).map(|r| {
        let f = |k: usize| f32::from_le_bytes([r[k], r[k + 1], r[k + 2], r[k + 3]]);
        [f(0), f(4), f(8)]
    }))
}

/// The float32 facet normals `write_stl` would store for these triangles.
fn written_normals<'a>(pos32: &'a [f32], idx: &'a [u32]) -> impl Iterator<Item = [f32; 3]> + 'a {
    idx.chunks_exact(3).map(move |t| {
        let p = |i: u32| [pos32[i as usize * 3], pos32[i as usize * 3 + 1], pos32[i as usize * 3 + 2]];
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let len = if len < 1e-12 { 1.0 } else { len };
        [n[0] / len, n[1] / len, n[2] / len]
    })
}

fn stl_triangles(data: &[u8]) -> Result<Triangles, String> {
    let binary = data.len() >= 84 && {
        let n = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
        data.len() == 84 + 50 * n
    };
    let mut pos = Vec::new();
    if binary || !data[..data.len().min(5)].eq_ignore_ascii_case(b"solid") {
        for r in data.get(84..).unwrap_or_default().chunks_exact(50) {
            for k in 0..3 {
                let at = 12 + k * 12;
                for c in 0..3 {
                    let o = at + c * 4;
                    pos.push(f64::from(f32::from_le_bytes([r[o], r[o + 1], r[o + 2], r[o + 3]])));
                }
            }
        }
    } else {
        for line in String::from_utf8_lossy(data).lines() {
            let mut words = line.split_whitespace();
            if words.next() == Some("vertex") {
                for w in words.take(3) {
                    pos.push(f64::from(w.parse::<f32>().map_err(|_| "the STL file has a malformed vertex")?));
                }
            }
        }
        pos.truncate(pos.len() / 9 * 9);
    }
    let idx = (0..(pos.len() / 3) as u32).collect();
    Ok((pos, idx))
}

/// Every mesh object of every model part, root part first.
fn threemf_meshes(path: &Path) -> Result<Vec<Triangles>, String> {
    use quick_xml::events::Event;
    let bad = |e: &dyn std::fmt::Display| format!("could not read the 3MF file: {e}");
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).map_err(|e| bad(&e))?).map_err(|e| bad(&e))?;
    let mut parts: Vec<String> =
        z.file_names().filter(|n| n.to_lowercase().ends_with(".model")).map(String::from).collect();
    parts.sort_by_key(|n| n != "3D/3dmodel.model");
    let mut out = Vec::new();
    for name in parts {
        let mut xml = String::new();
        z.by_name(&name).map_err(|e| bad(&e))?.read_to_string(&mut xml).map_err(|e| bad(&e))?;
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut current: Option<Triangles> = None;
        loop {
            match reader.read_event().map_err(|e| bad(&e))? {
                Event::Start(e) | Event::Empty(e) => {
                    let local = e.local_name();
                    let attr = |key: &[u8]| {
                        e.attributes()
                            .flatten()
                            .find(|a| a.key.local_name().as_ref() == key)
                            .and_then(|a| std::str::from_utf8(&a.value).ok().map(str::to_string))
                    };
                    match local.as_ref() {
                        b"mesh" => current = Some((Vec::new(), Vec::new())),
                        b"vertex" => {
                            if let Some((pos, _)) = current.as_mut() {
                                for k in [b"x", b"y", b"z"] {
                                    let v = attr(k).and_then(|s| s.trim().parse::<f64>().ok());
                                    pos.push(v.ok_or_else(|| bad(&"a vertex without coordinates"))?);
                                }
                            }
                        }
                        b"triangle" => {
                            if let Some((_, idx)) = current.as_mut() {
                                for k in [b"v1", b"v2", b"v3"] {
                                    let v = attr(k).and_then(|s| s.trim().parse::<u32>().ok());
                                    idx.push(v.ok_or_else(|| bad(&"a triangle without vertices"))?);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Event::End(e) if e.local_name().as_ref() == b"mesh" => {
                    if let Some(m) = current.take() {
                        out.push(m);
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }
    Ok(out)
}

/// `_read_obj_triangles`.
pub fn obj_triangles(text: &str) -> Result<Triangles, String> {
    let mut verts: Vec<[f64; 3]> = Vec::new();
    let mut tris: Vec<i64> = Vec::new();
    for line in text.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("v ") {
            let p: Vec<&str> = rest.split_whitespace().collect();
            if p.len() >= 3 {
                let f = |s: &str| s.parse::<f64>().map_err(|_| format!("could not convert string to float: '{s}'"));
                verts.push([f(p[0])?, f(p[1])?, f(p[2])?]);
            }
        } else if let Some(rest) = line.strip_prefix("f ") {
            let mut idx = Vec::new();
            for tok in rest.split_whitespace() {
                let s = tok.split('/').next().unwrap_or("");
                if s.is_empty() {
                    continue;
                }
                let i: i64 = s.parse().map_err(|_| format!("invalid literal for int() with base 10: '{s}'"))?;
                idx.push(if i > 0 { i - 1 } else { verts.len() as i64 + i });
            }
            for k in 1..idx.len().saturating_sub(1) {
                tris.extend([idx[0], idx[k], idx[k + 1]]);
            }
        }
    }
    if verts.is_empty() || tris.is_empty() {
        return Err("no triangles found in the OBJ file".into());
    }
    let n = verts.len() as i64;
    if tris.iter().any(|&i| i < 0 || i >= n) {
        return Err("the OBJ file references vertices that do not exist".into());
    }
    Ok((verts.into_iter().flatten().collect(), tris.into_iter().map(|i| i as u32).collect()))
}

/// `_glb_dominant_color`: the base colour of the material covering the most
/// triangles, `#RRGGBB` in sRGB.
pub fn glb_dominant_color(data: &[u8]) -> Option<String> {
    if data.len() < 20 || u32::from_le_bytes(data[0..4].try_into().ok()?) != 0x4654_6C67 {
        return None;
    }
    let jlen = u32::from_le_bytes(data[12..16].try_into().ok()?) as usize;
    let doc: serde_json::Value = serde_json::from_slice(data.get(20..20 + jlen)?).ok()?;
    let materials = doc.get("materials")?.as_array().filter(|m| !m.is_empty())?;
    let empty = Vec::new();
    let accessors = doc.get("accessors").and_then(|a| a.as_array()).unwrap_or(&empty);
    let mut weight: IndexMap<i64, i64> = IndexMap::new();
    for mesh in doc.get("meshes").and_then(|m| m.as_array()).into_iter().flatten() {
        for prim in mesh.get("primitives").and_then(|p| p.as_array()).into_iter().flatten() {
            let Some(mat) = prim.get("material").filter(|m| !m.is_null()) else { continue };
            let mat = mat.as_i64()?;
            let n = prim
                .get("indices")
                .and_then(|a| a.as_u64())
                .and_then(|a| accessors.get(a as usize))
                .and_then(|a| a.get("count"))
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            *weight.entry(mat).or_insert(0) += n;
        }
    }
    let mut best = 0i64;
    let mut top = i64::MIN;
    for (&m, &w) in &weight {
        if w > top {
            top = w;
            best = m;
        }
    }
    let factor = materials.get(usize::try_from(best).ok()?)?.get("pbrMetallicRoughness")?.get("baseColorFactor")?;
    let factor = factor.as_array().filter(|f| f.len() >= 3)?;
    let mut hex = String::from("#");
    for c in &factor[..3] {
        let c = c.as_f64()?.clamp(0.0, 1.0);
        let s = if c <= 0.003_130_8 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
        hex.push_str(&format!("{:02X}", (s * 255.0).round_ties_even().clamp(0.0, 255.0) as u8));
    }
    Some(hex)
}

fn occt(e: opencascade::Error) -> String {
    match e {
        opencascade::Error::Occt(m) => m,
        other => other.to_string(),
    }
}

fn facet_gate(directions: Option<usize>) -> Result<(), String> {
    match directions {
        Some(nn) if nn > MAX_IMPORT_FACET_DIRECTIONS => Err(format!(
            "This mesh is curved/organic ({} distinct facet directions, a clean CAD part has a few hundred at most), \
             so it cannot reduce to an editable model. FundaCAD edits prismatic CAD models; import a STEP or a flat-faced part.",
            thousands(nn)
        )),
        _ => Ok(()),
    }
}

/// `_sew_mesh_file` after the read: unify, clean the facets, and refuse past
/// the whole file face budget.
fn finish_mesh(shapes: Vec<Shape>) -> Result<Shape, String> {
    if shapes.is_empty() {
        return Err("no geometry found in the mesh file".into());
    }
    let shape = if shapes.len() == 1 {
        shapes.into_iter().next().unwrap_or_else(Shape::empty)
    } else {
        kernel::compound(shapes.iter())
    };
    let shape = occ::unify(&shape).map_err(occt)?;
    let shape = refacet_clean(&shape, REFACET_TOL).unwrap_or(shape);
    let bodies = occ::explode_solids(&shape).map_err(occt)?;
    let per_body: Vec<usize> = bodies.iter().map(|b| kernel::count(b, Kind::Face)).collect();
    let total: usize = per_body.iter().sum();
    if total > MAX_IMPORT_TOTAL_FACES {
        return Err(format!(
            "This mesh is too dense to import ({} faces across {} {}, the limit is {}). \
             Decimate or retopologise it first (fewer triangles), then import.",
            thousands(total),
            thousands(per_body.len()),
            if per_body.len() == 1 { "body" } else { "bodies" },
            thousands(MAX_IMPORT_TOTAL_FACES)
        ));
    }
    Ok(shape)
}

/// `_sew_triangles`: the soup as a binary STL would carry it, single precision.
pub fn sew_triangles(pos: &[f64], idx: &[u32]) -> Result<Shape, String> {
    let pos32: Vec<f32> = pos.iter().map(|&v| v as f32).collect();
    if idx.iter().any(|&i| i as usize * 3 + 2 >= pos32.len()) {
        return Err("a triangle references a vertex that does not exist".into());
    }
    facet_gate(distinct(written_normals(&pos32, idx)))?;
    let soup: Vec<f64> = idx
        .iter()
        .flat_map(|&i| {
            let i = i as usize * 3;
            [f64::from(pos32[i]), f64::from(pos32[i + 1]), f64::from(pos32[i + 2])]
        })
        .collect();
    let flat: Vec<u32> = (0..idx.len() as u32).collect();
    finish_mesh(vec![occ::sew_triangles(&soup, &flat).map_err(occt)?])
}

pub fn read_stl(path: &Path) -> Result<Shape, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    facet_gate(stl_distinct_normals(&data))?;
    let (pos, idx) = stl_triangles(&data)?;
    finish_mesh(vec![occ::sew_triangles(&pos, &idx).map_err(occt)?])
}

pub fn read_3mf(path: &Path) -> Result<Shape, String> {
    let mut shapes = Vec::new();
    for (pos, idx) in threemf_meshes(path)? {
        shapes.push(occ::sew_triangles(&pos, &idx).map_err(occt)?);
    }
    finish_mesh(shapes)
}

pub fn read_obj(path: &Path) -> Result<Shape, String> {
    let text = String::from_utf8_lossy(&std::fs::read(path).map_err(|e| e.to_string())?).into_owned();
    let (pos, idx) = obj_triangles(&text)?;
    let ntri = (idx.len() / 3) as u64;
    if ntri > MAX_IMPORT_TRIANGLES {
        return Err(too_dense_error(ntri));
    }
    sew_triangles(&pos, &idx)
}

/// `_read_glb` then the shared sew path.
pub fn read_glb(path: &Path) -> Result<Shape, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let (mut pos, mut idx) = super::gltf::read_glb(&data, 1000.0)?;
    if super::gltf::max_extent(&pos) > GLB_MM_AS_UNITS_ABOVE {
        (pos, idx) = super::gltf::read_glb(&data, 1.0)?;
    }
    let ntri = idx.len() / 3;
    if ntri as u64 > MAX_IMPORT_TRIANGLES {
        return Err(format!(
            "This glTF has ~{} triangles, too dense to import as an editable model (limit ~{}). \
             Reduce it first, or import a STEP / clean CAD mesh.",
            thousands(ntri),
            thousands(MAX_IMPORT_TRIANGLES as usize)
        ));
    }
    sew_triangles(&pos, &idx)
}

/// Least squares `M y = r` for a small symmetric positive semidefinite `M`,
/// singular directions below `rcond` of the largest dropped, as
/// `numpy.linalg.lstsq` does.
fn lstsq_symmetric(m: &[Vec<f64>], r: &[f64], rcond: f64) -> Vec<f64> {
    let k = r.len();
    let mut a: Vec<Vec<f64>> = m.to_vec();
    let mut v: Vec<Vec<f64>> = (0..k).map(|i| (0..k).map(|j| f64::from(u8::from(i == j))).collect()).collect();
    for _ in 0..64 {
        let mut off = 0.0;
        for p in 0..k {
            for q in p + 1..k {
                off += a[p][q] * a[p][q];
            }
        }
        if off < 1e-30 {
            break;
        }
        for p in 0..k {
            for q in p + 1..k {
                if a[p][q].abs() < 1e-300 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for i in 0..k {
                    let (aip, aiq) = (a[i][p], a[i][q]);
                    a[i][p] = c * aip - s * aiq;
                    a[i][q] = s * aip + c * aiq;
                }
                for i in 0..k {
                    let (api, aqi) = (a[p][i], a[q][i]);
                    a[p][i] = c * api - s * aqi;
                    a[q][i] = s * api + c * aqi;
                }
                for row in v.iter_mut() {
                    let (vp, vq) = (row[p], row[q]);
                    row[p] = c * vp - s * vq;
                    row[q] = s * vp + c * vq;
                }
            }
        }
    }
    let eig: Vec<f64> = (0..k).map(|i| a[i][i]).collect();
    let top = eig.iter().fold(0.0f64, |acc, e| acc.max(e.abs()));
    let mut y = vec![0.0; k];
    for (j, &lambda) in eig.iter().enumerate() {
        if lambda.abs() <= rcond * top || lambda.abs() == 0.0 {
            continue;
        }
        let proj: f64 = (0..k).map(|i| v[i][j] * r[i]).sum::<f64>() / lambda;
        for i in 0..k {
            y[i] += proj * v[i][j];
        }
    }
    y
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `_refacet_clean`: planar faces region grown by distance to an anchor
/// plane, the mesh welded and snapped onto the region planes, each region
/// rebuilt as one face and sewn. None keeps the input.
pub fn refacet_clean(shape: &Shape, tol: f64) -> Option<Shape> {
    let facts = FaceFacts::new(shape).ok()?;
    if facts.count() == 0 || !facts.all_planar().ok()? {
        return None;
    }
    let parts = occ::explode_solids(shape).ok()?;
    if parts.len() > 1 {
        let cleaned: Vec<Option<Shape>> = parts.iter().map(|p| refacet_clean(p, tol)).collect();
        if cleaned.iter().all(Option::is_none) {
            return None;
        }
        let shapes: Vec<&Shape> = cleaned.iter().zip(&parts).map(|(c, p)| c.as_ref().unwrap_or(p)).collect();
        return Some(kernel::compound(shapes));
    }
    rebuild_planar(shape, &facts, tol).ok().flatten()
}

fn rebuild_planar(shape: &Shape, facts: &FaceFacts, tol: f64) -> Result<Option<Shape>, opencascade::Error> {
    let n = facts.count();
    let mut planes_of = Vec::with_capacity(n);
    let mut fverts = Vec::with_capacity(n);
    for i in 0..n {
        planes_of.push(facts.plane(i)?);
        fverts.push(facts.vertices(i)?);
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| planes_of[b].area.partial_cmp(&planes_of[a].area).unwrap_or(std::cmp::Ordering::Equal));
    let mut region: HashMap<usize, usize> = HashMap::new();
    let mut planes: Vec<([f64; 3], [f64; 3])> = Vec::new();
    for i in order {
        if region.contains_key(&i) {
            continue;
        }
        let (p0, nn) = (planes_of[i].centre, planes_of[i].normal);
        let rid = planes.len();
        planes.push((p0, nn));
        region.insert(i, rid);
        let mut queue = vec![i];
        while let Some(k) = queue.pop() {
            for j in facts.neighbors(k)? {
                if region.contains_key(&j) {
                    continue;
                }
                let d = fverts[j].iter().map(|v| dot(sub(*v, p0), nn).abs()).fold(f64::NEG_INFINITY, f64::max);
                if !fverts[j].is_empty() && d <= tol {
                    region.insert(j, rid);
                    queue.push(j);
                }
            }
        }
    }
    if planes.len() >= n {
        return Ok(None);
    }

    let access = MeshAccess::new(shape);
    let t = mesh::tessellate(
        shape,
        &access,
        MeshParams { linear: 0.5, angular: 0.5, relative: false, display: false, force_remesh: false },
    );
    let mut weld: HashMap<[i64; 3], usize> = HashMap::new();
    let mut wpos: Vec<[f64; 3]> = Vec::new();
    let widx: Vec<usize> = t
        .positions
        .chunks_exact(3)
        .map(|p| {
            let key = [0, 1, 2].map(|c| (p[c] / 1e-4).round_ties_even() as i64);
            *weld.entry(key).or_insert_with(|| {
                wpos.push([p[0], p[1], p[2]]);
                wpos.len() - 1
            })
        })
        .collect();
    let tris: Vec<[usize; 3]> =
        t.indices.chunks_exact(3).map(|c| [widx[c[0] as usize], widx[c[1] as usize], widx[c[2] as usize]]).collect();
    let mut vregions: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); wpos.len()];
    for (tri, &fid) in tris.iter().zip(&t.face_ids) {
        if let Some(&rid) = region.get(&(fid as usize)) {
            for &a in tri {
                vregions[a].insert(rid);
            }
        }
    }
    let mut snapped = wpos.clone();
    for (vi, rs) in vregions.iter().enumerate() {
        if rs.is_empty() {
            continue;
        }
        let a: Vec<[f64; 3]> = rs.iter().map(|&r| planes[r].1).collect();
        let v = wpos[vi];
        let rhs: Vec<f64> = rs.iter().zip(&a).map(|(&r, n)| dot(*n, planes[r].0) - dot(*n, v)).collect();
        let m: Vec<Vec<f64>> = a.iter().map(|x| a.iter().map(|y| dot(*x, *y)).collect()).collect();
        let y = lstsq_symmetric(&m, &rhs, 1e-3);
        let mut x = v;
        for (n, yk) in a.iter().zip(&y) {
            for c in 0..3 {
                x[c] += n[c] * yk;
            }
        }
        let moved = sub(x, v);
        if dot(moved, moved).sqrt() <= 3.0 * tol {
            snapped[vi] = x;
        }
    }

    let mut region_tris: IndexMap<usize, Vec<[usize; 3]>> = IndexMap::new();
    for (tri, &fid) in tris.iter().zip(&t.face_ids) {
        if let Some(&rid) = region.get(&(fid as usize)) {
            region_tris.entry(rid).or_default().push(*tri);
        }
    }
    let mut rebuild = PlanarRebuild::default();
    for (rid, rtris) in &region_tris {
        let (p0, nn) = planes[*rid];
        let mut ec: HashMap<(usize, usize), usize> = HashMap::new();
        for &[a, b, c] in rtris {
            for (u, w) in [(a, b), (b, c), (c, a)] {
                *ec.entry((u.min(w), u.max(w))).or_insert(0) += 1;
            }
        }
        let mut nxt: IndexMap<usize, Vec<usize>> = IndexMap::new();
        for &[a, b, c] in rtris {
            for (u, w) in [(a, b), (b, c), (c, a)] {
                if ec[&(u.min(w), u.max(w))] == 1 {
                    nxt.entry(u).or_default().push(w);
                }
            }
        }
        let mut loops: Vec<Vec<usize>> = Vec::new();
        while let Some(start) = nxt.iter().find(|(_, v)| !v.is_empty()).map(|(k, _)| *k) {
            let mut v = nxt.get_mut(&start).and_then(Vec::pop).unwrap_or(start);
            let mut lp = Some(vec![start]);
            let mut guard = nxt.values().map(Vec::len).sum::<usize>() as i64 + 2;
            while v != start && guard > 0 {
                if let Some(l) = lp.as_mut() {
                    l.push(v);
                }
                match nxt.get_mut(&v).and_then(Vec::pop) {
                    Some(next) => v = next,
                    None => {
                        lp = None;
                        break;
                    }
                }
                guard -= 1;
            }
            if let Some(l) = lp.filter(|l| l.len() >= 3) {
                loops.push(l);
            }
        }
        if loops.is_empty() {
            return Ok(None);
        }
        let mut flats: Vec<(Vec<[f64; 3]>, f64)> = Vec::new();
        for lp in &loops {
            let pts: Vec<[f64; 3]> = lp
                .iter()
                .map(|&i| {
                    let s = snapped[i];
                    let d = dot(sub(s, p0), nn);
                    [s[0] - d * nn[0], s[1] - d * nn[1], s[2] - d * nn[2]]
                })
                .collect();
            let m = pts.len();
            let kept: Vec<[f64; 3]> = (0..m)
                .filter(|&k| {
                    let prev = pts[(k + m - 1) % m];
                    let d = sub(pts[k], prev);
                    dot(d, d).sqrt() >= 1e-6
                })
                .map(|k| pts[k])
                .collect();
            if kept.len() < 3 {
                continue;
            }
            let mut s = [0.0; 3];
            for k in 0..kept.len() {
                let (p, q) = (kept[k], kept[(k + 1) % kept.len()]);
                s[0] += p[1] * q[2] - p[2] * q[1];
                s[1] += p[2] * q[0] - p[0] * q[2];
                s[2] += p[0] * q[1] - p[1] * q[0];
            }
            let area = dot(s, nn).abs() / 2.0;
            flats.push((kept, area));
        }
        flats.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let loops: Vec<Vec<[f64; 3]>> = flats.into_iter().map(|(l, _)| l).collect();
        if !rebuild.add_region(p0, nn, &loops)? {
            return Ok(None);
        }
    }
    let Some(cleaned) = rebuild.finish(1.5 * tol)? else {
        return Ok(None);
    };
    let cleaned = occ::unify(&cleaned)?;
    let before = kernel::volume(shape);
    let ok = kernel::count(&cleaned, Kind::Face) < n
        && occ::explode_solids(&cleaned)?.len() == occ::explode_solids(shape)?.len()
        && cleaned.is_valid()?
        && (kernel::volume(&cleaned) - before).abs() <= f64::max(1.0, 0.01 * before.abs());
    Ok(ok.then_some(cleaned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obj_faces_fan_and_count_back() {
        let (pos, idx) = obj_triangles("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1 2/2 3/3 -1\n").unwrap();
        assert_eq!(pos.len(), 12);
        assert_eq!(idx, [0, 1, 2, 0, 2, 3]);
        assert_eq!(obj_triangles("v 0 0 0\nf 1 2 3\n").unwrap_err(), "the OBJ file references vertices that do not exist");
        assert_eq!(obj_triangles("# nothing\n").unwrap_err(), "no triangles found in the OBJ file");
    }

    #[test]
    fn lstsq_drops_the_singular_direction() {
        let m = vec![vec![1.0, 1.0], vec![1.0, 1.0]];
        let y = lstsq_symmetric(&m, &[2.0, 2.0], 1e-3);
        assert!((y[0] - 1.0).abs() < 1e-9 && (y[1] - 1.0).abs() < 1e-9, "{y:?}");
    }
}
