//! DXF, ASCII and binary R13 and later. Lines and curves in model space become
//! sketch entities, one sketch per layer on the XY plane; 3DFACE, polyface and
//! polygon mesh POLYLINEs and MESH become one triangle object per layer.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::f64::consts::TAU;

use indexmap::IndexMap;
use serde_json::{json, Value};

use super::mesh::{MeshObject, MAX_IMPORT_TRIANGLES};

pub const MAX_SKETCH_ENTITIES: usize = 20_000;
const BINARY_SENTINEL: &[u8] = b"AutoCAD Binary DXF\r\n\x1a\0";
const MAX_INSERT_DEPTH: usize = 16;

pub struct DxfRead {
    pub sketches: Vec<(String, Vec<Value>)>,
    pub objects: Vec<MeshObject>,
    pub notes: Vec<String>,
    pub unit: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
enum V {
    S(String),
    F(f64),
    I(i64),
}

impl V {
    fn f(&self) -> f64 {
        match self {
            V::F(x) => *x,
            #[allow(clippy::cast_precision_loss)]
            V::I(i) => *i as f64,
            V::S(s) => s.trim().parse().unwrap_or(0.0),
        }
    }
    fn i(&self) -> i64 {
        match self {
            V::I(i) => *i,
            #[allow(clippy::cast_possible_truncation)]
            V::F(x) => *x as i64,
            #[allow(clippy::cast_possible_truncation)]
            V::S(s) => s.trim().parse::<i64>().unwrap_or_else(|_| s.trim().parse::<f64>().map_or(0, |x| x as i64)),
        }
    }
    fn s(&self) -> String {
        match self {
            V::S(s) => s.trim().to_string(),
            V::F(x) => x.to_string(),
            V::I(i) => i.to_string(),
        }
    }
}

type Pair = (i32, V);

fn ascii_pairs(data: &[u8]) -> Result<Vec<Pair>, String> {
    let text = String::from_utf8_lossy(data);
    let mut lines = text.split('\n');
    let mut out = Vec::new();
    while let Some(code) = lines.next() {
        let code = code.trim();
        if code.is_empty() {
            continue;
        }
        let code: i32 =
            code.parse().map_err(|_| format!("this is not a readable DXF file (a group code reads \"{code}\")"))?;
        let value = lines.next().unwrap_or("").trim_end_matches('\r');
        out.push((code, V::S(value.to_string())));
        if code == 0 && value.trim() == "EOF" {
            break;
        }
    }
    Ok(out)
}

enum Kind {
    Str,
    Chunk,
    F64,
    I16,
    I32,
    I64,
    Bool,
}

fn binary_kind(code: i32) -> Kind {
    match code {
        310..=319 | 1004 => Kind::Chunk,
        10..=59 | 110..=149 | 210..=239 | 460..=469 | 1010..=1059 => Kind::F64,
        60..=79 | 170..=179 | 270..=289 | 370..=389 | 400..=409 | 1060..=1070 => Kind::I16,
        90..=99 | 420..=429 | 440..=459 | 1071 => Kind::I32,
        160..=169 => Kind::I64,
        290..=299 => Kind::Bool,
        _ => Kind::Str,
    }
}

fn binary_pairs(data: &[u8]) -> Result<Vec<Pair>, String> {
    let body = &data[BINARY_SENTINEL.len()..];
    if body.len() >= 2 && body[1] != 0 {
        return Err(
            "this binary DXF is older than R13, save it from the source app as ASCII DXF or a newer binary DXF".into(),
        );
    }
    let damaged = || "this binary DXF is damaged, it ends inside an entity".to_string();
    let mut at = 0usize;
    let take = |at: &mut usize, n: usize| -> Result<&[u8], String> {
        let s = body.get(*at..*at + n).ok_or_else(damaged)?;
        *at += n;
        Ok(s)
    };
    let mut out = Vec::new();
    while at < body.len() {
        let code = i32::from(u16::from_le_bytes(take(&mut at, 2)?.try_into().unwrap_or([0, 0])));
        let v = match binary_kind(code) {
            Kind::Str => {
                let end = body[at..].iter().position(|&b| b == 0).ok_or_else(damaged)?;
                let s = String::from_utf8_lossy(&body[at..at + end]).into_owned();
                at += end + 1;
                V::S(s)
            }
            Kind::Chunk => {
                let n = take(&mut at, 1)?[0] as usize;
                take(&mut at, n)?;
                V::S(String::new())
            }
            Kind::F64 => V::F(f64::from_le_bytes(take(&mut at, 8)?.try_into().unwrap_or([0; 8]))),
            Kind::I16 => V::I(i64::from(i16::from_le_bytes(take(&mut at, 2)?.try_into().unwrap_or([0; 2])))),
            Kind::I32 => V::I(i64::from(i32::from_le_bytes(take(&mut at, 4)?.try_into().unwrap_or([0; 4])))),
            Kind::I64 => V::I(i64::from_le_bytes(take(&mut at, 8)?.try_into().unwrap_or([0; 8]))),
            Kind::Bool => V::I(i64::from(take(&mut at, 1)?[0])),
        };
        let eof = code == 0 && v == V::S("EOF".into());
        out.push((code, v));
        if eof {
            break;
        }
    }
    Ok(out)
}

#[derive(Debug, Default)]
struct Ent {
    kind: String,
    pairs: Vec<Pair>,
    subs: Vec<Ent>,
}

impl Ent {
    fn get(&self, code: i32) -> Option<&V> {
        self.pairs.iter().find(|(c, _)| *c == code).map(|(_, v)| v)
    }
    fn f(&self, code: i32, or: f64) -> f64 {
        self.get(code).map_or(or, V::f)
    }
    fn i(&self, code: i32, or: i64) -> i64 {
        self.get(code).map_or(or, V::i)
    }
    fn s(&self, code: i32) -> String {
        self.get(code).map(V::s).unwrap_or_default()
    }
    fn p(&self, code: i32) -> [f64; 3] {
        [self.f(code, 0.0), self.f(code + 10, 0.0), self.f(code + 20, 0.0)]
    }
    fn all_f(&self, code: i32) -> Vec<f64> {
        self.pairs.iter().filter(|(c, _)| *c == code).map(|(_, v)| v.f()).collect()
    }
    /// Points written as runs of `code`, `code + 10`, `code + 20`.
    fn points(&self, code: i32) -> Vec<[f64; 3]> {
        let mut out: Vec<[f64; 3]> = Vec::new();
        for (c, v) in &self.pairs {
            if *c == code {
                out.push([v.f(), 0.0, 0.0]);
            } else if let Some(p) = out.last_mut() {
                if *c == code + 10 {
                    p[1] = v.f();
                } else if *c == code + 20 {
                    p[2] = v.f();
                }
            }
        }
        out
    }
    fn normal(&self) -> [f64; 3] {
        [self.f(210, 0.0), self.f(220, 0.0), self.f(230, 1.0)]
    }
    fn layer(&self) -> String {
        let l = self.s(8);
        if l.is_empty() {
            "0".into()
        } else {
            l
        }
    }
}

struct Block {
    base: [f64; 3],
    xref: bool,
    ents: Vec<Ent>,
}

struct Drawing {
    insunits: Option<i64>,
    blocks: HashMap<String, Block>,
    entities: Vec<Ent>,
}

/// Groups pairs into entities, folds VERTEX and ATTRIB into the POLYLINE or
/// INSERT before them, and splits the sections.
fn drawing(pairs: Vec<Pair>) -> Result<Drawing, String> {
    let mut items: Vec<Ent> = Vec::new();
    for (code, v) in pairs {
        if code == 0 {
            items.push(Ent { kind: v.s(), ..Ent::default() });
        } else if let Some(e) = items.last_mut() {
            e.pairs.push((code, v));
        }
    }
    if !items.iter().any(|e| e.kind == "SECTION") {
        return Err("this is not a DXF file, it has no SECTION".into());
    }
    let mut d = Drawing { insunits: None, blocks: HashMap::new(), entities: Vec::new() };
    let mut section = String::new();
    let mut block: Option<(String, Block)> = None;
    for e in items {
        match e.kind.as_str() {
            "SECTION" => {
                section = e.s(2).to_uppercase();
                if section == "HEADER" {
                    let at = e.pairs.iter().position(|(c, v)| *c == 9 && v.s() == "$INSUNITS");
                    d.insunits = at.and_then(|i| e.pairs.get(i + 1)).filter(|(c, _)| *c == 70).map(|(_, v)| v.i());
                }
                continue;
            }
            "ENDSEC" => {
                section.clear();
                continue;
            }
            _ => {}
        }
        let list = match section.as_str() {
            "ENTITIES" => &mut d.entities,
            "BLOCKS" => match e.kind.as_str() {
                "BLOCK" => {
                    let name = e.s(2).to_uppercase();
                    block = Some((name, Block { base: e.p(10), xref: e.i(70, 0) & 4 != 0, ents: Vec::new() }));
                    continue;
                }
                "ENDBLK" => {
                    if let Some((name, b)) = block.take() {
                        d.blocks.insert(name, b);
                    }
                    continue;
                }
                _ => match block.as_mut() {
                    Some((_, b)) => &mut b.ents,
                    None => continue,
                },
            },
            _ => continue,
        };
        match e.kind.as_str() {
            "VERTEX" | "ATTRIB" => {
                if let Some(owner) = list.last_mut().filter(|o| o.kind == "POLYLINE" || o.kind == "INSERT") {
                    owner.subs.push(e);
                }
            }
            "SEQEND" => {}
            _ => list.push(e),
        }
    }
    Ok(d)
}

/// Millimetres per drawing unit and the unit's short name.
fn unit_scale(insunits: Option<i64>) -> Result<(f64, &'static str, bool), String> {
    Ok(match insunits.unwrap_or(0) {
        0 | 4 => (1.0, "mm", insunits.unwrap_or(0) == 0),
        1 => (25.4, "in", false),
        2 => (304.8, "ft", false),
        3 => (1_609_344.0, "mi", false),
        5 => (10.0, "cm", false),
        6 => (1000.0, "m", false),
        7 => (1e6, "km", false),
        8 => (2.54e-5, "microinch", false),
        9 => (0.0254, "mil", false),
        10 => (914.4, "yd", false),
        11 => (1e-7, "angstrom", false),
        12 => (1e-6, "nm", false),
        13 => (1e-3, "um", false),
        14 => (100.0, "dm", false),
        15 => (1e4, "dam", false),
        16 => (1e5, "hm", false),
        21 => (1_200_000.0 / 3937.0, "us-ft", false),
        22 => (100_000.0 / 3937.0, "us-in", false),
        23 => (3_600_000.0 / 3937.0, "us-yd", false),
        24 => (6_336_000_000.0 / 3937.0, "us-mi", false),
        17..=20 => return Err("this DXF is drawn in astronomical units, too large for a part. Rescale it to millimetres in the source app".into()),
        other => return Err(format!("this DXF uses unit code {other} ($INSUNITS), which is not a length FundaCAD reads. Save it in millimetres or inches")),
    })
}

type Mat = [[f64; 4]; 3];

fn mul(a: &Mat, b: &Mat) -> Mat {
    let mut m = [[0.0; 4]; 3];
    for (r, row) in m.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[r][k] * b[k][c]).sum::<f64>() + if c == 3 { a[r][3] } else { 0.0 };
        }
    }
    m
}

