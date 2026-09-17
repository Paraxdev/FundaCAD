//! Sketch text, replacing sidecar/sketch_build.py `_text_faces`,
//! `tessellate_text` and `list_fonts` (build123d `Text` over OCCT's
//! `Font_BRepTextBuilder`).
//!
//! Glyph outlines come from ttf-parser and are laid out here the way OCCT's
//! text formatter lays them out: advances plus legacy `kern` pairs, lines
//! centred on their own advance width, then the whole block aligned on its ink
//! box. Each outline segment becomes an exact line or Bezier edge, so the faces
//! agree with the Python engine's to the precision of the font's own metrics.

pub mod fonts;

use opencascade::primitives::Shape;
use opencascade_sys::sketch_ops as ffi;
use serde_json::{json, Value};
use ttf_parser::{Face, GlyphId, OutlineBuilder};

use fonts::{Aspect, Library};

pub type P = [f64; 2];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Seg {
    Line(P),
    Quad(P, P),
    Cubic(P, P, P),
}

impl Seg {
    fn end(&self) -> P {
        match *self {
            Seg::Line(e) | Seg::Quad(_, e) | Seg::Cubic(_, _, e) => e,
        }
    }

    fn map(&self, f: &impl Fn(P) -> P) -> Seg {
        match *self {
            Seg::Line(a) => Seg::Line(f(a)),
            Seg::Quad(a, b) => Seg::Quad(f(a), f(b)),
            Seg::Cubic(a, b, c) => Seg::Cubic(f(a), f(b), f(c)),
        }
    }

    fn at(&self, s: P, t: f64) -> P {
        let lerp = |a: P, b: P| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        match *self {
            Seg::Line(e) => lerp(s, e),
            Seg::Quad(c, e) => lerp(lerp(s, c), lerp(c, e)),
            Seg::Cubic(c1, c2, e) => {
                let (a, b, c) = (lerp(s, c1), lerp(c1, c2), lerp(c2, e));
                lerp(lerp(a, b), lerp(b, c))
            }
        }
    }

    /// Parameters in (0, 1) where x or y turns, for an exact box.
    fn turns(&self, s: P) -> Vec<f64> {
        let mut out = Vec::new();
        for k in 0..2 {
            match *self {
                Seg::Line(_) => {}
                Seg::Quad(c, e) => {
                    let d = s[k] - 2.0 * c[k] + e[k];
                    if d.abs() > 1e-15 {
                        out.push((s[k] - c[k]) / d);
                    }
                }
                Seg::Cubic(c1, c2, e) => {
                    let a = -s[k] + 3.0 * c1[k] - 3.0 * c2[k] + e[k];
                    let b = 2.0 * (s[k] - 2.0 * c1[k] + c2[k]);
                    let c = c1[k] - s[k];
                    if a.abs() < 1e-15 {
                        if b.abs() > 1e-15 {
                            out.push(-c / b);
                        }
                    } else {
                        let disc = b * b - 4.0 * a * c;
                        if disc >= 0.0 {
                            let r = disc.sqrt();
                            out.push((-b + r) / (2.0 * a));
                            out.push((-b - r) / (2.0 * a));
                        }
                    }
                }
            }
        }
        out.retain(|t| *t > 0.0 && *t < 1.0);
        out
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub start: P,
    pub segs: Vec<Seg>,
}

impl Contour {
    fn map(&self, f: &impl Fn(P) -> P) -> Contour {
        Contour {
            start: f(self.start),
            segs: self.segs.iter().map(|s| s.map(f)).collect(),
        }
    }

    fn pieces(&self) -> impl Iterator<Item = (P, &Seg)> {
        let starts = std::iter::once(self.start).chain(self.segs.iter().map(Seg::end));
        starts.zip(self.segs.iter())
    }

