//! Binary glTF 2.0, one node, mesh and material per body, replaces
//! `write_glb`, `_vertex_normals`, `_base_color_factor` and `norm_color` of
//! `sidecar/mesh_writers.py`.

use std::io::{self, Write};
use std::path::Path;

use super::pyfmt::{round6, Json};

pub struct GlbMesh<'a> {
    pub name: Option<String>,
    pub positions: &'a [f64],
    pub indices: &'a [u32],
    pub color: Option<String>,
}

/// `'#RRGGBB'` upper case, from `#rrggbb`, `rrggbb` or `rrggbbaa`, else grey.
pub fn norm_color(c: &str) -> String {
    let s = c.trim().trim_start_matches('#');
    let s = if s.chars().count() == 8 {
        &s[..s.char_indices().nth(6).map_or(s.len(), |(i, _)| i)]
    } else {
        s
    };
    if s.len() != 6 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return "#808080".into();
    }
    format!("#{}", s.to_ascii_uppercase())
}

fn srgb_to_linear(v: u8) -> f64 {
    let c = f64::from(v) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn base_color_factor(hex: Option<&str>) -> [f64; 4] {
    let s = hex.unwrap_or("").trim().trim_start_matches('#');
    let s = if s.chars().count() == 6 { s } else { "808080" };
    let rgb = (|| {
        let b = |i: usize| s.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok());
        Some([b(0)?, b(2)?, b(4)?])
    })()
    .unwrap_or([128, 128, 128]);
    [
        round6(srgb_to_linear(rgb[0])),
        round6(srgb_to_linear(rgb[1])),
        round6(srgb_to_linear(rgb[2])),
        1.0,
    ]
}

/// Area weighted, summed corner by corner in triangle order as numpy's
/// `bincount` accumulation does, so the float32 result is the same bits.
fn vertex_normals(pos: &[f64], idx: &[u32]) -> Vec<f32> {
    let n = pos.len() / 3;
    let p = |i: u32| {
        let i = i as usize * 3;
        [pos[i], pos[i + 1], pos[i + 2]]
    };
    let fnorm: Vec<[f64; 3]> = idx
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ]
        })
        .collect();
    let mut nrm = vec![[0.0f64; 3]; n];
    for corner in 0..3 {
        let mut sums = vec![[0.0f64; 3]; n];
        for (t, f) in idx.chunks_exact(3).zip(&fnorm) {
            let s = &mut sums[t[corner] as usize];
            s[0] += f[0];
            s[1] += f[1];
            s[2] += f[2];
        }
        for (acc, s) in nrm.iter_mut().zip(&sums) {
            acc[0] += s[0];
            acc[1] += s[1];
            acc[2] += s[2];
        }
    }
    let mut out = Vec::with_capacity(n * 3);
    for v in nrm {
        let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        let len = if len < 1e-12 { 1.0 } else { len };
        out.extend([(v[0] / len) as f32, (v[1] / len) as f32, (v[2] / len) as f32]);
    }
    out
}

const MM: f64 = 0.001;
const MAGIC: u32 = 0x4654_6C67;
const CHUNK_JSON: u32 = 0x4E4F_534A;
const CHUNK_BIN: u32 = 0x004E_4942;

