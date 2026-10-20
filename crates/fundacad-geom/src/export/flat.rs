//! 2D export: a sketch, or one flat face, drawn in its own plane as a DXF R12
//! or an SVG drawing at true size in millimetres.

use std::f64::consts::{PI, TAU};
use std::fmt::Write as _;
use std::path::Path;

use fundacad_core::schema::Feature;
use fundacad_core::CadDocument;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, CurveType};
use opencascade_sys::face_query as fq;
use serde_json::{json, Map, Value};

use crate::builder::{self, Ctx, Fail, FResult, Watch};
use crate::features::sketch::{frame_for_normal, local_curves};
use crate::kernel::{self, Frame, Kind};
use crate::select::Resolver;

pub const TOL_DEFAULT: f64 = 0.01;
const TOL_MIN: f64 = 0.0001;
const TOL_MAX: f64 = 1.0;
const MAX_POINTS_PER_EDGE: usize = 20_000;
const MAX_POINTS: usize = 500_000;
const JOIN: f64 = 1e-4;
const SVG_MARGIN: f64 = 0.5;

pub fn is_flat_format(format: &str) -> bool {
    matches!(format, "dxf" | "svg")
}

#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Line([f64; 2], [f64; 2]),
    /// Signed sweep in radians, counterclockwise positive.
    Arc { c: [f64; 2], r: f64, a0: f64, sweep: f64 },
    Circle { c: [f64; 2], r: f64 },
    Poly(Vec<[f64; 2]>),
}

fn polar(c: [f64; 2], r: f64, a: f64) -> [f64; 2] {
    [c[0] + r * a.cos(), c[1] + r * a.sin()]
}

fn near(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).hypot(a[1] - b[1]) <= JOIN
}

impl Seg {
    pub fn start(&self) -> [f64; 2] {
        match self {
            Seg::Line(a, _) => *a,
            Seg::Arc { c, r, a0, .. } => polar(*c, *r, *a0),
            Seg::Circle { c, r } => [c[0] + r, c[1]],
            Seg::Poly(p) => p[0],
        }
    }

    pub fn end(&self) -> [f64; 2] {
        match self {
            Seg::Line(_, b) => *b,
            Seg::Arc { c, r, a0, sweep } => polar(*c, *r, a0 + sweep),
            Seg::Circle { .. } => self.start(),
            Seg::Poly(p) => p[p.len() - 1],
        }
    }

    fn reversed(&self) -> Seg {
        match self {
            Seg::Line(a, b) => Seg::Line(*b, *a),
            Seg::Arc { c, r, a0, sweep } => Seg::Arc { c: *c, r: *r, a0: a0 + sweep, sweep: -sweep },
            Seg::Circle { .. } => self.clone(),
            Seg::Poly(p) => Seg::Poly(p.iter().rev().copied().collect()),
        }
    }

    fn grow(&self, b: &mut [f64; 4]) {
        let mut add = |p: [f64; 2]| {
            b[0] = b[0].min(p[0]);
            b[1] = b[1].min(p[1]);
            b[2] = b[2].max(p[0]);
            b[3] = b[3].max(p[1]);
        };
        match self {
            Seg::Line(a, e) => {
                add(*a);
                add(*e);
            }
            Seg::Circle { c, r } => {
                add([c[0] - r, c[1] - r]);
                add([c[0] + r, c[1] + r]);
            }
            Seg::Arc { c, r, a0, sweep } => {
                add(self.start());
                add(self.end());
                let (lo, hi) = if *sweep >= 0.0 { (*a0, a0 + sweep) } else { (a0 + sweep, *a0) };
                let mut k = (lo / (PI / 2.0)).ceil();
                while k * PI / 2.0 <= hi {
                    add(polar(*c, *r, k * PI / 2.0));
                    k += 1.0;
                }
            }
            Seg::Poly(p) => p.iter().copied().for_each(add),
        }
    }
}

/// Segments chained end to end; `closed` when the last meets the first.
#[derive(Debug, Default)]
pub struct Path2 {
    pub segs: Vec<Seg>,
    pub closed: bool,
}

