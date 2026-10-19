//! Text on a face, embossed or engraved. Glyph outlines go into the face's
//! (u, v) through an isometry of its surface (a plane, a cylinder, a cone rolled
//! out flat), so letters keep their size on a round face instead of being
//! projected onto it. The face is found again at every build, so the text
//! follows it through upstream edits.

use fundacad_core::schema::{Operation, TextOnFace};
use glam::{DVec2, DVec3};
use opencascade::primitives::Shape;
use opencascade_sys::sketch_ops as ffi;
use serde_json::Value;

use crate::builder::{Ctx, FResult, Fail, BAD_REQUEST};
use crate::kernel::{self, BoolKind, Kind};
use crate::select::Resolver;
use crate::text::{self, fonts::Aspect, Glyph, HAlign, Seg, TextSpec, P};

const REFERENCE_NOT_FOUND: &str = "referenceNotFound";
const PLANE: f64 = 1.0;
const CYLINDER: f64 = 2.0;
const CONE: f64 = 3.0;

fn bad(message: impl Into<String>) -> Fail {
    Fail::Value { message: message.into(), code: Some(BAD_REQUEST) }
}

fn missing_ref(message: impl Into<String>) -> Fail {
    Fail::Value { message: message.into(), code: Some(REFERENCE_NOT_FOUND) }
}

fn v3(a: &[f64]) -> DVec3 {
    DVec3::new(a[0], a[1], a[2])
}

fn pick_body(ctx: &Ctx, f: &TextOnFace, sel: &Value) -> FResult<usize> {
    let named = f.body.as_deref().or_else(|| sel.get("body").and_then(Value::as_str)).filter(|b| !b.is_empty());
    if let Some(bid) = named {
        return ctx.find_body(bid).ok_or_else(|| missing_ref("Text on face: the body it sits on no longer exists"));
    }
    if ctx.bodies.is_empty() {
        return Err(bad("Text on face needs an existing body"));
    }
    let Some(p) = f.point.as_ref().map(|p| [p[0].get(), p[1].get(), p[2].get()]) else {
        return Ok(ctx.bodies.len() - 1);
    };
    let mut best = (f64::INFINITY, ctx.bodies.len() - 1);
    for (i, b) in ctx.bodies.iter().enumerate() {
        let d = kernel::distance_to_point(b.shape(), p).unwrap_or(f64::INFINITY);
        if d < best.0 {
            best = (d, i);
        }
    }
    Ok(best.1)
}

/// The face's surface at the anchor, as `sk_surface_at` reports it.
struct Surface {
    kind: f64,
    uv: DVec2,
    du: DVec3,
    dv: DVec3,
    orient: f64,
    radius: f64,
    half_angle: f64,
    bounds: [f64; 4],
}

impl Surface {
    fn at(face: &Shape, query: [f64; 6]) -> Option<Surface> {
        let mut o = [0.0; 19];
        if !ffi::sk_surface_at(face.raw(), &query, &mut o).ok()? {
            return None;
        }
        Some(Surface {
            kind: o[0],
            uv: DVec2::new(o[1], o[2]),
            du: v3(&o[6..9]),
            dv: v3(&o[9..12]),
            orient: o[12],
            radius: o[13],
            half_angle: o[14],
            bounds: [o[15], o[16], o[17], o[18]],
        })
    }

    fn outward(&self) -> DVec3 {
        self.du.cross(self.dv).normalize_or_zero() * self.orient
    }
}

/// Glyph plane (x right, y up, seen from outside the body) to the surface's
/// (u, v). `affine` maps keep Bezier poles exact, the cone's does not.
struct Map {
    affine: bool,
    f: Box<dyn Fn(DVec2) -> DVec2>,
}

