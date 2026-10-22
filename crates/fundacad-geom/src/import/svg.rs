//! SVG drawings as sketches on XY in mm, Y up: one per top level group or
//! Inkscape layer, the filled outlines healed into closed profiles that a
//! sketch's even-odd fill extrudes with their holes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::f64::consts::{PI, TAU};

use roxmltree::{Document, Node};
use serde_json::{json, Value};
use svgtypes::{Length, LengthUnit, PathParser, PathSegment, PointsParser, Transform, ViewBox};

use super::dxf::MAX_SKETCH_ENTITIES;
use super::heal2d::{self, Filled, Seg, Sub, P};

const MAX_USE_DEPTH: usize = 16;
const MAX_ELEMENTS: usize = 200_000;
const SVG_NS: &str = "http://www.w3.org/2000/svg";
const INKSCAPE_NS: &str = "http://www.inkscape.org/namespaces/inkscape";

pub struct SvgSketch {
    /// None for shapes outside any top level group, named after the file by the caller.
    pub name: Option<String>,
    pub entities: Vec<Value>,
    pub evenodd: bool,
}

pub struct SvgRead {
    pub sketches: Vec<SvgSketch>,
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
struct Aff([f64; 6]);

impl Aff {
    const ID: Aff = Aff([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    fn then(&self, inner: &Aff) -> Aff {
        let [a, b, c, d, e, f] = self.0;
        let [a2, b2, c2, d2, e2, f2] = inner.0;
        Aff([
            a * a2 + c * b2,
            b * a2 + d * b2,
            a * c2 + c * d2,
            b * c2 + d * d2,
            a * e2 + c * f2 + e,
            b * e2 + d * f2 + f,
        ])
    }

    fn apply(&self, p: P) -> P {
        let [a, b, c, d, e, f] = self.0;
        [a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f]
    }

    fn det(&self) -> f64 {
        self.0[0] * self.0[3] - self.0[1] * self.0[2]
    }

    /// Uniform scale times a rotation or reflection, so circles stay circles.
    fn similarity(&self) -> bool {
        let [a, b, c, d, ..] = self.0;
        let (l1, l2) = (a.hypot(b), c.hypot(d));
        let s = l1.max(l2).max(1e-300);
        (l1 - l2).abs() <= 1e-9 * s && (a * c + b * d).abs() <= 1e-9 * s * s
    }

    fn translate(x: f64, y: f64) -> Aff {
        Aff([1.0, 0.0, 0.0, 1.0, x, y])
    }
}

fn parse_transform(s: Option<&str>) -> Aff {
    match s.and_then(|s| s.parse::<Transform>().ok()) {
        Some(t) => Aff([t.a, t.b, t.c, t.d, t.e, t.f]),
        None => Aff::ID,
    }
}

fn unit_mm(u: LengthUnit) -> Option<f64> {
    Some(match u {
        LengthUnit::None | LengthUnit::Px => 25.4 / 96.0,
        LengthUnit::Pt => 25.4 / 72.0,
        LengthUnit::Pc => 25.4 / 6.0,
        LengthUnit::In => 25.4,
        LengthUnit::Cm => 10.0,
        LengthUnit::Mm => 1.0,
        LengthUnit::Em => 16.0 * 25.4 / 96.0,
        LengthUnit::Ex => 8.0 * 25.4 / 96.0,
        LengthUnit::Percent => return None,
    })
}

fn length_mm(s: Option<&str>) -> Option<f64> {
    let l = s?.trim().parse::<Length>().ok()?;
    Some(l.number * unit_mm(l.unit)?).filter(|v| *v > 0.0)
}

/// A length inside the drawing, in user units.
fn user(n: Node, attr: &str) -> f64 {
    n.attribute(attr)
        .and_then(|s| s.trim().parse::<Length>().ok())
        .and_then(|l| unit_mm(l.unit).map(|k| l.number * k / (25.4 / 96.0)))
        .unwrap_or(0.0)
}

#[derive(Clone, Debug, PartialEq)]
enum Paint {
    None,
    Color(String),
    Url,
}

#[derive(Clone, Debug)]
struct Style {
    fill: Paint,
    evenodd: bool,
    stroke: bool,
    visible: bool,
}

#[derive(Default)]
struct Css {
    rules: Vec<(String, Vec<(String, String)>)>,
}

fn declarations(text: &str) -> Vec<(String, String)> {
    text.split(';')
        .filter_map(|d| d.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().trim_end_matches("!important").trim().to_string()))
        .collect()
}

impl Css {
    fn parse(doc: &Document) -> Css {
        let mut css = Css::default();
        for n in doc.descendants().filter(|n| n.has_tag_name((SVG_NS, "style")) || n.tag_name().name() == "style") {
            let mut text: String = n.children().filter_map(|c| c.text()).collect();
            while let Some(a) = text.find("/*") {
                let b = text[a..].find("*/").map_or(text.len(), |b| a + b + 2);
                text.replace_range(a..b, "");
            }
            for block in text.split('}') {
                let Some((sel, body)) = block.split_once('{') else { continue };
                let decls = declarations(body);
                for s in sel.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    if !s.contains([' ', '>', ':', '[', '+', '~']) {
                        css.rules.push((s.to_string(), decls.clone()));
                    }
                }
            }
        }
        css
    }

