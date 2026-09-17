//! Holes drilled into a flat face along its normal, sidecar/hole_feature.py.
//! Each hole is one revolved half section placed at its position, and every
//! position is cut from the body in a single boolean.

use fundacad_core::hole_standards::{self as std_holes, DRILL_POINT_DEG, HOLE_TYPES, SIZES};
use fundacad_core::schema::{Hole, HoleExtent, Num};
use opencascade::primitives::Shape;
use opencascade::select_access::SurfaceType;
use serde_json::{json, Value};

use crate::builder::{py_g, Ctx, FResult, Fail, BAD_REQUEST};
use crate::kernel::{self, BoolKind, Frame, Kind};
use crate::select::entity::FaceEnt;
use crate::select::Resolver;

const REFERENCE_NOT_FOUND: &str = "referenceNotFound";

fn bad(message: impl Into<String>) -> Fail {
    Fail::Value {
        message: message.into(),
        code: Some(BAD_REQUEST),
    }
}

fn missing_ref(message: impl Into<String>) -> Fail {
    Fail::Value {
        message: message.into(),
        code: Some(REFERENCE_NOT_FOUND),
    }
}

/// Python `repr` of a str.
fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Profile {
    Simple,
    Counterbore { r: f64, depth: f64 },
    Countersink { r: f64, depth: f64 },
    Insert { lead: f64 },
}

struct Dims {
    profile: Profile,
    r: f64,
    depth: Option<f64>,
    drill_point: bool,
}