fn surface_map(s: &Surface) -> FResult<Map> {
    let n = s.outward();
    let world_up = if n.z.abs() > 0.9 { DVec3::Y } else { DVec3::Z };
    let uv0 = s.uv;
    if s.kind == PLANE {
        let up = (world_up - n * n.dot(world_up)).normalize();
        let right = up.cross(n);
        let (du, dv) = (s.du.normalize(), s.dv.normalize());
        return Ok(Map {
            affine: true,
            f: Box::new(move |p| {
                let w = right * p.x + up * p.y;
                uv0 + DVec2::new(w.dot(du), w.dot(dv))
            }),
        });
    }
    let sy = if s.dv.dot(world_up) < -1e-9 { -1.0 } else { 1.0 };
    let sx = sy * s.orient;
    if s.kind == CYLINDER || (s.kind == CONE && s.half_angle.sin().abs() < 1e-9) {
        let r = s.du.length();
        return Ok(Map { affine: true, f: Box::new(move |p| uv0 + DVec2::new(sx * p.x / r, sy * p.y)) });
    }
    if s.kind == CONE {
        // The cone rolled out: v is the distance along a generatrix, rho the
        // distance from the apex, signed like sin(half angle).
        let sin = s.half_angle.sin();
        let rho0 = s.radius / sin + uv0.y;
        return Ok(Map {
            affine: false,
            f: Box::new(move |p| {
                let q = DVec2::new(sx * p.x, rho0 + sy * p.y);
                let rho = rho0.signum() * q.length();
                let theta = (q.x / rho).atan2(q.y / rho);
                uv0 + DVec2::new(theta / sin, rho - rho0)
            }),
        });
    }
    Err(bad("Text on face: the face must be flat, a cylinder or a cone"))
}

fn bezier(s: P, seg: &Seg, t: f64) -> DVec2 {
    let (a, m) = (DVec2::from(s), 1.0 - t);
    match *seg {
        Seg::Line(e) => a * m + DVec2::from(e) * t,
        Seg::Quad(c, e) => a * m * m + DVec2::from(c) * 2.0 * m * t + DVec2::from(e) * t * t,
        Seg::Cubic(c1, c2, e) => {
            a * m * m * m + DVec2::from(c1) * 3.0 * m * m * t + DVec2::from(c2) * 3.0 * m * t * t + DVec2::from(e) * t * t * t
        }
    }
}

fn encode(c: &text::Contour, map: &Map, data: &mut Vec<f64>) {
    #[allow(clippy::cast_precision_loss)]
    data.push(c.segs.len() as f64);
    let mut start = c.start;
    for seg in &c.segs {
        let poles: Vec<P> = match *seg {
            Seg::Line(e) => vec![start, e],
            Seg::Quad(c1, e) => vec![start, c1, e],
            Seg::Cubic(c1, c2, e) => vec![start, c1, c2, e],
        };
        if map.affine {
            #[allow(clippy::cast_precision_loss)]
            data.push((poles.len() - 1) as f64);
            for p in &poles {
                let q = (map.f)(DVec2::from(*p));
                data.extend([q.x, q.y]);
            }
        } else {
            let n: usize = if matches!(seg, Seg::Line(_)) { 8 } else { 12 };
            #[allow(clippy::cast_precision_loss)]
            data.extend([0.0, (n + 1) as f64]);
            for i in 0..=n {
                #[allow(clippy::cast_precision_loss)]
                let q = (map.f)(bezier(start, seg, i as f64 / n as f64));
                data.extend([q.x, q.y]);
            }
        }
        start = *poles.last().unwrap_or(&start);
    }
}