    fn get(&self, n: Node, prop: &str) -> Option<String> {
        let classes: Vec<&str> = n.attribute("class").map(|c| c.split_whitespace().collect()).unwrap_or_default();
        let id = n.attribute("id");
        let tag = n.tag_name().name();
        let mut best: Option<(u8, String)> = None;
        for (sel, decls) in &self.rules {
            let rank = if let Some(c) = sel.strip_prefix('.') {
                if !classes.contains(&c) {
                    continue;
                }
                2
            } else if let Some(i) = sel.strip_prefix('#') {
                if id != Some(i) {
                    continue;
                }
                3
            } else if sel == tag || sel == "*" {
                1
            } else {
                continue;
            };
            if let Some((_, v)) = decls.iter().rev().find(|(k, _)| k == prop) {
                if best.as_ref().is_none_or(|(r, _)| rank >= *r) {
                    best = Some((rank, v.clone()));
                }
            }
        }
        best.map(|(_, v)| v)
    }
}

struct Ctx<'a> {
    css: Css,
    ids: HashMap<&'a str, Node<'a, 'a>>,
    skipped: BTreeMap<&'static str, usize>,
    ignored: BTreeMap<&'static str, usize>,
    paint_urls: usize,
    colours: HashSet<String>,
    curves: usize,
    elements: usize,
}

struct Group {
    name: Option<String>,
    filled: Vec<Filled>,
    strokes: Vec<Sub>,
}

impl<'a> Ctx<'a> {
    fn prop(&self, n: Node, name: &str) -> Option<String> {
        if let Some(v) = n
            .attribute("style")
            .and_then(|s| declarations(s).into_iter().rev().find(|(k, _)| k == name).map(|(_, v)| v))
        {
            return Some(v);
        }
        self.css.get(n, name).or_else(|| n.attribute(name).map(|s| s.trim().to_string()))
    }

    fn style(&self, n: Node, parent: &Style) -> Style {
        let mut s = parent.clone();
        if let Some(f) = self.prop(n, "fill") {
            s.fill = match f.as_str() {
                "none" | "transparent" => Paint::None,
                "inherit" => parent.fill.clone(),
                u if u.starts_with("url(") => Paint::Url,
                c => Paint::Color(c.to_ascii_lowercase()),
            };
        }
        if let Some(r) = self.prop(n, "fill-rule") {
            s.evenodd = r == "evenodd";
        }
        if let Some(st) = self.prop(n, "stroke") {
            s.stroke = st != "none" && st != "transparent";
        }
        if let Some(v) = self.prop(n, "visibility") {
            s.visible = !(v == "hidden" || v == "collapse");
        }
        if self.prop(n, "fill-opacity").and_then(|o| o.parse::<f64>().ok()) == Some(0.0)
            || self.prop(n, "opacity").and_then(|o| o.parse::<f64>().ok()) == Some(0.0)
        {
            s.fill = Paint::None;
        }
        s
    }