    fn polygon(&self, steps: usize) -> Vec<P> {
        let mut pts = vec![self.start];
        for (s, seg) in self.pieces() {
            let n = if matches!(seg, Seg::Line(_)) { 1 } else { steps };
            #[allow(clippy::cast_precision_loss)]
            pts.extend((1..=n).map(|i| seg.at(s, i as f64 / n as f64)));
        }
        pts
    }
}

/// One glyph's contours, placed.
#[derive(Debug, Clone, PartialEq)]
pub struct Glyph {
    pub contours: Vec<Contour>,
}

type BBox = [f64; 4];

fn bbox_of(glyphs: &[Glyph]) -> Option<BBox> {
    let mut b: Option<BBox> = None;
    let mut add = |p: P| {
        let bb = b.get_or_insert([p[0], p[1], p[0], p[1]]);
        bb[0] = bb[0].min(p[0]);
        bb[1] = bb[1].min(p[1]);
        bb[2] = bb[2].max(p[0]);
        bb[3] = bb[3].max(p[1]);
    };
    for g in glyphs {
        for c in &g.contours {
            add(c.start);
            for (s, seg) in c.pieces() {
                add(seg.end());
                for t in seg.turns(s) {
                    add(seg.at(s, t));
                }
            }
        }
    }
    b
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HAlign {
    Left,
    Center,
    Right,
}

/// A text entity with its numbers resolved.
#[derive(Debug, Clone)]
pub struct TextSpec {
    pub text: String,
    pub size: f64,
    pub font: Option<String>,
    pub aspect: Aspect,
    pub align: HAlign,
    pub rotation: f64,
    pub x: f64,
    pub y: f64,
    pub position_on_path: f64,
    pub box_width: Option<f64>,
}

impl TextSpec {
    /// `_text_faces` reading an entity whose numbers are already plain.
    pub fn from_json(e: &Value, num: &dyn Fn(Option<&Value>) -> f64) -> Option<TextSpec> {
        let text = e.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
        e.get("height")?;
        Some(TextSpec {
            text,
            size: num(e.get("height")),
            font: e
                .get("font")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            aspect: Aspect::from_style(e.get("style").and_then(Value::as_str).unwrap_or("regular")),
            align: match e.get("align").and_then(Value::as_str) {
                Some("center") => HAlign::Center,
                Some("right") => HAlign::Right,
                _ => HAlign::Left,
            },
            rotation: num(e.get("angle")),
            x: num(e.get("x")),
            y: num(e.get("y")),
            position_on_path: num(e.get("positionOnPath")),
            box_width: e.get("boxWidth").filter(|v| !v.is_null()).map(|v| num(Some(v))),
        })
    }
}

struct Outline {
    contours: Vec<Contour>,
    open: Option<Contour>,
    scale: f64,
    shear: f64,
    dx: f64,
    dy: f64,
}

impl Outline {
    fn p(&self, x: f32, y: f32) -> P {
        let (x, y) = (f64::from(x), f64::from(y));
        [(x + self.shear * y) * self.scale + self.dx, y * self.scale + self.dy]
    }

    fn push(&mut self, seg: Seg) {
        if let Some(c) = &mut self.open {
            c.segs.push(seg);
        }
    }
}

impl OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.close();
        self.open = Some(Contour {
            start: self.p(x, y),
            segs: Vec::new(),
        });
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let p = self.p(x, y);
        self.push(Seg::Line(p));
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (c, p) = (self.p(x1, y1), self.p(x, y));
        self.push(Seg::Quad(c, p));
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (c1, c2, p) = (self.p(x1, y1), self.p(x2, y2), self.p(x, y));
        self.push(Seg::Cubic(c1, c2, p));
    }

    fn close(&mut self) {
        if let Some(mut c) = self.open.take() {
            let last = c.segs.last().map_or(c.start, Seg::end);
            if last != c.start {
                c.segs.push(Seg::Line(c.start));
            }
            if !c.segs.is_empty() {
                self.contours.push(c);
            }
        }
    }
}