pub fn chain(segs: Vec<Seg>) -> Vec<Path2> {
    let mut out = Vec::new();
    let mut open: Vec<Option<Seg>> = Vec::new();
    for s in segs {
        match &s {
            Seg::Circle { .. } => out.push(Path2 { segs: vec![s], closed: true }),
            Seg::Poly(p) if p.len() > 2 && near(p[0], p[p.len() - 1]) => out.push(Path2 { segs: vec![s], closed: true }),
            _ => open.push(Some(s)),
        }
    }
    let take_next = |open: &mut Vec<Option<Seg>>, at: [f64; 2]| -> Option<Seg> {
        for slot in open.iter_mut() {
            let Some(s) = slot.as_ref() else { continue };
            if near(s.start(), at) {
                return slot.take();
            }
            if near(s.end(), at) {
                let r = s.reversed();
                *slot = None;
                return Some(r);
            }
        }
        None
    };
    for i in 0..open.len() {
        let Some(first) = open[i].take() else { continue };
        let mut path = vec![first];
        let mut closed = false;
        for pass in 0..2 {
            loop {
                if near(path[path.len() - 1].end(), path[0].start()) {
                    closed = true;
                    break;
                }
                match take_next(&mut open, path[path.len() - 1].end()) {
                    Some(s) => path.push(s),
                    None => break,
                }
            }
            if closed || pass == 1 {
                break;
            }
            path = path.iter().rev().map(Seg::reversed).collect();
        }
        out.push(Path2 { segs: path, closed });
    }
    out
}

fn occt(e: cxx::Exception) -> Fail {
    Fail::Internal(e.what().split(':').next().unwrap_or("Standard_Failure").trim().to_owned())
}

fn positions(edge: &Shape, ts: &[f64]) -> FResult<Vec<[f64; 3]>> {
    let mut out = vec![0.0; ts.len() * 3];
    fq::FQ_edge_positions(edge.raw(), ts, &mut out).map_err(occt)?;
    Ok(out.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
}

fn on(frame: &Frame, p: [f64; 3]) -> [f64; 2] {
    let d = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
    let dot = |a: [f64; 3]| d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    [dot(frame.x), dot(frame.y)]
}

fn turn(a: f64) -> f64 {
    let t = a.rem_euclid(TAU);
    if t < 1e-12 { TAU } else { t }
}

/// One edge in the frame's XY: exact for a line and for a circle around the
/// frame normal, else a polyline within `tol` of the curve.
pub fn segs_of_edge(edge: &Shape, frame: &Frame, tol: f64, budget: &mut usize) -> FResult<Option<Seg>> {
    let curve = sa::edge_probe(edge).map_or(CurveType::Other, |p| p.curve);
    if curve == CurveType::Line {
        let e = positions(edge, &[0.0, 1.0])?;
        let (a, b) = (on(frame, e[0]), on(frame, e[1]));
        return Ok((!near(a, b)).then_some(Seg::Line(a, b)));
    }
    if curve == CurveType::Circle {
        let mut c = [0.0; 7];
        if fq::FQ_edge_circle(edge.raw(), &mut c).map_err(occt)? {
            let along = c[0] * frame.z[0] + c[1] * frame.z[1] + c[2] * frame.z[2];
            if along.abs() > 1.0 - 1e-6 {
                let (centre, r) = (on(frame, [c[3], c[4], c[5]]), c[6]);
                if fq::FQ_edge_closed(edge.raw()).map_err(occt)? {
                    return Ok(Some(Seg::Circle { c: centre, r }));
                }
                let p = positions(edge, &[0.0, 0.5, 1.0])?;
                let [p0, pm, p1] = [on(frame, p[0]), on(frame, p[1]), on(frame, p[2])];
                let ang = |q: [f64; 2]| (q[1] - centre[1]).atan2(q[0] - centre[0]);
                let ccw = (p0[0] - centre[0]) * (pm[1] - centre[1]) - (p0[1] - centre[1]) * (pm[0] - centre[0]) > 0.0;
                let (a0, a1) = (ang(p0), ang(p1));
                let sweep = if ccw { turn(a1 - a0) } else { -turn(a0 - a1) };
                return Ok(Some(Seg::Arc { c: centre, r, a0, sweep }));
            }
        }
    }
    let sampled = MeshAccess::new(edge).edge_deflection(0, tol).map(|(p, _)| p).filter(|p| p.len() >= 2);
    let pts = match sampled {
        Some(p) => p,
        None => positions(edge, &(0..=64).map(|i| f64::from(i) / 64.0).collect::<Vec<_>>())?,
    };
    if pts.len() > MAX_POINTS_PER_EDGE || *budget < pts.len() {
        return Err(Fail::msg(format!(
            "this drawing needs more than {} points at a tolerance of {tol} mm, export it with a larger tolerance",
            if pts.len() > MAX_POINTS_PER_EDGE { MAX_POINTS_PER_EDGE } else { MAX_POINTS }
        )));
    }
    *budget -= pts.len();
    let mut out: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
    for p in pts {
        let q = on(frame, p);
        if out.last().is_none_or(|l| !near(*l, q)) {
            out.push(q);
        }
    }
    Ok((out.len() >= 2).then_some(Seg::Poly(out)))
}

pub struct Layer {
    pub name: &'static str,
    pub segs: Vec<Seg>,
}

fn segs_of(edges: &[Shape], frame: &Frame, tol: f64, budget: &mut usize) -> FResult<Vec<Seg>> {
    let mut out = Vec::new();
    for e in edges {
        out.extend(segs_of_edge(e, frame, tol, budget)?);
    }
    Ok(out)
}

fn face_edges(face: &Shape) -> FResult<Vec<Shape>> {
    let wires = kernel::face_wire_list(face)?;
    Ok(wires.iter().flat_map(|w| kernel::subshapes(w, Kind::Edge)).collect())
}

fn xy() -> Frame {
    Frame { origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0] }
}