    fn walk(&mut self, n: Node<'a, 'a>, m: Aff, parent: &Style, depth: usize, out: &mut Group) -> Result<(), String> {
        if !n.is_element() || (n.tag_name().namespace().is_some_and(|ns| ns != SVG_NS)) {
            return Ok(());
        }
        if self.prop(n, "display").as_deref() == Some("none") {
            return Ok(());
        }
        self.elements += 1;
        if self.elements > MAX_ELEMENTS {
            return Err(format!("this SVG expands to more than {MAX_ELEMENTS} elements through <use>"));
        }
        let tag = n.tag_name().name();
        match tag {
            "text" | "image" | "foreignObject" | "video" | "audio" => {
                *self
                    .skipped
                    .entry(match tag {
                        "text" => "text",
                        "image" => "image",
                        _ => "embedded object",
                    })
                    .or_default() += 1;
                return Ok(());
            }
            "defs" | "symbol" | "clipPath" | "mask" | "marker" | "pattern" | "linearGradient" | "radialGradient"
            | "filter" | "style" | "title" | "desc" | "metadata" | "script" => return Ok(()),
            _ => {}
        }
        for (attr, what) in [("filter", "filter"), ("clip-path", "clip path"), ("mask", "mask")] {
            if self.prop(n, attr).is_some_and(|v| v != "none") {
                *self.ignored.entry(what).or_default() += 1;
            }
        }
        let style = self.style(n, parent);
        let m = m.then(&parse_transform(n.attribute("transform")));
        match tag {
            "g" | "a" | "switch" => {
                for c in n.children() {
                    self.walk(c, m, &style, depth, out)?;
                }
            }
            "svg" => {
                let m = m.then(&Aff::translate(user(n, "x"), user(n, "y")));
                for c in n.children() {
                    self.walk(c, m, &style, depth, out)?;
                }
            }
            "use" => {
                if depth >= MAX_USE_DEPTH {
                    return Err(format!("this SVG nests <use> deeper than {MAX_USE_DEPTH} levels"));
                }
                let href = n.attribute("href").or_else(|| n.attribute(("http://www.w3.org/1999/xlink", "href")));
                let Some(target) = href.and_then(|h| h.strip_prefix('#')).and_then(|id| self.ids.get(id).copied())
                else {
                    return Ok(());
                };
                let m = m.then(&Aff::translate(user(n, "x"), user(n, "y")));
                if target.tag_name().name() == "symbol" {
                    let style = self.style(target, &style);
                    for c in target.children() {
                        self.walk(c, m, &style, depth + 1, out)?;
                    }
                } else {
                    self.walk(target, m, &style, depth + 1, out)?;
                }
            }
            _ => {
                let Some((subs, area)) = shape(n, &m) else { return Ok(()) };
                if !style.visible || subs.is_empty() {
                    return Ok(());
                }
                self.curves += subs.iter().map(|s| s.segs.len()).sum::<usize>();
                if self.curves > MAX_SKETCH_ENTITIES {
                    return Err(format!(
                        "this SVG has more than {MAX_SKETCH_ENTITIES} curves, simplify it before importing"
                    ));
                }
                match (&style.fill, area) {
                    (Paint::None, _) | (_, false) => {
                        if style.stroke || !area {
                            out.strokes.extend(subs);
                        }
                    }
                    (paint, true) => {
                        match paint {
                            Paint::Url => self.paint_urls += 1,
                            Paint::Color(c) => {
                                self.colours.insert(c.clone());
                            }
                            Paint::None => {}
                        }
                        out.filled.push(Filled { subs, evenodd: style.evenodd });
                    }
                }
            }
        }
        Ok(())
    }
}