/// FreeType's `FT_GlyphSlot_Oblique` shear, what OCCT makes italic with.
const SYNTHETIC_SHEAR: f64 = 13_930.0 / 65_536.0;

fn kerning(face: &Face<'_>, left: GlyphId, right: GlyphId) -> f64 {
    let Some(kern) = face.tables().kern else {
        return 0.0;
    };
    kern.subtables
        .into_iter()
        .filter(|s| s.horizontal && !s.variable && !s.has_cross_stream)
        .filter_map(|s| s.glyphs_kerning(left, right))
        .map(f64::from)
        .sum()
}

/// The laid out, unaligned glyphs of `text`: `Font_TextFormatter` with both
/// alignments centred.
fn lay_out(face: &Face<'_>, text: &str, size: f64, synthetic_italic: bool) -> Vec<Glyph> {
    let upem = f64::from(face.units_per_em());
    let scale = size / upem;
    let hhea = face.tables().hhea;
    let spacing =
        (f64::from(hhea.ascender) - f64::from(hhea.descender) + f64::from(hhea.line_gap)) * scale;
    let shear = if synthetic_italic { SYNTHETIC_SHEAR } else { 0.0 };
    let mut out = Vec::new();
    for (row, line) in text.split('\n').enumerate() {
        let chars: Vec<char> = line.chars().filter(|c| *c != '\r').collect();
        let ids: Vec<Option<GlyphId>> = chars.iter().map(|c| face.glyph_index(*c)).collect();
        let mut pens = Vec::with_capacity(chars.len());
        let mut pen = 0.0;
        for (i, id) in ids.iter().enumerate() {
            pens.push(pen);
            let Some(id) = *id else { continue };
            let mut adv = face.glyph_hor_advance(id).map_or(0.0, f64::from);
            if let Some(Some(next)) = ids.get(i + 1) {
                adv += kerning(face, id, *next);
            }
            pen += adv * scale;
        }
        let shift = -pen / 2.0;
        #[allow(clippy::cast_precision_loss)]
        let base = -(row as f64) * spacing;
        for (id, x) in ids.iter().zip(pens) {
            let Some(id) = *id else { continue };
            let mut o = Outline {
                contours: Vec::new(),
                open: None,
                scale,
                shear,
                dx: x + shift,
                dy: base,
            };
            face.outline_glyph(id, &mut o);
            o.close();
            if !o.contours.is_empty() {
                out.push(Glyph {
                    contours: o.contours,
                });
            }
        }
    }
    out
}

/// A path the glyphs follow: its length, and point and tangent at a length fraction.
pub struct TextPath<'a> {
    pub edge: &'a Shape,
}

impl TextPath<'_> {
    fn at(&self, u: f64) -> Option<(P, P)> {
        let mut o = [0.0; 6];
        ffi::sk_edge_at(self.edge.raw(), u, &mut o).ok()?;
        Some(([o[0], o[1]], [o[3], o[4]]))
    }
}

