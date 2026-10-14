//! VRML 2.0 (.wrl) and X3D XML (.x3d) scenes: transforms, DEF and USE,
//! shapes with a diffuse colour and indexed or plain triangle geometry. Each
//! top level node is one body. Metres and Y up as in glTF.

use std::collections::HashMap;
use std::rc::Rc;

use super::mesh::{dominant_color, unit_color, MeshObject};

#[derive(Clone)]
enum Val {
    Nums(Vec<f64>),
    Bool(bool),
    Text,
    Node(Rc<Node>),
    Nodes(Vec<Rc<Node>>),
}

struct Node {
    kind: String,
    def: Option<String>,
    fields: HashMap<String, Val>,
}

impl Node {
    fn nums(&self, key: &str) -> Option<&[f64]> {
        match self.fields.get(key) {
            Some(Val::Nums(v)) => Some(v),
            _ => None,
        }
    }

    fn flag(&self, key: &str, default: bool) -> bool {
        match self.fields.get(key) {
            Some(Val::Bool(b)) => *b,
            _ => default,
        }
    }

    /// A child node held by `key` (VRML), or the first XML child of one of `kinds` (X3D).
    fn child(&self, key: &str, kinds: &[&str]) -> Option<Rc<Node>> {
        if let Some(Val::Node(n)) = self.fields.get(key) {
            return Some(n.clone());
        }
        self.children().into_iter().find(|n| kinds.contains(&n.kind.as_str()))
    }

    fn children(&self) -> Vec<Rc<Node>> {
        let mut out = Vec::new();
        for key in ["children", "choice", "level", "xml"] {
            match self.fields.get(key) {
                Some(Val::Nodes(v)) => out.extend(v.iter().cloned()),
                Some(Val::Node(n)) => out.push(n.clone()),
                _ => {}
            }
        }
        out
    }
}

fn bad(what: &str, why: impl std::fmt::Display) -> String {
    format!("couldn't read this {what} file, {why}")
}

// --- VRML 2.0 text ---

struct Tokens<'a> {
    s: &'a [u8],
    at: usize,
}

impl<'a> Tokens<'a> {
    fn skip_space(&mut self) {
        while self.at < self.s.len() {
            match self.s[self.at] {
                b'#' => {
                    while self.at < self.s.len() && self.s[self.at] != b'\n' {
                        self.at += 1;
                    }
                }
                c if c.is_ascii_whitespace() || c == b',' => self.at += 1,
                _ => break,
            }
        }
    }

    fn peek(&mut self) -> Option<&'a str> {
        let at = self.at;
        let t = self.next();
        self.at = at;
        t
    }

    fn next(&mut self) -> Option<&'a str> {
        self.skip_space();
        let start = self.at;
        let c = *self.s.get(self.at)?;
        if matches!(c, b'{' | b'}' | b'[' | b']') {
            self.at += 1;
        } else if c == b'"' {
            self.at += 1;
            while self.at < self.s.len() && self.s[self.at] != b'"' {
                self.at += if self.s[self.at] == b'\\' { 2 } else { 1 };
            }
            self.at = (self.at + 1).min(self.s.len());
        } else {
            while self.at < self.s.len() {
                let c = self.s[self.at];
                if c.is_ascii_whitespace() || matches!(c, b',' | b'{' | b'}' | b'[' | b']' | b'#' | b'"') {
                    break;
                }
                self.at += 1;
            }
        }
        std::str::from_utf8(&self.s[start..self.at]).ok()
    }

    /// Steps over one balanced `{...}` or `[...]` group, or one token.
    fn skip_value(&mut self) {
        let mut depth = 0i32;
        while let Some(t) = self.next() {
            match t {
                "{" | "[" => depth += 1,
                "}" | "]" => depth -= 1,
                _ => {}
            }
            if depth <= 0 {
                return;
            }
        }
    }
}

fn is_num(t: &str) -> bool {
    t.as_bytes().first().is_some_and(|c| c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.'))
}

struct Vrml<'a> {
    t: Tokens<'a>,
    defs: HashMap<String, Rc<Node>>,
    skipped: Vec<String>,
    depth: usize,
}