fn arc_segs(out: &mut Vec<Seg>, m: &Aff, c: P, rx: f64, ry: f64, phi: f64, t0: f64, dt: f64) {
    let (cp, sp) = (phi.cos(), phi.sin());
    let local = |t: f64| [c[0] + cp * rx * t.cos() - sp * ry * t.sin(), c[1] + sp * rx * t.cos() + cp * ry * t.sin()];
    if (rx - ry).abs() <= 1e-9 * rx.max(ry) && m.similarity() {
        let cc = m.apply(c);
        let p0 = m.apply(local(t0));
        let a0 = (p0[1] - cc[1]).atan2(p0[0] - cc[0]);
        out.push(Seg::Arc { c: cc, r: rx * m.det().abs().sqrt(), a0, sweep: dt * m.det().signum() });
        return;
    }
    let tan = |t: f64| [-cp * rx * t.sin() - sp * ry * t.cos(), -sp * rx * t.sin() + cp * ry * t.cos()];
    let n = (dt.abs() / (PI / 4.0)).ceil().max(1.0) as usize;
    let h = dt / n as f64;
    let k = 4.0 / 3.0 * (h / 4.0).tan();
    for i in 0..n {
        let (a, b) = (t0 + h * i as f64, t0 + h * (i + 1) as f64);
        let (pa, pb, da, db) = (local(a), local(b), tan(a), tan(b));
        out.push(Seg::Cubic(
            m.apply(pa),
            m.apply([pa[0] + k * da[0], pa[1] + k * da[1]]),
            m.apply([pb[0] - k * db[0], pb[1] - k * db[1]]),
            m.apply(pb),
        ));
    }
}

/// SVG F.6.5: an endpoint arc as centre, radii and angles.
#[allow(clippy::too_many_arguments)]
fn svg_arc(out: &mut Vec<Seg>, m: &Aff, p1: P, p2: P, rx: f64, ry: f64, rot_deg: f64, large: bool, sweep: bool) {
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 || p1 == p2 {
        if p1 != p2 {
            out.push(Seg::Line(m.apply(p1), m.apply(p2)));
        }
        return;
    }
    let phi = rot_deg.to_radians();
    let (cp, sp) = (phi.cos(), phi.sin());
    let (dx, dy) = ((p1[0] - p2[0]) / 2.0, (p1[1] - p2[1]) / 2.0);
    let (x1, y1) = (cp * dx + sp * dy, -sp * dx + cp * dy);
    let lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lam > 1.0 {
        rx *= lam.sqrt();
        ry *= lam.sqrt();
    }
    let num = (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1).max(0.0);
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut co = if den > 0.0 { (num / den).sqrt() } else { 0.0 };
    if large == sweep {
        co = -co;
    }
    let (cx1, cy1) = (co * rx * y1 / ry, -co * ry * x1 / rx);
    let c = [cp * cx1 - sp * cy1 + (p1[0] + p2[0]) / 2.0, sp * cx1 + cp * cy1 + (p1[1] + p2[1]) / 2.0];
    let ang = |ux: f64, uy: f64| uy.atan2(ux);
    let t0 = ang((x1 - cx1) / rx, (y1 - cy1) / ry);
    let t1 = ang((-x1 - cx1) / rx, (-y1 - cy1) / ry);
    let mut dt = t1 - t0;
    if sweep && dt < 0.0 {
        dt += TAU;
    } else if !sweep && dt > 0.0 {
        dt -= TAU;
    }
    arc_segs(out, m, c, rx, ry, phi, t0, dt);
}