fn with_face<T>(
    lib: &Library,
    spec: &TextSpec,
    f: impl FnOnce(&Face<'_>, bool) -> T,
) -> Option<T> {
    let resolved = lib.resolve(spec.font.as_deref().unwrap_or("Arial"), spec.aspect)?;
    let synthetic = resolved.synthetic_italic;
    let coords = resolved.face.coords.clone();
    lib.db.with_face_data(resolved.face.id, |data, index| {
        let mut face = Face::parse(data, index).ok()?;
        for (tag, v) in &coords {
            face.set_variation(*tag, *v);
        }
        Some(f(&face, synthetic))
    })?
}

fn ink_width(lib: &Library, spec: &TextSpec, s: &str) -> f64 {
    if s.trim().is_empty() {
        return 0.0;
    }
    with_face(lib, spec, |face, synth| {
        bbox_of(&lay_out(face, s, spec.size, synth)).map(|b| b[2] - b[0])
    })
    .flatten()
    .unwrap_or(1e9)
}

/// `_wrap_text`: greedy word wrap to `box_w`, explicit newlines kept.
fn wrap(lib: &Library, spec: &TextSpec, box_w: f64) -> String {
    if box_w <= 0.0 || spec.text.chars().count() > 400 {
        return spec.text.clone();
    }
    let mut lines = Vec::new();
    for para in spec.text.split('\n') {
        let mut line = String::new();
        for word in para.split(' ') {
            let cand = format!("{line} {word}").trim().to_owned();
            if !line.is_empty() && ink_width(lib, spec, &cand) > box_w {
                lines.push(std::mem::replace(&mut line, word.to_owned()));
            } else {
                line = cand;
            }
        }
        lines.push(line);
    }
    lines.join("\n")
}

/// The placed glyphs of a text entity, in sketch-local coordinates, or empty
/// where the Python engine's best effort gives nothing.
pub fn glyphs(spec: &TextSpec, path: Option<&TextPath<'_>>) -> Vec<Glyph> {
    if spec.text.trim().is_empty() || !(spec.size > 0.0) || !spec.size.is_finite() {
        return Vec::new();
    }
    let lib = fonts::library();
    let text = match spec.box_width {
        Some(w) if path.is_none() => wrap(lib, spec, w),
        _ => spec.text.clone(),
    };
    let Some(mut out) = with_face(lib, spec, |face, synth| lay_out(face, &text, spec.size, synth))
    else {
        return Vec::new();
    };
    let Some(b) = bbox_of(&out) else {
        return Vec::new();
    };
    let dx = match spec.align {
        HAlign::Left => -b[0],
        HAlign::Center => -(b[0] + b[2]) / 2.0,
        HAlign::Right => -b[2],
    };
    let dy = -(b[1] + b[3]) / 2.0;
    out = out
        .iter()
        .map(|g| place(g, &|p| [p[0] + dx, p[1] + dy]))
        .collect();

    if let Some(path) = path {
        let length = crate::kernel::length(path.edge);
        if !(length > 0.0) {
            return Vec::new();
        }
        let mut placed = Vec::with_capacity(out.len());
        for g in &out {
            let Some(gb) = bbox_of(std::slice::from_ref(g)) else {
                continue;
            };
            let cx = (gb[0] + gb[2]) / 2.0;
            let Some((at, d)) = path.at(spec.position_on_path + cx / length) else {
                return Vec::new();
            };
            if d[0] == 0.0 && d[1] == 0.0 {
                return Vec::new();
            }
            let (s, c) = d[1].atan2(d[0]).sin_cos();
            placed.push(place(g, &|p| {
                let (x, y) = (p[0] - cx, p[1]);
                [at[0] + x * c - y * s, at[1] + x * s + y * c]
            }));
        }
        out = placed;
    }
    if spec.rotation != 0.0 {
        let (s, c) = spec.rotation.to_radians().sin_cos();
        out = out
            .iter()
            .map(|g| place(g, &|p| [p[0] * c - p[1] * s, p[0] * s + p[1] * c]))
            .collect();
    }
    if path.is_none() && (spec.x != 0.0 || spec.y != 0.0) {
        let (x, y) = (spec.x, spec.y);
        out = out
            .iter()
            .map(|g| place(g, &|p| [p[0] + x, p[1] + y]))
            .collect();
    }
    out
}

fn place(g: &Glyph, f: &impl Fn(P) -> P) -> Glyph {
    Glyph {
        contours: g.contours.iter().map(|c| c.map(f)).collect(),
    }
}

fn signed_area(poly: &[P]) -> f64 {
    let n = poly.len();
    (0..n)
        .map(|i| {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
        / 2.0
}

fn inside(poly: &[P], p: P) -> bool {
    let mut odd = false;
    let n = poly.len();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + n - 1) % n]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            odd = !odd;
        }
    }
    odd
}