/// A sketch's curves in its own XY, read from the document alone. Projected
/// curves come from the document's cache, which the app refreshes after a rebuild.
pub fn sketch_layers(doc: &CadDocument, raw: &Value, sketch: &str, tol: f64) -> FResult<Vec<Layer>> {
    let by_name = || {
        raw.get("features")?.as_array()?.iter().find_map(|f| {
            (f.get("type")?.as_str()? == "sketch" && f.get("name")?.as_str()? == sketch).then(|| f.get("id")?.as_str())?
        })
    };
    let f = match doc.feature(sketch).or_else(|| by_name().and_then(|id| doc.feature(id))) {
        Some(Feature::Sketch(f)) => f,
        Some(_) => return Err(Fail::msg(format!("'{sketch}' is not a sketch, pick a sketch or a flat face to export as DXF or SVG"))),
        None => return Err(Fail::msg(format!("no sketch '{sketch}' in the document"))),
    };
    let ctx = Ctx::with_params(doc);
    let (curves, text) = local_curves(&ctx, f)?;
    let frame = xy();
    let mut budget = MAX_POINTS;
    let mut text_edges = Vec::new();
    for t in &text {
        text_edges.extend(face_edges(t)?);
    }
    Ok(vec![
        Layer { name: "0", segs: segs_of(&curves, &frame, tol, &mut budget)? },
        Layer { name: "TEXT", segs: segs_of(&text_edges, &frame, tol, &mut budget)? },
    ])
}

fn vec3(v: &Value) -> Option<[f64; 3]> {
    let a = v.as_array()?;
    (a.len() == 3).then(|| [a[0].as_f64(), a[1].as_f64(), a[2].as_f64()]).and_then(|[x, y, z]| Some([x?, y?, z?]))
}

/// The frame a face is drawn in: the request's `plane`, which the app sets to
/// the plane a sketch on that face would take, else one from the face itself.
fn face_frame(face: &Shape, plane: Option<&Value>) -> FResult<Frame> {
    if let Some(p) = plane {
        let (Some(o), Some(n)) = (p.get("origin").and_then(vec3), p.get("normal").and_then(vec3)) else {
            return Err(Fail::msg("a plane needs an origin and a normal"));
        };
        return Ok(match p.get("xdir").and_then(vec3) {
            Some(x) => Frame::new(o, x, n),
            None => frame_for_normal(o, n),
        });
    }
    let n = kernel::face_plane_normal(face).ok_or_else(|| Fail::msg("a DXF or SVG export needs a flat face"))?;
    let c = kernel::face_area_centre(face).map_or([0.0; 3], |c| [c[0], c[1], c[2]]);
    Ok(frame_for_normal(c, n))
}