impl Vrml<'_> {
    fn node(&mut self) -> Result<Option<Rc<Node>>, String> {
        let eof = || bad("VRML", "it ends inside a node");
        let mut tok = self.t.next().ok_or_else(eof)?;
        match tok {
            "NULL" => return Ok(None),
            "USE" => {
                let name = self.t.next().ok_or_else(eof)?;
                return self.defs.get(name).cloned().map(Some).ok_or_else(|| bad("VRML", format!("USE {name} has no DEF before it")));
            }
            _ => {}
        }
        let mut def = None;
        if tok == "DEF" {
            def = Some(self.t.next().ok_or_else(eof)?.to_string());
            tok = self.t.next().ok_or_else(eof)?;
        }
        let kind = tok.to_string();
        if self.t.next() != Some("{") {
            return Err(bad("VRML", format!("'{kind}' has no '{{' after it")));
        }
        self.depth += 1;
        if self.depth > 256 {
            return Err(bad("VRML", "its nodes nest too deep"));
        }
        let mut fields = HashMap::new();
        loop {
            let name = self.t.next().ok_or_else(eof)?;
            if name == "}" {
                break;
            }
            if matches!(name, "ROUTE" | "PROTO" | "EXTERNPROTO") {
                self.skip_statement(name);
                continue;
            }
            if let Some(v) = self.value()? {
                fields.insert(name.to_string(), v);
            }
        }
        self.depth -= 1;
        let node = Rc::new(Node { kind, def: def.clone(), fields });
        if let Some(d) = def {
            self.defs.insert(d, node.clone());
        }
        Ok(Some(node))
    }

    fn value(&mut self) -> Result<Option<Val>, String> {
        let Some(t) = self.t.peek() else { return Err(bad("VRML", "it ends inside a field")) };
        if t == "[" {
            self.t.next();
            let mut nums = Vec::new();
            let mut nodes = Vec::new();
            loop {
                match self.t.peek() {
                    None => return Err(bad("VRML", "it ends inside a list")),
                    Some("]") => {
                        self.t.next();
                        break;
                    }
                    Some(x) if is_num(x) => nums.push(self.t.next().and_then(|x| x.parse().ok()).unwrap_or(0.0)),
                    Some(x) if x.starts_with('"') || x == "TRUE" || x == "FALSE" => {
                        self.t.next();
                    }
                    Some(_) => nodes.extend(self.node()?),
                }
            }
            return Ok(Some(if nodes.is_empty() { Val::Nums(nums) } else { Val::Nodes(nodes) }));
        }
        if is_num(t) {
            let mut nums = Vec::new();
            while let Some(x) = self.t.peek().filter(|x| is_num(x)) {
                nums.push(x.parse().map_err(|_| bad("VRML", format!("'{x}' is not a number")))?);
                self.t.next();
            }
            return Ok(Some(Val::Nums(nums)));
        }
        if t == "TRUE" || t == "FALSE" {
            self.t.next();
            return Ok(Some(Val::Bool(t == "TRUE")));
        }
        if t.starts_with('"') {
            self.t.next();
            return Ok(Some(Val::Text));
        }
        if t == "IS" {
            self.t.next();
            self.t.next();
            return Ok(None);
        }
        Ok(self.node()?.map(Val::Node))
    }

    fn skip_statement(&mut self, kw: &str) {
        self.skipped.push(kw.to_string());
        match kw {
            "ROUTE" => {
                for _ in 0..3 {
                    self.t.next();
                }
            }
            _ => {
                self.t.next();
                self.t.skip_value();
                self.t.skip_value();
            }
        }
    }
}

fn parse_vrml(text: &str) -> Result<(Vec<Rc<Node>>, Vec<String>), String> {
    let head = text.lines().next().unwrap_or("");
    if head.starts_with("#VRML V1.0") {
        return Err("this is a VRML 1.0 file, only VRML 2.0 (VRML97) imports".into());
    }
    if !head.starts_with("#VRML V2.0") {
        return Err(bad("VRML", "it does not start with #VRML V2.0"));
    }
    let mut p = Vrml { t: Tokens { s: text.as_bytes(), at: 0 }, defs: HashMap::new(), skipped: Vec::new(), depth: 0 };
    let mut top = Vec::new();
    while let Some(t) = p.t.peek() {
        if matches!(t, "ROUTE" | "PROTO" | "EXTERNPROTO") {
            p.t.next();
            p.skip_statement(t);
            continue;
        }
        top.extend(p.node()?);
    }
    Ok((top, p.skipped))
}