fn apply(m: &Mat, p: [f64; 3]) -> [f64; 3] {
    let d = dir(m, p);
    [d[0] + m[0][3], d[1] + m[1][3], d[2] + m[2][3]]
}

fn dir(m: &Mat, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|r| m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2])
}

fn translate(t: [f64; 3]) -> Mat {
    [[1.0, 0.0, 0.0, t[0]], [0.0, 1.0, 0.0, t[1]], [0.0, 0.0, 1.0, t[2]]]
}

fn scale(s: [f64; 3]) -> Mat {
    [[s[0], 0.0, 0.0, 0.0], [0.0, s[1], 0.0, 0.0], [0.0, 0.0, s[2], 0.0]]
}

fn rot_z(rad: f64) -> Mat {
    let (s, c) = rad.sin_cos();
    [[c, -s, 0.0, 0.0], [s, c, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn norm(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a);
    if n > 0.0 {
        a.map(|x| x / n)
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// The object coordinate system of an extrusion direction, the DXF arbitrary
/// axis algorithm.
fn ocs(n: [f64; 3]) -> Mat {
    let n = unit(n);
    let ax = unit(if n[0].abs() < 1.0 / 64.0 && n[1].abs() < 1.0 / 64.0 {
        cross([0.0, 1.0, 0.0], n)
    } else {
        cross([0.0, 0.0, 1.0], n)
    });
    let ay = unit(cross(n, ax));
    [[ax[0], ay[0], n[0], 0.0], [ax[1], ay[1], n[1], 0.0], [ax[2], ay[2], n[2], 0.0]]
}

type P2 = [f64; 2];

#[derive(Clone, Debug)]
enum E {
    Line(P2, P2),
    Arc(P2, P2, P2),
    Circle(P2, f64),
    Bsp { poles: Vec<P2>, degree: usize, knots: Vec<f64>, closed: bool },
    Fit(Vec<P2>),
    Point(P2),
}

#[derive(Default)]
struct Out {
    layers: IndexMap<String, Vec<E>>,
    meshes: IndexMap<String, (Vec<f64>, Vec<u32>)>,
    skipped: BTreeMap<String, usize>,
    acis: BTreeMap<String, usize>,
    ellipses: usize,
    rational: usize,
    tilted: usize,
    flattened: usize,
    xrefs: usize,
    loops: usize,
    count: usize,
    tris: usize,
}

const FLAT: f64 = 1e-9;

fn xy(p: [f64; 3]) -> P2 {
    [p[0], p[1]]
}

impl Out {
    fn full(&self) -> bool {
        self.count > MAX_SKETCH_ENTITIES || self.tris as u64 > MAX_IMPORT_TRIANGLES
    }

    fn push(&mut self, layer: &str, e: E) {
        self.count += 1;
        self.layers.entry(layer.to_string()).or_default().push(e);
    }

    fn flat_ends(&mut self, pts: &[[f64; 3]]) {
        let (lo, hi) = pts.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p[2]), hi.max(p[2])));
        if hi - lo > 1e-6 {
            self.flattened += 1;
        }
    }

    fn line(&mut self, layer: &str, a: [f64; 3], b: [f64; 3]) {
        self.flat_ends(&[a, b]);
        self.push(layer, E::Line(xy(a), xy(b)));
    }

    /// `c + u cos t + v sin t` for `t` from `t0` over `sweep`, mapped by `m`:
    /// a circle or arc when the image stays round, else a B-spline ellipse or a
    /// fit spline through samples. `ends` are the exact end points of a bulge.
    #[allow(clippy::too_many_arguments)]
    fn conic(
        &mut self,
        layer: &str,
        m: &Mat,
        c: [f64; 3],
        u: [f64; 3],
        v: [f64; 3],
        t0: f64,
        sweep: f64,
        ends: Option<([f64; 3], [f64; 3])>,
    ) {
        let (cw, uw, vw) = (apply(m, c), dir(m, u), dir(m, v));
        let size = norm(uw).max(norm(vw));
        if size <= 0.0 || !size.is_finite() {
            return;
        }
        if uw[2].abs() > FLAT * size || vw[2].abs() > FLAT * size {
            self.tilted += 1;
            return;
        }
        let (cu, uu, vv) = (xy(cw), xy(uw), xy(vw));
        let pt = |t: f64| [cu[0] + uu[0] * t.cos() + vv[0] * t.sin(), cu[1] + uu[1] * t.cos() + vv[1] * t.sin()];
        let (lu, lv) = (uu[0].hypot(uu[1]), vv[0].hypot(vv[1]));
        let round = (lu - lv).abs() <= 1e-9 * lu && (uu[0] * vv[0] + uu[1] * vv[1]).abs() <= 1e-9 * lu * lv;
        let full = sweep.abs() >= TAU - 1e-9;
        if round {
            if full {
                self.push(layer, E::Circle(cu, lu));
            } else {
                let (s, e) = ends.map_or_else(|| (pt(t0), pt(t0 + sweep)), |(a, b)| (xy(apply(m, a)), xy(apply(m, b))));
                self.push(layer, E::Arc(s, e, pt(t0 + sweep / 2.0)));
            }
            return;
        }
        self.ellipses += 1;
        if full {
            let n = if size <= 100.0 {
                32
            } else if size <= 2000.0 {
                64
            } else {
                128
            };
            #[allow(clippy::cast_precision_loss)]
            let h = TAU / n as f64;
            let k = 2.0 / ((4.0 + 2.0 * h.cos()) / 6.0 + (46.0 * (h / 2.0).cos() + 2.0 * (1.5 * h).cos()) / 48.0);
            #[allow(clippy::cast_precision_loss)]
            let poles = (0..n)
                .map(|i| {
                    let t = i as f64 * h;
                    [cu[0] + k * (uu[0] * t.cos() + vv[0] * t.sin()), cu[1] + k * (uu[1] * t.cos() + vv[1] * t.sin())]
                })
                .collect();
            self.push(layer, E::Bsp { poles, degree: 3, knots: Vec::new(), closed: true });
        } else {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_precision_loss)]
            let n = ((sweep.abs() / 6f64.to_radians()).ceil() as usize).max(8);
            #[allow(clippy::cast_precision_loss)]
            let mut pts: Vec<P2> = (0..=n).map(|i| pt(t0 + sweep * i as f64 / n as f64)).collect();
            if let Some((a, b)) = ends {
                pts[0] = xy(apply(m, a));
                pts[n] = xy(apply(m, b));
            }
            self.push(layer, E::Fit(pts));
        }
    }

    /// A polyline segment in the object frame `m`, straight or with a bulge.
    fn segment(&mut self, layer: &str, m: &Mat, p: [f64; 3], q: [f64; 3], bulge: f64) {
        if bulge.abs() < 1e-12 {
            if !self.planar(m) {
                return;
            }
            self.push(layer, E::Line(xy(apply(m, p)), xy(apply(m, q))));
            return;
        }
        let sweep = 4.0 * bulge.atan();
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let chord = dx.hypot(dy);
        if chord <= 0.0 {
            return;
        }
        let h = (chord / 2.0) / (sweep / 2.0).tan();
        let c = [(p[0] + q[0]) / 2.0 - dy / chord * h, (p[1] + q[1]) / 2.0 + dx / chord * h, p[2]];
        let r = (p[0] - c[0]).hypot(p[1] - c[1]);
        let t0 = (p[1] - c[1]).atan2(p[0] - c[0]);
        self.conic(layer, m, c, [r, 0.0, 0.0], [0.0, r, 0.0], t0, sweep, Some((p, q)));
    }

    fn planar(&mut self, m: &Mat) -> bool {
        let z = dir(m, [0.0, 0.0, 1.0]);
        let ok = z[0].abs() <= FLAT * norm(z) && z[1].abs() <= FLAT * norm(z);
        if !ok {
            self.tilted += 1;
        }
        ok
    }

    fn triangles(&mut self, layer: &str, pts: &[[f64; 3]], faces: &[Vec<usize>]) {
        let (pos, idx) = self.meshes.entry(layer.to_string()).or_default();
        #[allow(clippy::cast_possible_truncation)]
        let base = (pos.len() / 3) as u32;
        pos.extend(pts.iter().flatten());
        for f in faces {
            let f: Vec<usize> = f.iter().copied().filter(|&i| i < pts.len()).collect();
            for k in 1..f.len().saturating_sub(1) {
                if f[0] != f[k] && f[k] != f[k + 1] && f[0] != f[k + 1] {
                    #[allow(clippy::cast_possible_truncation)]
                    idx.extend([f[0], f[k], f[k + 1]].map(|i| base + i as u32));
                    self.tris += 1;
                }
            }
        }
    }
}