/// A glyph's contours grouped into faces: `(boundary, holes)`. A contour is a
/// hole of the smallest contour around it when that one bounds a face and
/// winds the other way, so both TrueType's and CFF's winding conventions work
/// and overlapping outlines of a variable font stay separate faces.
pub fn faces_of(g: &Glyph) -> Vec<(usize, Vec<usize>)> {
    let polys: Vec<Vec<P>> = g.contours.iter().map(|c| c.polygon(12)).collect();
    let areas: Vec<f64> = polys.iter().map(|p| signed_area(p)).collect();
    let mut order: Vec<usize> = (0..polys.len()).filter(|&i| areas[i].abs() > 1e-12).collect();
    order.sort_by(|&a, &b| areas[b].abs().total_cmp(&areas[a].abs()));
    let mut hole_of: Vec<Option<usize>> = vec![None; polys.len()];
    for (k, &i) in order.iter().enumerate() {
        let probe: Vec<P> = polys[i].iter().take(4).copied().collect();
        let parent = order[..k].iter().rev().copied().find(|&j| {
            let hits = probe.iter().filter(|p| inside(&polys[j], **p)).count();
            hits * 2 > probe.len()
        });
        if let Some(j) = parent {
            if hole_of[j].is_none() && areas[i].signum() != areas[j].signum() {
                hole_of[i] = Some(j);
            }
        }
    }
    let mut faces: Vec<(usize, Vec<usize>)> = Vec::new();
    for i in 0..polys.len() {
        if areas[i].abs() <= 1e-12 || hole_of[i].is_some() {
            continue;
        }
        let holes = (0..polys.len()).filter(|&h| hole_of[h] == Some(i)).collect();
        faces.push((i, holes));
    }
    faces
}

fn encode(contour: &Contour, data: &mut Vec<f64>) {
    #[allow(clippy::cast_precision_loss)]
    data.push(contour.segs.len() as f64);
    for (s, seg) in contour.pieces() {
        match *seg {
            Seg::Line(e) => data.extend([1.0, s[0], s[1], e[0], e[1]]),
            Seg::Quad(c, e) => data.extend([2.0, s[0], s[1], c[0], c[1], e[0], e[1]]),
            Seg::Cubic(c1, c2, e) => {
                data.extend([3.0, s[0], s[1], c1[0], c1[1], c2[0], c2[1], e[0], e[1]]);
            }
        }
    }
}

/// The OCCT faces of placed glyphs, at z = 0 facing +Z. A glyph that does
/// not make a face is left out.
pub fn build_faces(glyphs: &[Glyph]) -> Vec<Shape> {
    let mut out = Vec::new();
    for g in glyphs {
        for (outer, holes) in faces_of(g) {
            let mut data = Vec::new();
            #[allow(clippy::cast_precision_loss)]
            data.push((1 + holes.len()) as f64);
            encode(&g.contours[outer], &mut data);
            for h in &holes {
                encode(&g.contours[*h], &mut data);
            }
            if let Ok(p) = ffi::sk_glyph_face(&data) {
                if !p.is_null() {
                    out.push(Shape::from_raw(p));
                }
            }
        }
    }
    out
}

fn seg_length(s: P, seg: &Seg) -> f64 {
    let n = if matches!(seg, Seg::Line(_)) { 1 } else { 64 };
    let mut len = 0.0;
    let mut prev = s;
    for i in 1..=n {
        #[allow(clippy::cast_precision_loss)]
        let p = seg.at(s, f64::from(i) / f64::from(n));
        len += (p[0] - prev[0]).hypot(p[1] - prev[1]);
        prev = p;
    }
    len
}