// --- X3D XML ---

fn attr_val(v: &str) -> Val {
    match v.trim() {
        "true" | "TRUE" => return Val::Bool(true),
        "false" | "FALSE" => return Val::Bool(false),
        _ => {}
    }
    let toks: Vec<&str> = v.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).collect();
    let nums: Option<Vec<f64>> = toks.iter().map(|t| t.parse().ok()).collect();
    match nums {
        Some(n) if !toks.is_empty() => Val::Nums(n),
        _ => Val::Text,
    }
}

fn parse_x3d(xml: &str) -> Result<Vec<Rc<Node>>, String> {
    use quick_xml::events::{BytesStart, Event};
    struct Open {
        kind: String,
        def: Option<String>,
        use_: Option<String>,
        fields: HashMap<String, Val>,
        kids: Vec<Rc<Node>>,
    }
    fn open(e: &BytesStart) -> Open {
        let mut o = Open {
            kind: String::from_utf8_lossy(e.local_name().as_ref()).into_owned(),
            def: None,
            use_: None,
            fields: HashMap::new(),
            kids: Vec::new(),
        };
        for a in e.attributes().flatten() {
            let key = String::from_utf8_lossy(a.key.local_name().as_ref()).into_owned();
            let val = a.unescape_value().map(|v| v.into_owned()).unwrap_or_default();
            match key.as_str() {
                "DEF" => o.def = Some(val),
                "USE" => o.use_ = Some(val),
                _ => {
                    o.fields.insert(key, attr_val(&val));
                }
            }
        }
        o
    }
    let mut defs: HashMap<String, Rc<Node>> = HashMap::new();
    let mut close = |o: Open| -> Result<Rc<Node>, String> {
        if let Some(u) = o.use_ {
            return defs.get(&u).cloned().ok_or_else(|| bad("X3D", format!("USE {u} has no DEF before it")));
        }
        let mut fields = o.fields;
        fields.insert("xml".into(), Val::Nodes(o.kids));
        let n = Rc::new(Node { kind: o.kind, def: o.def.clone(), fields });
        if let Some(d) = o.def {
            defs.insert(d, n.clone());
        }
        Ok(n)
    };
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut stack: Vec<Open> = Vec::new();
    let mut scene: Option<Vec<Rc<Node>>> = None;
    loop {
        match reader.read_event().map_err(|e| bad("X3D", e))? {
            Event::Start(e) => stack.push(open(&e)),
            Event::Empty(e) => {
                let n = close(open(&e))?;
                if let Some(p) = stack.last_mut() {
                    p.kids.push(n);
                }
            }
            Event::End(_) => {
                let Some(o) = stack.pop() else { continue };
                let is_scene = o.kind == "Scene";
                let n = close(o)?;
                if is_scene {
                    scene = Some(n.children());
                } else if let Some(p) = stack.last_mut() {
                    p.kids.push(n);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        if stack.len() > 256 {
            return Err(bad("X3D", "its nodes nest too deep"));
        }
    }
    scene.ok_or_else(|| bad("X3D", "it has no <Scene>"))
}

// --- the scene to triangles ---

/// Row major 3x4 affine.
type Affine = [[f64; 4]; 3];
const ID: Affine = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]];

fn then(a: &Affine, b: &Affine) -> Affine {
    let mut r = [[0.0; 4]; 3];
    for i in 0..3 {
        for j in 0..4 {
            r[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum::<f64>() + if j == 3 { a[i][3] } else { 0.0 };
        }
    }
    r
}

fn rotation(r: &[f64]) -> Affine {
    let (x, y, z, a) = (r[0], r[1], r[2], r[3]);
    let len = (x * x + y * y + z * z).sqrt();
    if len < 1e-12 || a == 0.0 {
        return ID;
    }
    let (x, y, z) = (x / len, y / len, z / len);
    let (s, c) = a.sin_cos();
    let t = 1.0 - c;
    [
        [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0.0],
        [t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0.0],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0.0],
    ]
}

fn shift(v: [f64; 3]) -> Affine {
    [[1.0, 0.0, 0.0, v[0]], [0.0, 1.0, 0.0, v[1]], [0.0, 0.0, 1.0, v[2]]]
}

fn vec3(n: &Node, key: &str, default: [f64; 3]) -> [f64; 3] {
    n.nums(key).filter(|v| v.len() >= 3).map_or(default, |v| [v[0], v[1], v[2]])
}

/// `T * C * R * SR * S * -SR * -C` of a Transform.
fn local(n: &Node) -> Affine {
    let c = vec3(n, "center", [0.0; 3]);
    let s = vec3(n, "scale", [1.0; 3]);
    let rot = |key: &str| n.nums(key).filter(|v| v.len() >= 4).map_or(ID, rotation);
    let so = n.nums("scaleOrientation").filter(|v| v.len() >= 4).map(|v| [v[0], v[1], v[2], -v[3]]);
    let scale = [[s[0], 0.0, 0.0, 0.0], [0.0, s[1], 0.0, 0.0], [0.0, 0.0, s[2], 0.0]];
    let mut m = then(&shift(vec3(n, "translation", [0.0; 3])), &shift(c));
    m = then(&m, &rot("rotation"));
    m = then(&m, &rot("scaleOrientation"));
    m = then(&m, &scale);
    m = then(&m, &so.map_or(ID, |v| rotation(&v)));
    then(&m, &shift([-c[0], -c[1], -c[2]]))
}

struct Walk {
    pos: Vec<f64>,
    idx: Vec<u32>,
    colors: Vec<Option<[u8; 3]>>,
    skipped: HashMap<String, usize>,
}

impl Walk {
    fn node(&mut self, n: &Node, m: &Affine, depth: usize) {
        if depth > 256 {
            return;
        }
        match n.kind.as_str() {
            "Transform" => {
                let m = then(m, &local(n));
                for c in n.children() {
                    self.node(&c, &m, depth + 1);
                }
            }
            "Group" | "StaticGroup" | "Anchor" | "Collision" | "Billboard" | "Scene" | "CADAssembly" | "CADLayer"
            | "CADPart" | "CADFace" => {
                for c in n.children() {
                    self.node(&c, m, depth + 1);
                }
            }
            "Switch" => {
                let which = n.nums("whichChoice").and_then(|v| v.first().copied()).unwrap_or(-1.0);
                if which >= 0.0 {
                    if let Some(c) = n.children().get(which as usize) {
                        self.node(c, m, depth + 1);
                    }
                }
            }
            "LOD" => {
                if let Some(c) = n.children().first() {
                    self.node(c, m, depth + 1);
                }
            }
            "Shape" => self.shape(n, m),
            "Inline" | "ExternProtoDeclare" | "ProtoDeclare" | "ProtoInstance" => {
                *self.skipped.entry(n.kind.clone()).or_insert(0) += 1;
            }
            _ => {}
        }
    }

    fn shape(&mut self, n: &Node, m: &Affine) {
        let color = n
            .child("appearance", &["Appearance"])
            .and_then(|a| a.child("material", &["Material"]))
            .and_then(|mat| mat.nums("diffuseColor").filter(|v| v.len() >= 3).map(|v| unit_color([v[0], v[1], v[2]])));
        const GEOMETRY: [&str; 4] = ["IndexedFaceSet", "IndexedTriangleSet", "TriangleSet", "Box"];
        let all = ["IndexedFaceSet", "IndexedTriangleSet", "TriangleSet", "Box", "Sphere", "Cylinder", "Cone", "Extrusion", "ElevationGrid", "Text"];
        let Some(g) = n.child("geometry", &all) else { return };
        if !GEOMETRY.contains(&g.kind.as_str()) {
            *self.skipped.entry(g.kind.clone()).or_insert(0) += 1;
            return;
        }
        let (points, tris): (Vec<f64>, Vec<i64>) = match g.kind.as_str() {
            "Box" => {
                let s = vec3(&g, "size", [2.0; 3]).map(|v| v / 2.0);
                let mut p = Vec::new();
                for k in 0..8 {
                    p.extend([
                        if k & 1 == 0 { -s[0] } else { s[0] },
                        if k & 2 == 0 { -s[1] } else { s[1] },
                        if k & 4 == 0 { -s[2] } else { s[2] },
                    ]);
                }
                let t = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
                (p, t.to_vec())
            }
            kind => {
                let pts = g
                    .child("coord", &["Coordinate", "CoordinateDouble"])
                    .and_then(|c| c.nums("point").map(<[f64]>::to_vec))
                    .unwrap_or_default();
                let nv = (pts.len() / 3) as i64;
                let mut t = Vec::new();
                match kind {
                    "IndexedFaceSet" => {
                        let mut face: Vec<i64> = Vec::new();
                        let ci = g.nums("coordIndex").unwrap_or(&[]);
                        for &i in ci.iter().chain(std::iter::once(&-1.0)) {
                            if i < 0.0 {
                                for k in 1..face.len().saturating_sub(1) {
                                    t.extend([face[0], face[k], face[k + 1]]);
                                }
                                face.clear();
                            } else {
                                face.push(i as i64);
                            }
                        }
                    }
                    "IndexedTriangleSet" => t.extend(g.nums("index").unwrap_or(&[]).iter().map(|&i| i as i64)),
                    _ => t.extend(0..nv),
                }
                t.truncate(t.len() / 3 * 3);
                if t.iter().any(|&i| i < 0 || i >= nv) {
                    *self.skipped.entry(format!("{kind} with a bad index")).or_insert(0) += 1;
                    return;
                }
                if !g.flag("ccw", true) {
                    for tri in t.chunks_exact_mut(3) {
                        tri.swap(1, 2);
                    }
                }
                (pts, t)
            }
        };
        let base = (self.pos.len() / 3) as u32;
        for p in points.chunks_exact(3) {
            for r in m {
                self.pos.push(r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]);
            }
        }
        self.idx.extend(tris.iter().map(|&i| base + i as u32));
        self.colors.extend(std::iter::repeat_n(color, tris.len() / 3));
    }
}