struct Walker<'a> {
    blocks: &'a HashMap<String, Block>,
    out: Out,
    stack: Vec<String>,
    layer_names: HashMap<String, String>,
}

impl Walker<'_> {
    fn walk(&mut self, ents: &[Ent], m: &Mat, inherit: Option<&str>) {
        for e in ents {
            if self.out.full() {
                return;
            }
            if e.i(67, 0) == 1 {
                continue;
            }
            let mut layer = e.layer();
            if let Some(owner) = inherit.filter(|_| layer == "0") {
                layer = owner.to_string();
            }
            let layer = self.layer_names.entry(layer.to_uppercase()).or_insert(layer).clone();
            self.entity(e, m, &layer);
        }
    }

    fn entity(&mut self, e: &Ent, m: &Mat, layer: &str) {
        let out = &mut self.out;
        match e.kind.as_str() {
            "LINE" => out.line(layer, apply(m, e.p(10)), apply(m, e.p(11))),
            "POINT" => out.push(layer, E::Point(xy(apply(m, e.p(10))))),
            "CIRCLE" | "ARC" => {
                let mo = mul(m, &ocs(e.normal()));
                let r = e.f(40, 0.0);
                let (t0, sweep) = if e.kind == "CIRCLE" {
                    (0.0, TAU)
                } else {
                    let a0 = e.f(50, 0.0).to_radians();
                    let s = (e.f(51, 360.0).to_radians() - a0).rem_euclid(TAU);
                    (a0, if s <= 1e-12 { TAU } else { s })
                };
                out.conic(layer, &mo, e.p(10), [r, 0.0, 0.0], [0.0, r, 0.0], t0, sweep, None);
            }
            "ELLIPSE" => {
                let major = e.p(11);
                let minor = unit(cross(unit(e.normal()), major)).map(|x| x * norm(major) * e.f(40, 1.0));
                let s = e.f(41, 0.0);
                let mut sweep = e.f(42, TAU) - s;
                if sweep <= 1e-12 {
                    sweep += TAU;
                }
                out.conic(layer, m, e.p(10), major, minor, s, sweep.min(TAU), None);
            }
            "LWPOLYLINE" => {
                let mo = mul(m, &ocs(e.normal()));
                let z = e.f(38, 0.0);
                let mut verts: Vec<([f64; 3], f64)> = Vec::new();
                for (c, v) in &e.pairs {
                    match c {
                        10 => verts.push(([v.f(), 0.0, z], 0.0)),
                        20 => {
                            if let Some(p) = verts.last_mut() {
                                p.0[1] = v.f();
                            }
                        }
                        42 => {
                            if let Some(p) = verts.last_mut() {
                                p.1 = v.f();
                            }
                        }
                        _ => {}
                    }
                }
                polyline(out, layer, &mo, &verts, e.i(70, 0) & 1 != 0);
            }
            "POLYLINE" => self.polyline(e, m, layer),
            "SPLINE" => spline(out, layer, m, e),
            "3DFACE" => {
                let p = [10, 11, 12, 13].map(|c| apply(m, e.p(c)));
                let faces = if p[3] == p[2] { vec![vec![0, 1, 2]] } else { vec![vec![0, 1, 2, 3]] };
                out.triangles(layer, &p, &faces);
            }
            "MESH" => mesh_entity(out, layer, m, e),
            "INSERT" => self.insert(e, m, layer),
            "3DSOLID" | "BODY" | "REGION" | "SURFACE" => *out.acis.entry(e.kind.clone()).or_default() += 1,
            other => *out.skipped.entry(other.to_string()).or_default() += 1,
        }
        if e.kind == "INSERT" && !e.subs.is_empty() {
            *self.out.skipped.entry("ATTRIB".into()).or_default() += e.subs.len();
        }
    }

    fn polyline(&mut self, e: &Ent, m: &Mat, layer: &str) {
        let flags = e.i(70, 0);
        let out = &mut self.out;
        if flags & 64 != 0 {
            let mut pts = Vec::new();
            let mut faces = Vec::new();
            for v in &e.subs {
                let vf = v.i(70, 0);
                if vf & 64 != 0 {
                    pts.push(apply(m, v.p(10)));
                } else if vf & 128 != 0 {
                    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
                    let f: Vec<usize> = [71, 72, 73, 74]
                        .iter()
                        .map(|&c| v.i(c, 0).unsigned_abs() as usize)
                        .filter(|&i| i > 0)
                        .map(|i| i - 1)
                        .collect();
                    faces.push(f);
                }
            }
            out.triangles(layer, &pts, &faces);
        } else if flags & 16 != 0 {
            #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
            let (rows, cols) = (e.i(71, 0).max(0) as usize, e.i(72, 0).max(0) as usize);
            let pts: Vec<[f64; 3]> = e.subs.iter().map(|v| apply(m, v.p(10))).collect();
            if rows * cols == 0 || pts.len() < rows * cols {
                return;
            }
            let (wrap_r, wrap_c) = (flags & 1 != 0, flags & 32 != 0);
            let mut faces = Vec::new();
            for i in 0..if wrap_r { rows } else { rows - 1 } {
                for j in 0..if wrap_c { cols } else { cols - 1 } {
                    let (i1, j1) = ((i + 1) % rows, (j + 1) % cols);
                    faces.push(vec![i * cols + j, i1 * cols + j, i1 * cols + j1, i * cols + j1]);
                }
            }
            out.triangles(layer, &pts, &faces);
        } else if flags & 8 != 0 {
            let pts: Vec<[f64; 3]> =
                e.subs.iter().filter(|v| v.i(70, 0) & 16 == 0).map(|v| apply(m, v.p(10))).collect();
            let n = if flags & 1 != 0 { pts.len() } else { pts.len().saturating_sub(1) };
            for i in 0..n {
                out.line(layer, pts[i], pts[(i + 1) % pts.len()]);
            }
        } else {
            let mo = mul(m, &ocs(e.normal()));
            let z = e.f(30, 0.0);
            let verts: Vec<([f64; 3], f64)> = e
                .subs
                .iter()
                .filter(|v| v.i(70, 0) & 16 == 0)
                .map(|v| ([v.f(10, 0.0), v.f(20, 0.0), z], v.f(42, 0.0)))
                .collect();
            polyline(out, layer, &mo, &verts, flags & 1 != 0);
        }
    }

    fn insert(&mut self, e: &Ent, m: &Mat, layer: &str) {
        let name = e.s(2).to_uppercase();
        let Some(block) = self.blocks.get(&name) else {
            *self.out.skipped.entry("INSERT of a missing block".into()).or_default() += 1;
            return;
        };
        if block.xref {
            self.out.xrefs += 1;
            return;
        }
        if name.starts_with("*PAPER_SPACE") {
            return;
        }
        if self.stack.contains(&name) || self.stack.len() >= MAX_INSERT_DEPTH {
            self.out.loops += 1;
            return;
        }
        let s = [e.f(41, 1.0), e.f(42, 1.0), e.f(43, 1.0)];
        let head = mul(&mul(&mul(m, &translate(e.p(10))), &ocs(e.normal())), &rot_z(e.f(50, 0.0).to_radians()));
        let tail = mul(&scale(s), &translate(block.base.map(|x| -x)));
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let (cols, rows) = (e.i(70, 1).max(1) as usize, e.i(71, 1).max(1) as usize);
        self.stack.push(name);
        'array: for r in 0..rows {
            for c in 0..cols {
                if self.out.full() {
                    break 'array;
                }
                #[allow(clippy::cast_precision_loss)]
                let step = translate([c as f64 * e.f(44, 0.0), r as f64 * e.f(45, 0.0), 0.0]);
                self.walk(&block.ents, &mul(&mul(&head, &step), &tail), Some(layer));
            }
        }
        self.stack.pop();
    }
}