/// `_dims`.
fn dims(ctx: &Ctx, f: &Hole) -> FResult<Dims> {
    let hole_type = f
        .hole_type
        .as_ref()
        .map(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .unwrap_or("simple");
    if !HOLE_TYPES.contains(&hole_type) {
        return Err(bad(format!("Hole: unknown hole type {}", py_repr(hole_type))));
    }
    if let Some(size) = f.size.as_deref() {
        if !SIZES.contains(&size) {
            return Err(bad(format!(
                "Hole: unknown size {}, expected one of {}",
                py_repr(size),
                SIZES.join(", ")
            )));
        }
    }
    let std = std_holes::standard_dims(
        hole_type,
        f.standard.as_ref().map(|s| s.as_str()),
        f.size.as_deref(),
        f.fit.as_ref().map(|s| s.as_str()),
    );
    let num = |own: &Option<Num>, fallback: Option<f64>| -> FResult<Option<f64>> {
        match own {
            Some(n) => Ok(Some(ctx.val(n)?)),
            None => Ok(fallback),
        }
    };

    let Some(d) = num(&f.diameter, std.diameter)? else {
        let what = if hole_type == "insert" {
            "heat-set insert preset"
        } else {
            "standard size"
        };
        return Err(bad(format!("Hole: give a diameter or a {what}")));
    };
    if !(d > 0.0) {
        return Err(bad(format!(
            "Hole: diameter must be greater than 0 (got {})",
            py_g(d)
        )));
    }
    let through = f.extent == Some(HoleExtent::Through) && hole_type != "insert";
    let depth = if through {
        None
    } else {
        let depth = num(&f.depth, std.depth)?.unwrap_or(2.0 * d);
        if !(depth > 0.0) {
            return Err(bad(format!(
                "Hole: depth must be greater than 0 (got {})",
                py_g(depth)
            )));
        }
        Some(depth)
    };
    let profile = match hole_type {
        "counterbore" => {
            let (Some(cbd), Some(cbh)) = (
                num(&f.cb_diameter, std.cb_diameter)?,
                num(&f.cb_depth, std.cb_depth)?,
            ) else {
                return Err(bad(
                    "Hole: a counterbore needs a counterbore diameter and depth, or a standard size",
                ));
            };
            if !(cbd > d) {
                return Err(bad(format!(
                    "Hole: the counterbore diameter ({}) must be larger than the hole ({})",
                    py_g(cbd),
                    py_g(d)
                )));
            }
            if !(cbh > 0.0) || depth.is_some_and(|h| cbh >= h) {
                return Err(bad(format!(
                    "Hole: the counterbore depth ({}) must be greater than 0 and less than the hole depth",
                    py_g(cbh)
                )));
            }
            Profile::Counterbore {
                r: cbd / 2.0,
                depth: cbh,
            }
        }
        "countersink" => {
            let csd = num(&f.cs_diameter, std.cs_diameter)?;
            let ang = num(&f.cs_angle, std.cs_angle)?.unwrap_or(90.0);
            let Some(csd) = csd else {
                return Err(bad(
                    "Hole: a countersink needs a countersink diameter, or a standard size",
                ));
            };
            if !(csd > d) {
                return Err(bad(format!(
                    "Hole: the countersink diameter ({}) must be larger than the hole ({})",
                    py_g(csd),
                    py_g(d)
                )));
            }
            if !(0.0 < ang && ang < 180.0) {
                return Err(bad(format!(
                    "Hole: the countersink angle must be between 0 and 180 degrees (got {})",
                    py_g(ang)
                )));
            }
            let sink = (csd - d) / 2.0 / (ang / 2.0).to_radians().tan();
            if depth.is_some_and(|h| sink >= h) {
                return Err(bad("Hole: the countersink is deeper than the hole"));
            }
            Profile::Countersink {
                r: csd / 2.0,
                depth: sink,
            }
        }
        "insert" => {
            let lead = num(&f.lead_in, std.lead_in)?
                .filter(|v| *v != 0.0)
                .unwrap_or(0.0);
            if lead < 0.0 {
                return Err(bad(format!(
                    "Hole: the lead-in must not be negative (got {})",
                    py_g(lead)
                )));
            }
            if depth.is_some_and(|h| lead >= h) {
                return Err(bad("Hole: the lead-in is deeper than the hole"));
            }
            Profile::Insert { lead }
        }
        _ => Profile::Simple,
    };
    Ok(Dims {
        profile,
        r: d / 2.0,
        depth,
        drill_point: f.drill_point.unwrap_or(false) && !through,
    })
}

/// `_profile`: (radius, z) corners of the half section, z = 0 on the face.
fn profile(d: &Dims, lift: f64, through_depth: f64) -> Vec<[f64; 2]> {
    let r = d.r;
    let depth = d.depth.unwrap_or(through_depth);
    let mut pts = vec![[0.0, lift]];
    match d.profile {
        Profile::Counterbore { r: cb, depth: h } => {
            pts.extend([[cb, lift], [cb, -h], [r, -h]]);
        }
        Profile::Countersink { r: cs, depth: h } => {
            pts.extend([[cs, lift], [cs, 0.0], [r, -h]]);
        }
        Profile::Insert { lead } if lead > 0.0 => {
            pts.extend([[r + lead, lift], [r + lead, 0.0], [r, -lead]]);
        }
        _ => pts.push([r, lift]),
    }
    pts.push([r, -depth]);
    let tip = if d.drill_point {
        -depth - r / (DRILL_POINT_DEG / 2.0).to_radians().tan()
    } else {
        -depth
    };
    pts.push([0.0, tip]);
    pts
}

fn tool_solid(d: &Dims, lift: f64, through_depth: f64) -> FResult<Shape> {
    let pts: Vec<[f64; 3]> = profile(d, lift, through_depth)
        .into_iter()
        .map(|[x, z]| [x, 0.0, z])
        .collect();
    let face = kernel::polygon_face(&pts)?;
    Ok(kernel::revolve(&face, [0.0; 3], [0.0, 0.0, 1.0], 360.0)?)
}

/// `_pick_body`: the named body (the feature's, else the selector's), else the
/// one nearest the anchor, else the last.
fn pick_body(ctx: &Ctx, f: &Hole, sel_body: Option<&str>, point: Option<[f64; 3]>) -> FResult<usize> {
    let named = f.body.as_deref().filter(|b| !b.is_empty());
    if let Some(bid) = named.or(sel_body.filter(|b| !b.is_empty())) {
        return ctx
            .find_body(bid)
            .ok_or_else(|| missing_ref("Hole: the target body no longer exists"));
    }
    if ctx.bodies.is_empty() {
        return Err(bad("Hole needs an existing body"));
    }
    let Some(p) = point else {
        return Ok(ctx.bodies.len() - 1);
    };
    let mut best: Option<(f64, usize)> = None;
    for (i, b) in ctx.bodies.iter().enumerate() {
        let d = kernel::distance_to_point(b.shape(), p).unwrap_or(f64::INFINITY);
        if best.map_or(true, |(bd, _)| d < bd) {
            best = Some((d, i));
        }
    }
    Ok(best.map_or(0, |(_, i)| i))
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalized(v: [f64; 3]) -> [f64; 3] {
    let l = dot(v, v).sqrt();
    [v[0] / l, v[1] / l, v[2] / l]
}

pub fn handle(ctx: &mut Ctx, f: &Hole) -> FResult {
    let d = dims(ctx, f)?;
    let (sk_plane, sk_points) = match f.sketch.as_deref().filter(|s| !s.is_empty()) {
        Some(sid) => match ctx.sketches.get(sid) {
            Some(entry) => (Some(entry.plane), entry.points.clone()),
            None => {
                return Err(missing_ref(format!(
                    "Hole: the sketch it takes positions from ({sid}) did not build, fix that sketch first"
                )))
            }
        },
        None => (None, Vec::new()),
    };
    let mut points: Vec<[f64; 3]> = f
        .points
        .iter()
        .flatten()
        .map(|p| [p[0].get(), p[1].get(), p[2].get()])
        .collect();
    points.extend(sk_points);
    if points.is_empty() {
        return Err(bad(
            "Hole: no positions, click the face or name a sketch with points",
        ));
    }

    let sel = f
        .face
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| Fail::Internal("TypeError".into()))?
        .filter(truthy);
    let (body, origin, normal) = if let Some(sel) = sel {
        face_anchor(ctx, f, &sel)?
    } else if let Some(plane) = sk_plane {
        let body = pick_body(ctx, f, None, Some(points[0]))?;
        (body, plane.origin, plane.z)
    } else {
        return Err(bad("Hole: pick a flat face to drill into"));
    };
    drill(ctx, f, &d, body, origin, normal, &points)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Object(m) => !m.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
    }
}