pub fn write(meshes: &[GlbMesh<'_>], mut out: impl Write) -> io::Result<()> {
    let mut nodes = Vec::new();
    let mut gl_meshes = Vec::new();
    let mut materials = Vec::new();
    let mut accessors = Vec::new();
    let mut views = Vec::new();
    let mut bin: Vec<u8> = Vec::new();

    let mut view = |raw: Vec<u8>, target: i64, views: &mut Vec<Json>| {
        let pad = (4 - raw.len() % 4) % 4;
        views.push(Json::Obj(vec![
            ("buffer", Json::Int(0)),
            ("byteOffset", Json::Int(bin.len() as i64)),
            ("byteLength", Json::Int(raw.len() as i64)),
            ("target", Json::Int(target)),
        ]));
        bin.extend_from_slice(&raw);
        bin.extend(std::iter::repeat(0u8).take(pad));
        (views.len() - 1) as i64
    };

    for m in meshes {
        let nvert = m.positions.len() / 3;
        let ntri = m.indices.len() / 3;
        if nvert == 0 || ntri == 0 {
            continue;
        }
        let pos = &m.positions[..nvert * 3];
        let idx = &m.indices[..ntri * 3];
        let nrm = vertex_normals(pos, idx);

        let p_view = view(
            pos.iter().flat_map(|&v| (v as f32).to_le_bytes()).collect(),
            34962,
            &mut views,
        );
        let n_view = view(
            nrm.iter().flat_map(|v| v.to_le_bytes()).collect(),
            34962,
            &mut views,
        );
        let i_view = view(
            idx.iter().flat_map(|v| v.to_le_bytes()).collect(),
            34963,
            &mut views,
        );

        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in pos.chunks_exact(3) {
            for k in 0..3 {
                // numpy's min and max propagate NaN, fmin would drop it
                lo[k] = if p[k].is_nan() || p[k] < lo[k] { p[k] } else { lo[k] };
                hi[k] = if p[k].is_nan() || p[k] > hi[k] { p[k] } else { hi[k] };
            }
        }
        let floats = |v: [f64; 3]| Json::Arr(v.iter().map(|&x| Json::Float(x)).collect());
        accessors.push(Json::Obj(vec![
            ("bufferView", Json::Int(p_view)),
            ("componentType", Json::Int(5126)),
            ("count", Json::Int(nvert as i64)),
            ("type", Json::Str("VEC3".into())),
            ("min", floats(lo)),
            ("max", floats(hi)),
        ]));
        accessors.push(Json::Obj(vec![
            ("bufferView", Json::Int(n_view)),
            ("componentType", Json::Int(5126)),
            ("count", Json::Int(nvert as i64)),
            ("type", Json::Str("VEC3".into())),
        ]));
        accessors.push(Json::Obj(vec![
            ("bufferView", Json::Int(i_view)),
            ("componentType", Json::Int(5125)),
            ("count", Json::Int((ntri * 3) as i64)),
            ("type", Json::Str("SCALAR".into())),
        ]));
        let a = accessors.len() as i64 - 3;

        let name = match m.name.as_deref() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => format!("Body{}", gl_meshes.len() + 1),
        };
        let factor = base_color_factor(m.color.as_deref());
        materials.push(Json::Obj(vec![
            ("name", Json::Str(format!("{name} colour"))),
            (
                "pbrMetallicRoughness",
                Json::Obj(vec![
                    (
                        "baseColorFactor",
                        Json::Arr(factor.iter().map(|&x| Json::Float(x)).collect()),
                    ),
                    ("metallicFactor", Json::Float(0.0)),
                    ("roughnessFactor", Json::Float(0.7)),
                ]),
            ),
            ("doubleSided", Json::Bool(false)),
        ]));
        gl_meshes.push(Json::Obj(vec![
            ("name", Json::Str(name.clone())),
            (
                "primitives",
                Json::Arr(vec![Json::Obj(vec![
                    (
                        "attributes",
                        Json::Obj(vec![("POSITION", Json::Int(a)), ("NORMAL", Json::Int(a + 1))]),
                    ),
                    ("indices", Json::Int(a + 2)),
                    ("material", Json::Int(materials.len() as i64 - 1)),
                ])]),
            ),
        ]));
        nodes.push(Json::Obj(vec![
            ("name", Json::Str(name)),
            ("mesh", Json::Int(gl_meshes.len() as i64 - 1)),
        ]));
    }

    let children = Json::Arr((1..=nodes.len() as i64).map(Json::Int).collect());
    let matrix = [MM, 0.0, 0.0, 0.0, 0.0, 0.0, -MM, 0.0, 0.0, MM, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    nodes.insert(
        0,
        Json::Obj(vec![
            ("name", Json::Str("FundaCAD".into())),
            ("matrix", Json::Arr(matrix.iter().map(|&x| Json::Float(x)).collect())),
            ("children", children),
        ]),
    );
    let any = !gl_meshes.is_empty();
    let mut doc = vec![
        (
            "asset",
            Json::Obj(vec![
                ("version", Json::Str("2.0".into())),
                ("generator", Json::Str("FundaCAD".into())),
            ]),
        ),
        ("scene", Json::Int(0)),
        ("scenes", Json::Arr(vec![Json::Obj(vec![("nodes", Json::Arr(vec![Json::Int(0)]))])])),
        ("nodes", Json::Arr(nodes)),
    ];
    if any {
        let total = bin.len() as i64;
        doc.push(("meshes", Json::Arr(gl_meshes)));
        doc.push(("materials", Json::Arr(materials)));
        doc.push(("accessors", Json::Arr(accessors)));
        doc.push(("bufferViews", Json::Arr(views)));
        doc.push(("buffers", Json::Arr(vec![Json::Obj(vec![("byteLength", Json::Int(total))])])));
    }
    let mut text = String::new();
    Json::Obj(doc).write(&mut text);
    let mut raw_json = text.into_bytes();
    raw_json.extend(std::iter::repeat(b' ').take((4 - raw_json.len() % 4) % 4));

    let total = 12 + 8 + raw_json.len() + if bin.is_empty() { 0 } else { 8 + bin.len() };
    out.write_all(&MAGIC.to_le_bytes())?;
    out.write_all(&2u32.to_le_bytes())?;
    out.write_all(&(total as u32).to_le_bytes())?;
    out.write_all(&(raw_json.len() as u32).to_le_bytes())?;
    out.write_all(&CHUNK_JSON.to_le_bytes())?;
    out.write_all(&raw_json)?;
    if !bin.is_empty() {
        out.write_all(&(bin.len() as u32).to_le_bytes())?;
        out.write_all(&CHUNK_BIN.to_le_bytes())?;
        out.write_all(&bin)?;
    }
    out.flush()
}

pub fn write_file(meshes: &[GlbMesh<'_>], path: &Path) -> io::Result<()> {
    write(meshes, io::BufWriter::new(std::fs::File::create(path)?))
}