fn polyline(out: &mut Out, layer: &str, m: &Mat, verts: &[([f64; 3], f64)], closed: bool) {
    let n = if closed { verts.len() } else { verts.len().saturating_sub(1) };
    for i in 0..n {
        let (p, b) = verts[i];
        let q = verts[(i + 1) % verts.len()].0;
        if p != q {
            out.segment(layer, m, p, q, b);
        }
    }
}

fn mesh_entity(out: &mut Out, layer: &str, m: &Mat, e: &Ent) {
    let mut pts = Vec::new();
    let mut list: Vec<i64> = Vec::new();
    let (mut want_v, mut want_f) = (0usize, 0usize);
    let mut cur: Option<[f64; 3]> = None;
    for (c, v) in &e.pairs {
        match c {
            92 => want_v = usize::try_from(v.i()).unwrap_or(0),
            10 if pts.len() < want_v => cur = Some([v.f(), 0.0, 0.0]),
            20 => {
                if let Some(p) = cur.as_mut() {
                    p[1] = v.f();
                }
            }
            30 => {
                if let Some(mut p) = cur.take() {
                    p[2] = v.f();
                    pts.push(apply(m, p));
                }
            }
            93 => want_f = usize::try_from(v.i()).unwrap_or(0),
            90 if list.len() < want_f => list.push(v.i()),
            94 => want_f = 0,
            _ => {}
        }
    }
    let mut faces = Vec::new();
    let mut at = 0usize;
    while at < list.len() {
        let n = usize::try_from(list[at]).unwrap_or(0);
        let f: Vec<usize> = list.iter().skip(at + 1).take(n).filter_map(|&i| usize::try_from(i).ok()).collect();
        faces.push(f);
        at += n + 1;
    }
    out.triangles(layer, &pts, &faces);
}