fn path_subs(d: &str, m: &Aff) -> Vec<Sub> {
    let mut subs: Vec<Sub> = Vec::new();
    let mut cur = Sub::default();
    let (mut p, mut start) = ([0.0, 0.0], [0.0, 0.0]);
    let mut last_ctrl: Option<(P, bool)> = None;
    let flush = |cur: &mut Sub, subs: &mut Vec<Sub>| {
        if !cur.segs.is_empty() {
            subs.push(std::mem::take(cur));
        }
        cur.closed = false;
    };
    for seg in PathParser::from(d) {
        let Ok(seg) = seg else { break };
        let rel = |abs: bool, x: f64, y: f64, p: P| if abs { [x, y] } else { [p[0] + x, p[1] + y] };
        let mut ctrl: Option<(P, bool)> = None;
        match seg {
            PathSegment::MoveTo { abs, x, y } => {
                flush(&mut cur, &mut subs);
                p = rel(abs, x, y, p);
                start = p;
            }
            PathSegment::LineTo { abs, x, y } => {
                let q = rel(abs, x, y, p);
                cur.segs.push(Seg::Line(m.apply(p), m.apply(q)));
                p = q;
            }
            PathSegment::HorizontalLineTo { abs, x } => {
                let q = if abs { [x, p[1]] } else { [p[0] + x, p[1]] };
                cur.segs.push(Seg::Line(m.apply(p), m.apply(q)));
                p = q;
            }
            PathSegment::VerticalLineTo { abs, y } => {
                let q = if abs { [p[0], y] } else { [p[0], p[1] + y] };
                cur.segs.push(Seg::Line(m.apply(p), m.apply(q)));
                p = q;
            }
            PathSegment::CurveTo { abs, x1, y1, x2, y2, x, y } => {
                let (c1, c2, q) = (rel(abs, x1, y1, p), rel(abs, x2, y2, p), rel(abs, x, y, p));
                cur.segs.push(Seg::Cubic(m.apply(p), m.apply(c1), m.apply(c2), m.apply(q)));
                ctrl = Some((c2, true));
                p = q;
            }
            PathSegment::SmoothCurveTo { abs, x2, y2, x, y } => {
                let c1 = match last_ctrl {
                    Some((c, true)) => [2.0 * p[0] - c[0], 2.0 * p[1] - c[1]],
                    _ => p,
                };
                let (c2, q) = (rel(abs, x2, y2, p), rel(abs, x, y, p));
                cur.segs.push(Seg::Cubic(m.apply(p), m.apply(c1), m.apply(c2), m.apply(q)));
                ctrl = Some((c2, true));
                p = q;
            }
            PathSegment::Quadratic { abs, x1, y1, x, y } => {
                let (c1, q) = (rel(abs, x1, y1, p), rel(abs, x, y, p));
                cur.segs.push(Seg::Quad(m.apply(p), m.apply(c1), m.apply(q)));
                ctrl = Some((c1, false));
                p = q;
            }
            PathSegment::SmoothQuadratic { abs, x, y } => {
                let c1 = match last_ctrl {
                    Some((c, false)) => [2.0 * p[0] - c[0], 2.0 * p[1] - c[1]],
                    _ => p,
                };
                let q = rel(abs, x, y, p);
                cur.segs.push(Seg::Quad(m.apply(p), m.apply(c1), m.apply(q)));
                ctrl = Some((c1, false));
                p = q;
            }
            PathSegment::EllipticalArc { abs, rx, ry, x_axis_rotation, large_arc, sweep, x, y } => {
                let q = rel(abs, x, y, p);
                svg_arc(&mut cur.segs, m, p, q, rx, ry, x_axis_rotation, large_arc, sweep);
                p = q;
            }
            PathSegment::ClosePath { .. } => {
                if p != start {
                    cur.segs.push(Seg::Line(m.apply(p), m.apply(start)));
                }
                cur.closed = true;
                flush(&mut cur, &mut subs);
                p = start;
            }
        }
        last_ctrl = ctrl;
    }
    flush(&mut cur, &mut subs);
    subs
}

fn poly(points: &str, m: &Aff, closed: bool) -> Vec<Sub> {
    let pts: Vec<P> = PointsParser::from(points).map(|(x, y)| m.apply([x, y])).collect();
    let segs: Vec<Seg> = pts.windows(2).map(|w| Seg::Line(w[0], w[1])).collect();
    let mut sub = Sub { segs, closed: false };
    if closed && pts.len() > 2 {
        sub.segs.push(Seg::Line(pts[pts.len() - 1], pts[0]));
        sub.closed = true;
    }
    vec![sub]
}

fn ellipse(m: &Aff, c: P, rx: f64, ry: f64) -> Vec<Sub> {
    if !(rx > 0.0 && ry > 0.0) {
        return vec![];
    }
    let mut segs = Vec::new();
    arc_segs(&mut segs, m, c, rx, ry, 0.0, 0.0, TAU);
    vec![Sub { segs, closed: true }]
}