/// The laid out glyphs, ink centred on the anchor vertically, then turned.
fn placed_glyphs(spec: &TextSpec, angle_deg: f64) -> Vec<Glyph> {
    let glyphs = text::glyphs(spec, None);
    let ys = glyphs.iter().flat_map(|g| &g.contours).flat_map(|c| std::iter::once(c.start).chain(c.segs.iter().map(seg_end)));
    let (lo, hi) = ys.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[1]), hi.max(p[1])));
    let mid = if lo.is_finite() { (lo + hi) / 2.0 } else { 0.0 };
    let (sin, cos) = angle_deg.to_radians().sin_cos();
    let turn = |p: P| -> P {
        let y = p[1] - mid;
        [p[0] * cos - y * sin, p[0] * sin + y * cos]
    };
    glyphs
        .iter()
        .map(|g| Glyph {
            contours: g
                .contours
                .iter()
                .map(|c| text::Contour {
                    start: turn(c.start),
                    segs: c
                        .segs
                        .iter()
                        .map(|s| match *s {
                            Seg::Line(e) => Seg::Line(turn(e)),
                            Seg::Quad(a, e) => Seg::Quad(turn(a), turn(e)),
                            Seg::Cubic(a, b, e) => Seg::Cubic(turn(a), turn(b), turn(e)),
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect()
}

fn seg_end(s: &Seg) -> P {
    match *s {
        Seg::Line(e) | Seg::Quad(_, e) | Seg::Cubic(_, _, e) => e,
    }
}

pub fn handle(ctx: &mut Ctx, f: &TextOnFace) -> FResult {
    let sel = serde_json::to_value(&f.face).map_err(|_| Fail::Internal("TypeError".into()))?;
    let body = ctx.editable(pick_body(ctx, f, &sel)?, "Text on face")?;
    let shape = ctx.bodies[body].shape().clone();
    let face = Resolver::new(Some(&mut ctx.diagnostics), Some(&f.id))
        .faces(&shape, &sel)?
        .into_iter()
        .next()
        .ok_or_else(|| missing_ref("Text on face: the face it sits on is no longer in the model, re-pick the face"))?;

    if f.text.trim().is_empty() {
        return Err(bad("Text on face: the text is empty"));
    }
    let height = ctx.val(&f.height)?;
    if !(height > 0.0) {
        return Err(bad("Text on face: the height must be greater than 0"));
    }
    let depth = ctx.val(&f.depth)?;
    if !(depth > 0.0) {
        return Err(bad("Text on face: the depth must be greater than 0"));
    }
    let cut = match &f.operation {
        None | Some(Operation::Join) => false,
        Some(Operation::Cut) => true,
        Some(other) => return Err(bad(format!("Text on face: the operation must be join or cut, not {}", other.as_str()))),
    };
    let angle = ctx.val_or(f.angle.as_ref(), 0.0)?;

    let query = match (&f.at, &f.point) {
        (Some(at), _) => [0.0, 0.0, 0.0, ctx.val(&at[0])?, ctx.val(&at[1])?, 1.0],
        (None, Some(p)) => [p[0].get(), p[1].get(), p[2].get(), 0.0, 0.0, 0.0],
        (None, None) => [0.0, 0.0, 0.0, 0.5, 0.5, 1.0],
    };
    let surf = Surface::at(&face, query).ok_or_else(|| bad("Text on face: the anchor point is not on the face"))?;
    let map = surface_map(&surf)?;

    let spec = TextSpec {
        text: f.text.clone(),
        size: height,
        font: f.font.clone().filter(|s| !s.is_empty()),
        aspect: Aspect::from_style(f.style.as_ref().map_or("regular", |s| s.as_str())),
        align: match f.align.as_ref().map(|a| a.as_str()) {
            Some("left") => HAlign::Left,
            Some("right") => HAlign::Right,
            _ => HAlign::Center,
        },
        rotation: 0.0,
        x: 0.0,
        y: 0.0,
        position_on_path: 0.0,
        box_width: None,
    };
    let glyphs = placed_glyphs(&spec, angle);
    if glyphs.is_empty() {
        return Err(bad("Text on face: no installed font could draw the text"));
    }

    if surf.kind != PLANE {
        let r = surf.du.length();
        let xs = glyphs.iter().flat_map(|g| &g.contours).flat_map(|c| std::iter::once(c.start).chain(c.segs.iter().map(seg_end)));
        let (lo, hi) = xs.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[0]), hi.max(p[0])));
        if hi - lo > 0.98 * std::f64::consts::TAU * r {
            return Err(bad(format!(
                "Text on face: the text is {:.1} mm long and runs all the way round the {:.1} mm round face, make it smaller or shorter",
                hi - lo,
                std::f64::consts::TAU * r
            )));
        }
        if cut && surf.orient > 0.0 && depth >= r {
            return Err(bad(format!("Text on face: an engraving {depth} mm deep goes past the axis of a {r:.2} mm radius face")));
        }
    }

    let along_normal = depth * surf.orient * if cut { -1.0 } else { 1.0 };
    let mut tools = Vec::new();
    let mut dropped = 0;
    let mut uv_box = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
    for g in &glyphs {
        for (outer, holes) in text::faces_of(g) {
            let mut data = Vec::new();
            #[allow(clippy::cast_precision_loss)]
            data.push((1 + holes.len()) as f64);
            encode(&g.contours[outer], &map, &mut data);
            for h in &holes {
                encode(&g.contours[*h], &map, &mut data);
            }
            match ffi::sk_glyph_on_face(face.raw(), &data, along_normal) {
                Ok(p) if !p.is_null() => tools.push(Shape::from_raw(p)),
                _ => dropped += 1,
            }
            for q in data_points(&g.contours[outer], &map) {
                uv_box = [uv_box[0].min(q.x), uv_box[1].max(q.x), uv_box[2].min(q.y), uv_box[3].max(q.y)];
            }
        }
    }
    if tools.is_empty() {
        return Err(bad("Text on face: no letter could be laid on the face"));
    }
    if dropped > 0 {
        ctx.advise(&f.id, "textGlyphDropped", format!("Text on face: {dropped} letter outline(s) could not be laid on the face and were left out"));
    }
    let [umin, umax, vmin, vmax] = surf.bounds;
    let tol = 1e-6;
    let full_turn = surf.kind != PLANE && umax - umin >= std::f64::consts::TAU - 1e-6;
    let off_u = !full_turn && (uv_box[0] < umin - tol || uv_box[1] > umax + tol);
    if off_u || uv_box[2] < vmin - tol || uv_box[3] > vmax + tol {
        ctx.advise(&f.id, "textOffFace", "Text on face: the text runs past the edge of its face".to_string());
    }

    let kind = if cut { BoolKind::Cut } else { BoolKind::Fuse };
    let tool_volume: f64 = tools.iter().map(kernel::volume).sum();
    let before = kernel::volume(&shape);
    let before_solids = kernel::count(&shape, Kind::Solid);
    let refs: Vec<&Shape> = tools.iter().collect();
    let out = kernel::serial_bool(&shape, &refs, kind)?;
    let changed = (kernel::volume(&out) - before).abs();
    if kernel::count(&out, Kind::Solid) == 0 {
        return Err(bad("Text on face: the engraving removed the whole body"));
    }
    if changed > 2.0 * tool_volume + 1e-6 {
        return Err(bad("Text on face: the kernel could not lay the letters on the face cleanly"));
    }
    if cut && kernel::count(&out, Kind::Solid) > before_solids {
        return Err(bad("Text on face: the engraving cuts through the wall, make it shallower"));
    }
    let body_id = ctx.bodies[body].id.clone();
    ctx.set_shape(body, out);
    ctx.record_tool(&f.id, kind, vec![body_id], kernel::compound(&tools));
    Ok(())
}

fn data_points<'a>(c: &'a text::Contour, map: &'a Map) -> impl Iterator<Item = DVec2> + 'a {
    std::iter::once(c.start).chain(c.segs.iter().map(seg_end)).map(|p| (map.f)(DVec2::from(p)))
}

/// The `faceAnchor` op: where `point` sits on `face` of `body`, in the terms a
/// `textOnFace` stores, `{surface, fp, at, point, normal}`. The app cannot
/// work out OCCT's (u, v) origin or the exact fingerprint itself.
pub fn face_anchor_result(req: &serde_json::Map<String, Value>, watch: &dyn crate::builder::Watch) -> fundacad_protocol::JobResult {
    let (_, built) = match crate::inspect::rebuild_request(req, watch) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Some(sel) = req.get("face") else {
        return fundacad_engine::error_result("'face'");
    };
    let point = match req.get("point").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_f64).collect::<Vec<_>>()) {
        Some(p) if p.len() == 3 => [p[0], p[1], p[2]],
        _ => return fundacad_engine::error_result("'point'"),
    };
    let wanted = req.get("body").and_then(Value::as_str).or_else(|| sel.get("body").and_then(Value::as_str));
    let found = built.bodies.iter().filter(|b| wanted.map_or(true, |id| b.id == id)).find_map(|b| {
        let face = Resolver::new(None, None).faces(&b.shape, sel).ok()?.into_iter().next()?;
        Some((b, face))
    });
    let reply = match found {
        None => serde_json::json!({"reason": "the face was not found"}),
        Some((body, face)) => match Surface::at(&face, [point[0], point[1], point[2], 0.0, 0.0, 0.0]) {
            None => serde_json::json!({"reason": "the point is not on the face"}),
            Some(s) => {
                #[allow(clippy::float_cmp)]
                let surface = match s.kind {
                    k if k == PLANE => "plane",
                    k if k == CYLINDER => "cylinder",
                    k if k == CONE => "cone",
                    k if k == 4.0 => "sphere",
                    _ => "other",
                };
                let [umin, umax, vmin, vmax] = s.bounds;
                let frac = |x: f64, lo: f64, hi: f64| if hi - lo > 1e-12 { ((x - lo) / (hi - lo)).clamp(0.0, 1.0) } else { 0.5 };
                let n = s.outward();
                let mut r = serde_json::json!({
                    "body": body.id,
                    "surface": surface,
                    "at": [frac(s.uv.x, umin, umax), frac(s.uv.y, vmin, vmax)],
                    "normal": [n.x, n.y, n.z],
                });
                if let Ok(fp) = crate::select::face_fingerprint(&face) {
                    r["fp"] = fp;
                }
                r
            }
        },
    };
    fundacad_protocol::JobResult::Json(reply.as_object().cloned().unwrap_or_default())
}