/// One B-spline cut into pieces the sketch's `bspline` entity holds exactly:
/// clamped ends and interior knots of multiplicity one. Knots of multiplicity
/// two or more are raised to the degree by knot insertion and split there.
fn split_bspline(poles: &[[f64; 3]], knots: &[f64], degree: usize) -> Vec<(Vec<[f64; 3]>, Vec<f64>)> {
    let p = degree;
    let mut u = knots.to_vec();
    let span = u[u.len() - p - 1] - u[p];
    for i in 1..u.len() {
        if (u[i] - u[i - 1]).abs() <= 1e-10 * span {
            u[i] = u[i - 1];
        }
    }
    let (a, b) = (u[p], u[u.len() - p - 1]);
    let mult = |u: &[f64], t: f64| u.iter().filter(|&&x| x == t).count();
    let mut breaks = vec![a];
    let mut last = f64::NAN;
    for &t in &u {
        if t > a && t < b && t != last && mult(&u, t) >= 2 {
            breaks.push(t);
        }
        last = t;
    }
    breaks.push(b);
    let mut ctrl = poles.to_vec();
    for &t in &breaks {
        while mult(&u, t) < p {
            insert_knot(&mut u, &mut ctrl, p, t);
        }
    }
    breaks
        .windows(2)
        .map(|w| {
            let (u0, u1) = (w[0], w[1]);
            let last0 = u.iter().rposition(|&x| x == u0).unwrap_or(p);
            let mut ks = vec![u0];
            for &t in &u {
                if t > u0 && t < u1 && ks.last() != Some(&t) {
                    ks.push(t);
                }
            }
            ks.push(u1);
            let start = last0.saturating_sub(p);
            let n = p + ks.len() - 1;
            (ctrl[start..(start + n).min(ctrl.len())].to_vec(), ks)
        })
        .collect()
}

/// Boehm knot insertion of `t` into a non-rational B-spline.
fn insert_knot(u: &mut Vec<f64>, ctrl: &mut Vec<[f64; 3]>, p: usize, t: f64) {
    let n = ctrl.len() - 1;
    let mut k = p;
    while k < n && u[k + 1] <= t {
        k += 1;
    }
    let mut q = Vec::with_capacity(ctrl.len() + 1);
    for i in 0..=n + 1 {
        if i + p <= k {
            q.push(ctrl[i]);
        } else if i > k {
            q.push(ctrl[i - 1]);
        } else {
            let d = u[i + p] - u[i];
            let a = if d > 0.0 { (t - u[i]) / d } else { 0.0 };
            q.push([0, 1, 2].map(|j| (1.0 - a) * ctrl[i - 1][j] + a * ctrl[i][j]));
        }
    }
    u.insert(k + 1, t);
    *ctrl = q;
}