/// The body, centre and normal of the one flat face a `face` selector names.
fn face_anchor(ctx: &mut Ctx, f: &Hole, sel: &Value) -> FResult<(usize, [f64; 3], [f64; 3])> {
    let Some(m) = sel.as_object() else {
        return Err(bad("Hole: `face` must be one face selector"));
    };
    let anchor = if m.get("by").and_then(Value::as_str) == Some("nearest") {
        match m.get("point") {
            Some(Value::Array(p)) => {
                let mut xyz = [0.0; 3];
                for (slot, c) in xyz.iter_mut().zip(p) {
                    *slot = c.as_f64().ok_or_else(|| Fail::Internal("TypeError".into()))?;
                }
                Some(xyz)
            }
            Some(Value::Null) | None => None,
            Some(_) => return Err(Fail::Internal("TypeError".into())),
        }
    } else {
        None
    };
    let body = pick_body(ctx, f, m.get("body").and_then(Value::as_str), anchor)?;
    let shape = ctx.bodies[body].shape().clone();
    let faces = Resolver::new(Some(&mut ctx.diagnostics), Some(&f.id))
        .faces(&shape, sel)
        .map_err(|e| match e {
            Fail::Missing(key) => bad(format!("Hole: the face selector is malformed ('{key}')")),
            Fail::Internal(name) if name == "TypeError" || name == "AttributeError" => {
                bad(format!("Hole: the face selector is malformed ({name})"))
            }
            other => other,
        })?;
    let Some(face) = faces.into_iter().next() else {
        return Err(missing_ref("Hole: the face to drill is no longer in the model"));
    };
    let face = FaceEnt::new(face)?;
    if face.surface != SurfaceType::Plane {
        return Err(bad(
            "Hole: the face must be flat, a hole is drilled along a flat face's normal",
        ));
    }
    Ok((body, face.centroid().to_array(), face.normal().to_array()))
}

#[allow(clippy::too_many_arguments)]
fn drill(
    ctx: &mut Ctx,
    f: &Hole,
    d: &Dims,
    body: usize,
    origin: [f64; 3],
    normal: [f64; 3],
    points: &[[f64; 3]],
) -> FResult {
    if dot(normal, normal).sqrt() < 1e-9 {
        return Err(bad("Hole: the face has no usable normal"));
    }
    let mut normal = normalized(normal);
    if f.flip.unwrap_or(false) {
        normal = [-normal[0], -normal[1], -normal[2]];
    }

    let shape = ctx.bodies[body].shape().clone();
    let bb = kernel::bbox(&shape).unwrap_or([0.0; 6]);
    let diag = dot(sub([bb[3], bb[4], bb[5]], [bb[0], bb[1], bb[2]]), sub([bb[3], bb[4], bb[5]], [bb[0], bb[1], bb[2]])).sqrt();
    let centre = [(bb[0] + bb[3]) / 2.0, (bb[1] + bb[4]) / 2.0, (bb[2] + bb[5]) / 2.0];
    let lift = 0.01f64.max(1e-3 * diag);
    let reference = if normal[2].abs() < 0.9 {
        [0.0, 0.0, 1.0]
    } else {
        [1.0, 0.0, 0.0]
    };
    let x_dir = normalized(cross(normal, reference));

    let mut tools = Vec::with_capacity(points.len());
    for &p in points {
        let k = dot(sub(p, origin), normal);
        let on_plane = [p[0] - normal[0] * k, p[1] - normal[1] * k, p[2] - normal[2] * k];
        let through_depth = dot(sub(on_plane, centre), normal).abs() + diag + 1.0;
        let solid = tool_solid(d, lift, through_depth)?;
        tools.push(Frame::new(on_plane, x_dir, normal).locate(&solid)?);
    }

    let before = kernel::volume(&shape);
    let refs: Vec<&Shape> = tools.iter().collect();
    let cut = kernel::boolean_op(&shape, &refs, BoolKind::Cut)?;
    if kernel::count(&cut, Kind::Solid) == 0 {
        return Err(bad("Hole: the holes removed the whole body"));
    }
    let after = kernel::volume(&cut);
    ctx.set_shape(body, cut);
    if (before - after).abs() < 1e-9 {
        ctx.diagnostics.push(json!({
            "feature_id": f.id,
            "kind": "hole",
            "resolved": 0,
            "confidence": 0.0,
            "lossy": false,
            "reason": "the holes miss the body, nothing was cut",
        }));
    }
    Ok(())
}