/// A point at a length fraction along a segment.
fn seg_at_length(s: P, seg: &Seg, u: f64) -> P {
    if matches!(seg, Seg::Line(_)) {
        return seg.at(s, u);
    }
    const N: u32 = 64;
    let pts: Vec<P> = (0..=N).map(|i| seg.at(s, f64::from(i) / f64::from(N))).collect();
    let cum: Vec<f64> = std::iter::once(0.0)
        .chain(pts.windows(2).scan(0.0, |acc, w| {
            *acc += (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]);
            Some(*acc)
        }))
        .collect();
    let target = u * cum[N as usize];
    let k = cum.partition_point(|c| *c < target).clamp(1, N as usize);
    let span = cum[k] - cum[k - 1];
    let f = if span > 0.0 { (target - cum[k - 1]) / span } else { 0.0 };
    let (a, b) = (pts[k - 1], pts[k]);
    [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}

fn round4(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

/// `_wire_polyline`: each edge sampled by length, closed, 4 decimals.
fn polyline(c: &Contour, reverse: bool) -> Value {
    let mut contour = c.clone();
    if reverse {
        let mut pts = vec![c.start];
        pts.extend(c.segs.iter().map(Seg::end));
        let mut segs = Vec::with_capacity(c.segs.len());
        for (k, seg) in c.segs.iter().enumerate().rev() {
            let start = pts[k];
            segs.push(match *seg {
                Seg::Line(_) => Seg::Line(start),
                Seg::Quad(q, _) => Seg::Quad(q, start),
                Seg::Cubic(c1, c2, _) => Seg::Cubic(c2, c1, start),
            });
        }
        contour = Contour {
            start: *pts.last().unwrap_or(&c.start),
            segs,
        };
    }
    let mut pts: Vec<Value> = Vec::new();
    for (s, seg) in contour.pieces() {
        let len = seg_length(s, seg);
        if len < 1e-9 {
            continue;
        }
        #[allow(clippy::cast_possible_truncation)]
        let n = ((len / 0.3) as i64 + 2).clamp(2, 24);
        for i in 0..n {
            #[allow(clippy::cast_precision_loss)]
            let p = seg_at_length(s, seg, i as f64 / n as f64);
            pts.push(json!([round4(p[0]), round4(p[1])]));
        }
    }
    if let Some(first) = pts.first().cloned() {
        pts.push(first);
    }
    Value::Array(pts)
}

/// `tessellate_text`: per face its outer and hole polylines, outer anticlockwise.
pub fn tessellate(glyphs: &[Glyph]) -> Value {
    let mut faces = Vec::new();
    for g in glyphs {
        for (outer, holes) in faces_of(g) {
            let ccw = |i: usize| signed_area(&g.contours[i].polygon(12)) > 0.0;
            faces.push(json!({
                "outer": polyline(&g.contours[outer], !ccw(outer)),
                "holes": holes.iter().map(|&h| polyline(&g.contours[h], ccw(h))).collect::<Vec<_>>(),
            }));
        }
    }
    json!({ "faces": faces })
}

/// `list_fonts`.
pub fn list_fonts() -> Value {
    json!({ "families": fonts::library().families() })
}

fn as_map(v: Value) -> serde_json::Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    }
}

pub fn list_fonts_result() -> fundacad_protocol::JobResult {
    fundacad_protocol::JobResult::Json(as_map(list_fonts()))
}

/// `_num_or(x, 0.0)`: a number, a numeric string, else 0.
pub fn num_or_zero(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// server.py `_tessellate_text_job`.
pub fn tessellate_result(req: &serde_json::Map<String, Value>) -> fundacad_protocol::JobResult {
    let entity = req.get("entity").cloned().unwrap_or(Value::Null);
    let path_edge = req
        .get("pathEntity")
        .filter(|p| crate::select::entity::truthy(Some(p)))
        .and_then(crate::features::sketch::path_edge_json);
    let placed = match TextSpec::from_json(&entity, &num_or_zero) {
        Some(spec) => glyphs(&spec, path_edge.as_ref().map(|edge| TextPath { edge }).as_ref()),
        None => Vec::new(),
    };
    fundacad_protocol::JobResult::Json(as_map(tessellate(&placed)))
}