/// A point of a rational B-spline by de Boor's algorithm, homogeneous poles.
fn de_boor(u: &[f64], ctrl: &[[f64; 4]], p: usize, t: f64) -> [f64; 3] {
    let n = ctrl.len() - 1;
    let mut k = p;
    while k < n && u[k + 1] <= t {
        k += 1;
    }
    let mut d: Vec<[f64; 4]> = (0..=p).map(|j| ctrl[j + k - p]).collect();
    for r in 1..=p {
        for j in (r..=p).rev() {
            let i = j + k - p;
            let den = u[i + p + 1 - r] - u[i];
            let a = if den > 0.0 { (t - u[i]) / den } else { 0.0 };
            d[j] = [0, 1, 2, 3].map(|c| (1.0 - a) * d[j - 1][c] + a * d[j][c]);
        }
    }
    let w = if d[p][3] == 0.0 { 1.0 } else { d[p][3] };
    [d[p][0] / w, d[p][1] / w, d[p][2] / w]
}

fn spline(out: &mut Out, layer: &str, m: &Mat, e: &Ent) {
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let p = e.i(71, 3).max(1) as usize;
    let knots = e.all_f(40);
    let weights = e.all_f(41);
    let ctrl: Vec<[f64; 3]> = e.points(10).into_iter().map(|q| apply(m, q)).collect();
    let fit: Vec<[f64; 3]> = e.points(11).into_iter().map(|q| apply(m, q)).collect();
    let usable = ctrl.len() > p
        && knots.len() == ctrl.len() + p + 1
        && knots.windows(2).all(|w| w[1] >= w[0])
        && knots[p] < knots[ctrl.len()];
    if !usable {
        if fit.len() >= 2 {
            out.flat_ends(&fit);
            out.push(layer, E::Fit(fit.iter().map(|q| xy(*q)).collect()));
        } else {
            *out.skipped.entry("SPLINE without usable data".into()).or_default() += 1;
        }
        return;
    }
    out.flat_ends(&ctrl);
    let w0 = weights.first().copied().unwrap_or(1.0);
    let rational = weights.len() == ctrl.len() && weights.iter().any(|w| (w - w0).abs() > 1e-12 * w0.abs().max(1.0));
    if rational {
        out.rational += 1;
        let hom: Vec<[f64; 4]> = ctrl.iter().zip(&weights).map(|(q, w)| [q[0] * w, q[1] * w, q[2] * w, *w]).collect();
        let (a, b) = (knots[p], knots[ctrl.len()]);
        let n = (16 * (ctrl.len() - p)).clamp(16, 400);
        #[allow(clippy::cast_precision_loss)]
        let pts = (0..=n).map(|i| xy(de_boor(&knots, &hom, p, a + (b - a) * i as f64 / n as f64))).collect();
        out.push(layer, E::Fit(pts));
        return;
    }
    for (poles, ks) in split_bspline(&ctrl, &knots, p) {
        out.push(layer, E::Bsp { poles: poles.iter().map(|q| xy(*q)).collect(), degree: p, knots: ks, closed: false });
    }
}

/// Snaps points closer than `tol` onto the first one seen, through a grid hash.
struct Welder {
    tol: f64,
    cells: HashMap<(i64, i64), Vec<usize>>,
    reps: Vec<P2>,
}

impl Welder {
    fn new(tol: f64) -> Self {
        Welder { tol, cells: HashMap::new(), reps: Vec::new() }
    }
    #[allow(clippy::cast_possible_truncation)]
    fn cell(&self, p: P2) -> (i64, i64) {
        ((p[0] / self.tol).floor() as i64, (p[1] / self.tol).floor() as i64)
    }
    fn snap(&mut self, p: P2) -> (P2, usize) {
        let (cx, cy) = self.cell(p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(list) = self.cells.get(&(cx + dx, cy + dy)) {
                    for &i in list {
                        let q = self.reps[i];
                        if (q[0] - p[0]).hypot(q[1] - p[1]) <= self.tol {
                            return (q, i);
                        }
                    }
                }
            }
        }
        self.reps.push(p);
        self.cells.entry((cx, cy)).or_default().push(self.reps.len() - 1);
        (p, self.reps.len() - 1)
    }
}

struct Welded {
    ents: Vec<E>,
    open_ends: usize,
    dropped: usize,
}

fn extent(ents: &[E]) -> f64 {
    let mut lo = [f64::MAX; 2];
    let mut hi = [f64::MIN; 2];
    let mut add = |p: P2, r: f64| {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k] - r);
            hi[k] = hi[k].max(p[k] + r);
        }
    };
    for e in ents {
        match e {
            E::Line(a, b) => {
                add(*a, 0.0);
                add(*b, 0.0);
            }
            E::Arc(a, b, c) => [a, b, c].into_iter().for_each(|p| add(*p, 0.0)),
            E::Circle(c, r) => add(*c, *r),
            E::Bsp { poles: pts, .. } | E::Fit(pts) => pts.iter().for_each(|p| add(*p, 0.0)),
            E::Point(p) => add(*p, 0.0),
        }
    }
    (hi[0] - lo[0]).hypot(hi[1] - lo[1])
}