/// A shape element's outlines in mm, and whether it can hold an area.
fn shape(n: Node, m: &Aff) -> Option<(Vec<Sub>, bool)> {
    Some(match n.tag_name().name() {
        "path" => (path_subs(n.attribute("d").unwrap_or(""), m), true),
        "polygon" => (poly(n.attribute("points").unwrap_or(""), m, true), true),
        "polyline" => (poly(n.attribute("points").unwrap_or(""), m, false), true),
        "line" => {
            let (a, b) = ([user(n, "x1"), user(n, "y1")], [user(n, "x2"), user(n, "y2")]);
            (vec![Sub { segs: vec![Seg::Line(m.apply(a), m.apply(b))], closed: false }], false)
        }
        "circle" => {
            let r = user(n, "r");
            (ellipse(m, [user(n, "cx"), user(n, "cy")], r, r), true)
        }
        "ellipse" => (ellipse(m, [user(n, "cx"), user(n, "cy")], user(n, "rx"), user(n, "ry")), true),
        "rect" => {
            let (x, y, w, h) = (user(n, "x"), user(n, "y"), user(n, "width"), user(n, "height"));
            if !(w > 0.0 && h > 0.0) {
                return Some((vec![], true));
            }
            let (has_rx, has_ry) = (n.attribute("rx").is_some(), n.attribute("ry").is_some());
            let (mut rx, mut ry) = (user(n, "rx"), user(n, "ry"));
            if has_rx && !has_ry {
                ry = rx;
            } else if has_ry && !has_rx {
                rx = ry;
            }
            let (rx, ry) = (rx.clamp(0.0, w / 2.0), ry.clamp(0.0, h / 2.0));
            let mut segs = Vec::new();
            let line = |a: P, b: P, segs: &mut Vec<Seg>| {
                if a != b {
                    segs.push(Seg::Line(m.apply(a), m.apply(b)));
                }
            };
            if rx > 0.0 && ry > 0.0 {
                line([x + rx, y], [x + w - rx, y], &mut segs);
                arc_segs(&mut segs, m, [x + w - rx, y + ry], rx, ry, 0.0, -PI / 2.0, PI / 2.0);
                line([x + w, y + ry], [x + w, y + h - ry], &mut segs);
                arc_segs(&mut segs, m, [x + w - rx, y + h - ry], rx, ry, 0.0, 0.0, PI / 2.0);
                line([x + w - rx, y + h], [x + rx, y + h], &mut segs);
                arc_segs(&mut segs, m, [x + rx, y + h - ry], rx, ry, 0.0, PI / 2.0, PI / 2.0);
                line([x, y + h - ry], [x, y + ry], &mut segs);
                arc_segs(&mut segs, m, [x + rx, y + ry], rx, ry, 0.0, PI, PI / 2.0);
            } else {
                line([x, y], [x + w, y], &mut segs);
                line([x + w, y], [x + w, y + h], &mut segs);
                line([x + w, y + h], [x, y + h], &mut segs);
                line([x, y + h], [x, y], &mut segs);
            }
            (vec![Sub { segs, closed: true }], true)
        }
        _ => return None,
    })
}

/// The page's user units to mm, with Y flipped so the drawing stands upright.
fn root_matrix(root: Node) -> Aff {
    let vb = root.attribute("viewBox").and_then(|v| v.parse::<ViewBox>().ok()).filter(|v| v.w > 0.0 && v.h > 0.0);
    let px = 25.4 / 96.0;
    let (w, h) = (length_mm(root.attribute("width")), length_mm(root.attribute("height")));
    let Some(vb) = vb else {
        let h = h.unwrap_or(0.0);
        return Aff([px, 0.0, 0.0, -px, 0.0, h]);
    };
    let (w, h) = match (w, h) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, w * vb.h / vb.w),
        (None, Some(h)) => (h * vb.w / vb.h, h),
        (None, None) => (vb.w * px, vb.h * px),
    };
    let par = root.attribute("preserveAspectRatio").unwrap_or("xMidYMid meet");
    let (mut sx, mut sy) = (w / vb.w, h / vb.h);
    let (mut tx, mut ty) = (0.0, 0.0);
    if !par.trim_start().starts_with("none") {
        let s = if par.contains("slice") { sx.max(sy) } else { sx.min(sy) };
        let fx = if par.contains("xMin") {
            0.0
        } else if par.contains("xMax") {
            1.0
        } else {
            0.5
        };
        let fy = if par.contains("YMin") {
            0.0
        } else if par.contains("YMax") {
            1.0
        } else {
            0.5
        };
        tx = (w - vb.w * s) * fx;
        ty = (h - vb.h * s) * fy;
        sx = s;
        sy = s;
    }
    Aff([sx, 0.0, 0.0, -sy, tx - sx * vb.x, h - ty + sy * vb.y])
}