/// Each top level node of the scene as one object, Y up metres turned Z up
/// millimetres by the glTF rule.
fn objects(top: Vec<Rc<Node>>, mut notes: Vec<String>) -> (Vec<MeshObject>, Vec<String>) {
    let mut out = Vec::new();
    let mut skipped: HashMap<String, usize> = HashMap::new();
    for n in top {
        let mut w = Walk { pos: Vec::new(), idx: Vec::new(), colors: Vec::new(), skipped: HashMap::new() };
        w.node(&n, &ID, 0);
        for (k, v) in w.skipped {
            *skipped.entry(k).or_insert(0) += v;
        }
        if w.idx.is_empty() {
            continue;
        }
        out.push(MeshObject { name: n.def.clone(), color: dominant_color(w.colors.into_iter()), pos: w.pos, idx: w.idx });
    }
    let mut kinds: Vec<_> = skipped.into_iter().collect();
    kinds.sort();
    for (k, n) in kinds {
        notes.push(format!("{n} {k} node{} skipped, only triangle geometry and boxes are read", if n == 1 { " was" } else { "s were" }));
    }
    let all: Vec<f64> = out.iter().flat_map(|o| o.pos.iter().copied()).collect();
    let scale = if super::gltf::max_extent(&all) * 1000.0 > super::mesh::GLB_MM_AS_UNITS_ABOVE { 1.0 } else { 1000.0 };
    for o in &mut out {
        o.pos = o.pos.chunks_exact(3).flat_map(|p| [p[0] * scale, -p[2] * scale, p[1] * scale]).collect();
    }
    (out, notes)
}

pub fn read_vrml(text: &str) -> Result<(Vec<MeshObject>, Vec<String>), String> {
    let (top, skipped) = parse_vrml(text)?;
    let mut notes = Vec::new();
    if !skipped.is_empty() {
        notes.push(format!("{} ROUTE or PROTO statement{} skipped", skipped.len(), if skipped.len() == 1 { " was" } else { "s were" }));
    }
    Ok(objects(top, notes))
}

pub fn read_x3d(xml: &str) -> Result<(Vec<MeshObject>, Vec<String>), String> {
    Ok(objects(parse_x3d(xml)?, Vec::new()))
}