pub fn face_layers(bodies: &[builder::BuiltBody], sel: &Value, plane: Option<&Value>, tol: f64) -> FResult<Vec<Layer>> {
    let body = match sel.get("body").and_then(Value::as_str) {
        Some(id) => bodies.iter().find(|b| b.id == id).ok_or_else(|| Fail::msg(format!("body '{id}' not found to export")))?,
        None if bodies.len() == 1 => &bodies[0],
        None => return Err(Fail::msg("the face selector needs its body, take it from inspect")),
    };
    let faces = Resolver::new(None, None).faces(&body.shape, sel)?;
    let [face] = faces.as_slice() else {
        return Err(Fail::msg(format!("the face selector picks {} faces, a DXF or SVG export takes exactly one", faces.len())));
    };
    if !kernel::face_is_planar(face) {
        return Err(Fail::msg("a DXF or SVG export needs a flat face"));
    }
    let frame = face_frame(face, plane)?;
    let mut budget = MAX_POINTS;
    Ok(vec![Layer { name: "0", segs: segs_of(&face_edges(face)?, &frame, tol, &mut budget)? }])
}

fn n(v: f64) -> String {
    let r = (v * 1e9).round() / 1e9 + 0.0;
    format!("{r}")
}

fn deg(a: f64) -> f64 {
    a.to_degrees().rem_euclid(360.0)
}

pub fn write_dxf(layers: &[Layer]) -> String {
    let mut t = String::from("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n9\n$MEASUREMENT\n70\n1\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n");
    for l in layers {
        let lay = l.name;
        for s in &l.segs {
            match s {
                Seg::Line(a, b) => {
                    let _ = write!(t, "0\nLINE\n8\n{lay}\n10\n{}\n20\n{}\n30\n0\n11\n{}\n21\n{}\n31\n0\n", n(a[0]), n(a[1]), n(b[0]), n(b[1]));
                }
                Seg::Circle { c, r } => {
                    let _ = write!(t, "0\nCIRCLE\n8\n{lay}\n10\n{}\n20\n{}\n30\n0\n40\n{}\n", n(c[0]), n(c[1]), n(*r));
                }
                Seg::Arc { c, r, a0, sweep } => {
                    let (from, to) = if *sweep >= 0.0 { (*a0, a0 + sweep) } else { (a0 + sweep, *a0) };
                    let _ = write!(t, "0\nARC\n8\n{lay}\n10\n{}\n20\n{}\n30\n0\n40\n{}\n50\n{}\n51\n{}\n", n(c[0]), n(c[1]), n(*r), n(deg(from)), n(deg(to)));
                }
                Seg::Poly(p) => {
                    let closed = p.len() > 2 && near(p[0], p[p.len() - 1]);
                    let pts = if closed { &p[..p.len() - 1] } else { &p[..] };
                    let _ = write!(t, "0\nPOLYLINE\n8\n{lay}\n66\n1\n10\n0\n20\n0\n30\n0\n70\n{}\n", u8::from(closed));
                    for q in pts {
                        let _ = write!(t, "0\nVERTEX\n8\n{lay}\n10\n{}\n20\n{}\n30\n0\n", n(q[0]), n(q[1]));
                    }
                    let _ = write!(t, "0\nSEQEND\n8\n{lay}\n");
                }
            }
        }
    }
    t.push_str("0\nENDSEC\n0\nEOF\n");
    t
}

fn path_data(paths: &[Path2]) -> String {
    let mut d = String::new();
    let p = |q: [f64; 2]| format!("{} {}", n(q[0]), n(-q[1]));
    for path in paths {
        let _ = write!(d, "M{}", p(path.segs[0].start()));
        for s in &path.segs {
            match s {
                Seg::Line(_, b) => {
                    let _ = write!(d, " L{}", p(*b));
                }
                Seg::Circle { c, r } => {
                    let r_ = n(*r);
                    let _ = write!(d, " A{r_} {r_} 0 0 0 {} A{r_} {r_} 0 0 0 {}", p([c[0] - r, c[1]]), p([c[0] + r, c[1]]));
                }
                Seg::Arc { r, sweep, .. } => {
                    let large = u8::from(sweep.abs() > PI);
                    let flag = u8::from(*sweep < 0.0);
                    let _ = write!(d, " A{} {} 0 {large} {flag} {}", n(*r), n(*r), p(s.end()));
                }
                Seg::Poly(pts) => {
                    for q in &pts[1..] {
                        let _ = write!(d, " L{}", p(*q));
                    }
                }
            }
        }
        if path.closed {
            d.push_str(" Z");
        }
        d.push(' ');
    }
    d.trim_end().to_owned()
}