fn pt(p: P) -> Value {
    json!({"x": p[0], "y": p[1]})
}

fn collinear(pts: &[P], tol: f64) -> bool {
    let (a, b) = (pts[0], pts[pts.len() - 1]);
    let l = (b[0] - a[0]).hypot(b[1] - a[1]);
    l > tol
        && pts.iter().all(|p| ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])).abs() / l <= tol)
        && pts.windows(2).all(|w| (w[1][0] - w[0][0]) * (b[0] - a[0]) + (w[1][1] - w[0][1]) * (b[1] - a[1]) >= 0.0)
}

fn entities(segs: &[Seg], tol: f64) -> Vec<Value> {
    let mut out = Vec::new();
    for s in segs {
        let full = matches!(s, Seg::Arc { sweep, .. } if sweep.abs() >= TAU - 1e-9);
        if let (true, Seg::Arc { c, r, .. }) = (full, s) {
            out.push(json!({"type": "circle", "x": c[0], "y": c[1], "radius": r}));
            continue;
        }
        for piece in heal2d::arc_halves(s) {
            out.push(match piece {
                Seg::Line(a, b) => json!({"type": "line", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]}),
                Seg::Arc { .. } => {
                    let (a, b, mid) = (piece.start(), piece.end(), piece.at(0.5));
                    json!({"type": "arc", "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1], "mx": mid[0], "my": mid[1]})
                }
                Seg::Quad(a, b, c) if collinear(&[a, b, c], tol) => {
                    json!({"type": "line", "x1": a[0], "y1": a[1], "x2": c[0], "y2": c[1]})
                }
                Seg::Cubic(a, b, c, d) if collinear(&[a, b, c, d], tol) => {
                    json!({"type": "line", "x1": a[0], "y1": a[1], "x2": d[0], "y2": d[1]})
                }
                Seg::Quad(a, b, c) => json!({"type": "bspline", "degree": 2, "poles": [pt(a), pt(b), pt(c)]}),
                Seg::Cubic(a, b, c, d) => {
                    json!({"type": "bspline", "degree": 3, "poles": [pt(a), pt(b), pt(c), pt(d)]})
                }
            });
        }
    }
    for (i, e) in out.iter_mut().enumerate() {
        e["id"] = json!(format!("e{}", i + 1));
    }
    out
}

fn diagonal(segs: impl Iterator<Item = Seg>) -> f64 {
    let b = segs.map(|s| s.hull()).fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, h| {
        [b[0].min(h[0]), b[1].min(h[1]), b[2].max(h[2]), b[3].max(h[3])]
    });
    if b[0] > b[2] {
        0.0
    } else {
        (b[2] - b[0]).hypot(b[3] - b[1])
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn read_svg(data: &[u8]) -> Result<SvgRead, String> {
    let text = String::from_utf8_lossy(data);
    let opts = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = Document::parse_with_options(&text, opts).map_err(|e| format!("this SVG is not valid XML: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        return Err("this file has no <svg> root element".into());
    }
    let mut ctx = Ctx {
        css: Css::parse(&doc),
        ids: doc.descendants().filter_map(|n| n.attribute("id").map(|id| (id, n))).collect(),
        skipped: BTreeMap::new(),
        ignored: BTreeMap::new(),
        paint_urls: 0,
        colours: HashSet::new(),
        curves: 0,
        elements: 0,
    };
    let m = root_matrix(root);
    let base = Style { fill: Paint::Color("black".into()), evenodd: false, stroke: false, visible: true };
    let style = ctx.style(root, &base);
    let mut loose = Group { name: None, filled: vec![], strokes: vec![] };
    let mut groups = Vec::new();
    for c in root.children() {
        if c.is_element() && c.tag_name().name() == "g" && c.tag_name().namespace() == Some(SVG_NS) {
            let name = c
                .attribute((INKSCAPE_NS, "label"))
                .or_else(|| c.attribute("id"))
                .map(str::to_string)
                .unwrap_or_else(|| format!("Group {}", groups.len() + 1));
            let mut g = Group { name: Some(name), filled: vec![], strokes: vec![] };
            ctx.walk(c, m, &style, 0, &mut g)?;
            groups.push(g);
        } else {
            ctx.walk(c, m, &style, 0, &mut loose)?;
        }
    }
    groups.insert(0, loose);
    groups.retain(|g| !g.filled.is_empty() || !g.strokes.is_empty());
    let mut notes = Vec::new();
    let (mut gaps, mut lines, mut split, mut dropped, mut open, mut stroke_outlines) = (0, 0, 0, 0, 0, 0);
    let mut sketches = Vec::new();
    for mut g in groups {
        let d = diagonal(
            g.filled
                .iter()
                .flat_map(|f| f.subs.iter().flat_map(|s| s.segs.iter().copied()))
                .chain(g.strokes.iter().flat_map(|s| s.segs.iter().copied())),
        );
        let tol = heal2d::tolerances(d);
        let mut stroke_segs = Vec::new();
        for sub in &mut g.strokes {
            heal2d::close_sub(sub, &tol, false);
            stroke_outlines += usize::from(!sub.segs.is_empty());
            stroke_segs.extend(sub.segs.iter().copied());
        }
        let has_fill = !g.filled.is_empty();
        if has_fill {
            let healed = heal2d::heal(&mut g.filled, &tol);
            gaps += healed.gaps_closed;
            lines += healed.lines_added;
            split += healed.crossings_split;
            dropped += healed.dropped;
            open += healed.open_ends;
            if !healed.segs.is_empty() {
                sketches.push(SvgSketch {
                    name: g.name.clone(),
                    entities: entities(&healed.segs, tol.join),
                    evenodd: true,
                });
            }
        }
        if !stroke_segs.is_empty() {
            let name = match (&g.name, has_fill) {
                (n, false) => n.clone(),
                (Some(n), true) => Some(format!("{n} strokes")),
                (None, true) => Some("Strokes".into()),
            };
            sketches.push(SvgSketch { name, entities: entities(&stroke_segs, tol.join), evenodd: false });
        }
    }
    if !ctx.skipped.is_empty() {
        let parts: Vec<String> = ctx.skipped.iter().map(|(k, n)| format!("{n} {k}")).collect();
        notes.push(format!("skipped {}", parts.join(", ")));
    }
    if !ctx.ignored.is_empty() {
        let parts: Vec<String> = ctx.ignored.iter().map(|(k, n)| plural(*n, k, &format!("{k}s"))).collect();
        notes.push(format!("ignored {}, the shapes under them are kept whole", parts.join(", ")));
    }
    if ctx.paint_urls > 0 {
        notes.push(format!(
            "{} kept as plain fills",
            plural(ctx.paint_urls, "gradient or pattern fill", "gradient or pattern fills")
        ));
    }
    if ctx.colours.len() > 1 {
        notes.push(format!(
            "{} fill colours, every filled shape became material, a light shape on top is not cut out",
            ctx.colours.len()
        ));
    }
    if gaps > 0 {
        notes.push(format!("closed {}", plural(gaps, "small gap", "small gaps")));
    }
    if lines > 0 {
        notes.push(format!(
            "closed {} with a straight line",
            plural(lines, "open filled outline", "open filled outlines")
        ));
    }
    if split > 0 {
        notes.push(format!("split {} where outlines cross", plural(split, "crossing", "crossings")));
    }
    if dropped > 0 {
        notes.push(format!(
            "dropped {} inside a filled area, duplicated or of zero length",
            plural(dropped, "piece", "pieces")
        ));
    }
    if open > 0 {
        notes.push(format!("{} where nothing else meets", plural(open, "open end", "open ends")));
    }
    if stroke_outlines > 0 {
        notes.push(format!(
            "{} drawn as strokes only, kept as curves without a thickness",
            plural(stroke_outlines, "outline is", "outlines are")
        ));
    }
    Ok(SvgRead { sketches, notes })
}