/// Welds the ends of one layer's entities with the sketch fuzz, turns an arc
/// whose ends met into a circle, drops zero length lines and duplicates, and
/// counts the ends nothing else meets.
fn weld(ents: Vec<E>) -> Welded {
    let tol = crate::kernel::sketch_fuzz(Some(extent(&ents)));
    let mut w = Welder::new(tol);
    let mut uses: HashMap<usize, usize> = HashMap::new();
    let mut seen: HashSet<Vec<u64>> = HashSet::new();
    let mut out = Vec::new();
    let mut dropped = 0;
    let key = |tag: u64, pts: &[P2]| -> Vec<u64> {
        std::iter::once(tag).chain(pts.iter().flat_map(|p| [p[0].to_bits(), p[1].to_bits()])).collect()
    };
    for e in ents {
        let mut ends = Vec::new();
        let e = match e {
            E::Line(a, b) => {
                let (a, ia) = w.snap(a);
                let (b, ib) = w.snap(b);
                if ia == ib {
                    dropped += 1;
                    continue;
                }
                ends.extend([ia, ib]);
                E::Line(a, b)
            }
            E::Arc(s, e, m) => {
                let (s, is) = w.snap(s);
                let (e, ie) = w.snap(e);
                if is == ie {
                    E::Circle([(s[0] + m[0]) / 2.0, (s[1] + m[1]) / 2.0], (s[0] - m[0]).hypot(s[1] - m[1]) / 2.0)
                } else {
                    ends.extend([is, ie]);
                    E::Arc(s, e, m)
                }
            }
            E::Bsp { mut poles, degree, knots, closed } => {
                if !closed && poles.len() >= 2 {
                    let n = poles.len() - 1;
                    let (a, ia) = w.snap(poles[0]);
                    let (b, ib) = w.snap(poles[n]);
                    poles[0] = a;
                    poles[n] = b;
                    if ia != ib {
                        ends.extend([ia, ib]);
                    }
                }
                E::Bsp { poles, degree, knots, closed }
            }
            E::Fit(mut pts) => {
                let n = pts.len() - 1;
                let (a, ia) = w.snap(pts[0]);
                let (b, ib) = w.snap(pts[n]);
                pts[0] = a;
                pts[n] = b;
                if ia != ib {
                    ends.extend([ia, ib]);
                }
                E::Fit(pts)
            }
            other => other,
        };
        let k = match &e {
            E::Line(a, b) => {
                let (lo, hi) = if (a[0], a[1]) <= (b[0], b[1]) { (a, b) } else { (b, a) };
                key(0, &[*lo, *hi])
            }
            E::Arc(s, e, m) => {
                let (lo, hi) = if (s[0], s[1]) <= (e[0], e[1]) { (s, e) } else { (e, s) };
                key(1, &[*lo, *hi, *m])
            }
            E::Circle(c, r) => key(2, &[*c, [*r, 0.0]]),
            E::Bsp { poles, .. } => key(3, poles),
            E::Fit(pts) => key(4, pts),
            E::Point(p) => key(5, &[*p]),
        };
        if !seen.insert(k) {
            dropped += 1;
            continue;
        }
        for i in ends {
            *uses.entry(i).or_default() += 1;
        }
        out.push(e);
    }
    Welded { ents: out, open_ends: uses.values().filter(|&&n| n == 1).count(), dropped }
}

fn pt(p: P2) -> Value {
    json!({"x": p[0], "y": p[1]})
}