/// `fill` paints the closed outlines, which an SVG import heals into profiles
/// that extrude; strokes alone are what a laser cutter cuts along.
pub fn write_svg(layers: &[Layer], fill: bool) -> Option<String> {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    layers.iter().flat_map(|l| &l.segs).for_each(|s| s.grow(&mut b));
    if b[0] > b[2] {
        return None;
    }
    let m = SVG_MARGIN;
    let (w, h) = (b[2] - b[0] + 2.0 * m, b[3] - b[1] + 2.0 * m);
    let mut t = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}mm\" height=\"{h}mm\" viewBox=\"{} {} {w} {h}\">\n",
        n(b[0] - m),
        n(-(b[3] + m)),
        w = n(w),
        h = n(h)
    );
    let paint = if fill { "#000" } else { "none" };
    for l in layers {
        let (closed, open): (Vec<Path2>, Vec<Path2>) = chain(l.segs.clone()).into_iter().partition(|p| p.closed);
        let (pre, post) = if l.name == "0" { ("", "") } else { ("<g id=\"text\">\n", "</g>\n") };
        if closed.is_empty() && open.is_empty() {
            continue;
        }
        t.push_str(pre);
        if !closed.is_empty() {
            let _ = writeln!(t, "<path d=\"{}\" fill=\"{paint}\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-width=\"0.1\"/>", path_data(&closed));
        }
        if !open.is_empty() {
            let _ = writeln!(t, "<path d=\"{}\" fill=\"none\" stroke=\"#000\" stroke-width=\"0.1\"/>", path_data(&open));
        }
        t.push_str(post);
    }
    t.push_str("</svg>\n");
    Some(t)
}

fn fail_text(f: Fail) -> String {
    match f {
        Fail::Value { message, .. } => message,
        Fail::Missing(k) => format!("the export is missing '{k}'"),
        Fail::Internal(n) => format!("the 2D export failed in the kernel ({n})"),
    }
}

pub fn tolerance(req: &Map<String, Value>) -> f64 {
    req.get("tolerance").and_then(Value::as_f64).filter(|t| t.is_finite()).map_or(TOL_DEFAULT, |t| t.clamp(TOL_MIN, TOL_MAX))
}

/// The DXF or SVG export of a sketch (`sketch`, no rebuild) or a flat face (`face`).
pub fn export_flat(req: &Map<String, Value>, raw: &Value, doc: &CadDocument, format: &str, path: &str, watch: &dyn Watch) -> Map<String, Value> {
    let tol = tolerance(req);
    let layers = if let Some(s) = req.get("sketch").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        sketch_layers(doc, raw, s, tol).map_err(fail_text)
    } else if let Some(sel) = req.get("face").filter(|v| v.is_object()) {
        match builder::rebuild(doc, raw, watch) {
            Ok(r) => face_layers(&r.bodies, sel, req.get("plane").filter(|p| p.is_object()), tol).map_err(fail_text),
            Err(_) => Err("cancelled".into()),
        }
    } else {
        Err("pick a sketch or a flat face to export as DXF or SVG".into())
    };
    let text = layers.and_then(|l| {
        if l.iter().all(|l| l.segs.is_empty()) {
            return Err("nothing to export, the sketch or face draws no curves".into());
        }
        let fill = req.get("svg").and_then(|s| s.get("fill")).and_then(Value::as_bool).unwrap_or(false);
        Ok(if format == "dxf" { write_dxf(&l) } else { write_svg(&l, fill).unwrap_or_default() })
    });
    let mut m = Map::new();
    match text.and_then(|t| write_atomic(Path::new(path), t.as_bytes()).map_err(|e| format!("could not write {path}: {e}"))) {
        Ok(()) => {
            m.insert("path".into(), json!(path));
        }
        Err(e) => {
            m.insert("error".into(), json!({ "message": e }));
        }
    }
    m
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".part");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}