fn entity_json(e: &E, id: usize) -> Value {
    let id = format!("e{id}");
    match e {
        E::Line(a, b) => json!({"id": id, "type": "line", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]}),
        E::Arc(s, e, m) => {
            json!({"id": id, "type": "arc", "x1": s[0], "y1": s[1], "x2": e[0], "y2": e[1], "mx": m[0], "my": m[1]})
        }
        E::Circle(c, r) => json!({"id": id, "type": "circle", "x": c[0], "y": c[1], "radius": r}),
        E::Bsp { poles, degree, knots, closed } => {
            let mut v = json!({"id": id, "type": "bspline", "poles": poles.iter().map(|p| pt(*p)).collect::<Vec<_>>(), "degree": degree});
            if *closed {
                v["closed"] = json!(true);
            } else {
                v["knots"] = json!(knots);
            }
            v
        }
        E::Fit(pts) => json!({"id": id, "type": "spline", "points": pts.iter().map(|p| pt(*p)).collect::<Vec<_>>()}),
        E::Point(p) => json!({"id": id, "type": "point", "x": p[0], "y": p[1]}),
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Reads a DXF file's model space.
pub fn read_dxf(data: &[u8]) -> Result<DxfRead, String> {
    let pairs = if data.starts_with(BINARY_SENTINEL) { binary_pairs(data)? } else { ascii_pairs(data)? };
    let d = drawing(pairs)?;
    let (mm, unit, unnamed) = unit_scale(d.insunits)?;
    let mut walker = Walker { blocks: &d.blocks, out: Out::default(), stack: Vec::new(), layer_names: HashMap::new() };
    walker.walk(&d.entities, &scale([mm; 3]), None);
    let o = walker.out;
    if o.count > MAX_SKETCH_ENTITIES {
        return Err(format!(
            "this DXF has more than {MAX_SKETCH_ENTITIES} lines and curves, too many for a usable sketch. Split the drawing in the source app and import the part you need"
        ));
    }
    if o.tris as u64 > MAX_IMPORT_TRIANGLES {
        return Err(format!(
            "this DXF has more than {MAX_IMPORT_TRIANGLES} 3D face triangles, too many to import as editable bodies. Split the drawing in the source app and import the part you need"
        ));
    }
    let mut notes = Vec::new();
    if unnamed {
        notes.push("the drawing names no unit, read as millimetres".to_string());
    }
    let mut sketches = Vec::new();
    let mut dropped = 0;
    for (name, ents) in o.layers {
        let w = weld(ents);
        dropped += w.dropped;
        if w.open_ends > 0 {
            notes.push(format!(
                "layer {name} has {} and will not extrude until they meet",
                plural(w.open_ends, "open end", "open ends")
            ));
        }
        if !w.ents.is_empty() {
            sketches.push((name, w.ents.iter().enumerate().map(|(i, e)| entity_json(e, i + 1)).collect()));
        }
    }
    if !o.skipped.is_empty() {
        let list: Vec<String> = o.skipped.iter().map(|(k, n)| format!("{n} {k}")).collect();
        notes.push(format!("skipped what is not geometry: {}", list.join(", ")));
    }
    if o.ellipses > 0 {
        notes.push(format!("{} became B-splines", plural(o.ellipses, "ellipse", "ellipses")));
    }
    if o.rational > 0 {
        notes.push(format!("{} became fit splines", plural(o.rational, "rational spline", "rational splines")));
    }
    if o.tilted > 0 {
        notes.push(format!("{} not parallel to the XY plane were skipped", plural(o.tilted, "entity", "entities")));
    }
    if o.flattened > 0 {
        notes.push(format!(
            "{} with varying height were flattened onto the XY plane",
            plural(o.flattened, "entity", "entities")
        ));
    }
    if dropped > 0 {
        notes.push(format!("{} of zero length or drawn twice were left out", plural(dropped, "entity", "entities")));
    }
    if o.xrefs > 0 {
        notes.push(format!("{} were not loaded", plural(o.xrefs, "external reference", "external references")));
    }
    if o.loops > 0 {
        notes.push(format!(
            "{} nested too deep or in a loop were left out",
            plural(o.loops, "block reference", "block references")
        ));
    }
    for (kind, n) in &o.acis {
        notes.push(format!("{n} {kind} (ACIS) could not be read, export them from the source app as STEP"));
    }
    let objects = o
        .meshes
        .into_iter()
        .filter(|(_, (_, idx))| !idx.is_empty())
        .map(|(name, (pos, idx))| MeshObject { name: Some(name), color: None, pos, idx })
        .collect();
    Ok(DxfRead { sketches, objects, notes, unit })
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: Mat = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]];

    fn close(a: P2, b: P2) -> bool {
        (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-9
    }

    fn dxf(insunits: i64, block: &str, entities: &str) -> Vec<u8> {
        let mut t = format!("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n{insunits}\n0\nENDSEC\n");
        t += &format!(
            "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nB\n70\n0\n10\n0\n20\n0\n30\n0\n{block}0\nENDBLK\n0\nENDSEC\n"
        );
        t += &format!("0\nSECTION\n2\nENTITIES\n{entities}0\nENDSEC\n0\nEOF\n");
        t.into_bytes()
    }

    const UNIT_LINE: &str = "0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n0\n31\n0\n";
    const UNIT_FACE: &str =
        "0\n3DFACE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n0\n31\n0\n12\n0\n22\n1\n32\n0\n13\n0\n23\n1\n33\n0\n";
    const HUGE_ARRAY: &str = "0\nINSERT\n8\nL\n2\nB\n10\n0\n20\n0\n30\n0\n70\n30000\n71\n30000\n44\n2\n45\n2\n";

    #[test]
    fn a_huge_insert_array_stops_at_the_cap() {
        for block in [UNIT_LINE, UNIT_FACE] {
            let t = std::time::Instant::now();
            let err = read_dxf(&dxf(4, block, HUGE_ARRAY)).err().expect("a 30000 x 30000 array must be refused");
            assert!(err.contains("more than"), "{err}");
            assert!(t.elapsed().as_secs_f64() < 5.0, "took {:?}", t.elapsed());
        }
    }

    #[test]
    fn every_length_unit_code_reads() {
        for (code, mm) in [
            (3, 1_609_344.0),
            (7, 1e6),
            (11, 1e-7),
            (12, 1e-6),
            (15, 1e4),
            (16, 1e5),
            (22, 25.400_050_800_101_6),
            (23, 914.401_828_803_657_6),
            (24, 1_609_347.218_694_437_4),
        ] {
            let got = unit_scale(Some(code)).unwrap_or_else(|e| panic!("code {code}: {e}")).0;
            assert!((got - mm).abs() < mm * 1e-12, "code {code}: {got}");
        }
        let r = read_dxf(&dxf(22, "", UNIT_LINE)).unwrap();
        assert_eq!(r.sketches[0].1[0]["x2"], 25.400_050_800_101_6);
    }

    #[test]
    fn layers_that_differ_only_in_case_are_one_sketch() {
        let walls = UNIT_LINE.replace("8\n0\n", "8\nWalls\n");
        let shouted = UNIT_LINE.replace("8\n0\n", "8\nWALLS\n").replace("21\n0", "21\n5");
        let ents = format!("{walls}{shouted}");
        let r = read_dxf(&dxf(4, "", &ents)).unwrap();
        let names: Vec<&str> = r.sketches.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["Walls"]);
        assert_eq!(r.sketches[0].1.len(), 2);
    }

    #[test]
    fn a_positive_bulge_turns_counter_clockwise() {
        let mut o = Out::default();
        o.segment("L", &IDENTITY, [0.0, 0.0, 0.0], [2.0, 0.0, 0.0], 1.0);
        let E::Arc(s, e, m) = o.layers["L"][0] else { panic!("{:?}", o.layers) };
        assert!(close(s, [0.0, 0.0]) && close(e, [2.0, 0.0]) && close(m, [1.0, -1.0]), "{s:?} {e:?} {m:?}");
        o.segment("L", &IDENTITY, [0.0, 0.0, 0.0], [2.0, 0.0, 0.0], -(22.5f64.to_radians().tan()));
        let E::Arc(_, _, m) = o.layers["L"][1] else { panic!() };
        assert!(close(m, [1.0, 2f64.sqrt() - 1.0]), "{m:?}");
    }

    #[test]
    fn an_extrusion_of_minus_z_mirrors_x() {
        let m = ocs([0.0, 0.0, -1.0]);
        assert_eq!(apply(&m, [3.0, 4.0, 5.0]).map(|v| v + 0.0), [-3.0, 4.0, -5.0]);
    }

    #[test]
    fn the_weld_closes_a_rounding_gap_and_keeps_a_real_one() {
        let a = [114.768_526_500_636_41, 0.0];
        let w = weld(vec![E::Line([0.0, 0.0], a), E::Line([a[0] + 4.99e-7, 0.0], [200.0, 0.0])]);
        let (E::Line(_, b), E::Line(c, _)) = (&w.ents[0], &w.ents[1]) else { panic!() };
        assert_eq!(b, c);
        assert_eq!(w.open_ends, 2);
        let w = weld(vec![E::Line([0.0, 0.0], a), E::Line([a[0] + 1e-3, 0.0], [200.0, 0.0])]);
        assert_eq!(w.open_ends, 4);
    }

    #[test]
    fn binary_values_read_by_their_group_code() {
        let mut data = BINARY_SENTINEL.to_vec();
        let mut put = |code: u16, v: &[u8]| {
            data.extend(code.to_le_bytes());
            data.extend(v);
        };
        put(0, b"SECTION\0");
        put(10, &2.5f64.to_le_bytes());
        put(70, &(-3i16).to_le_bytes());
        put(90, &70000i32.to_le_bytes());
        put(290, &[1]);
        put(310, &[2, 0xab, 0xcd]);
        put(0, b"EOF\0");
        let pairs = binary_pairs(&data).unwrap();
        let got: Vec<(i32, f64)> = pairs[1..5].iter().map(|(c, v)| (*c, v.f())).collect();
        assert_eq!(got, [(10, 2.5), (70, -3.0), (90, 70000.0), (290, 1.0)]);
        assert_eq!(pairs.last().unwrap().1, V::S("EOF".into()));
    }

    #[test]
    fn a_double_knot_splits_the_spline_where_it_bends() {
        let poles: Vec<[f64; 3]> = (0..6).map(|i| [f64::from(i), f64::from(i * i), 0.0]).collect();
        let pieces = split_bspline(&poles, &[0.0, 0.0, 0.0, 0.0, 2.0, 2.0, 4.0, 4.0, 4.0, 4.0], 3);
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces[0].1, [0.0, 2.0]);
        assert_eq!(pieces[0].0.len(), 4);
        assert_eq!(pieces[0].0[3], pieces[1].0[0]);
        assert_eq!(pieces[1].0[3], poles[5]);
    }
}
