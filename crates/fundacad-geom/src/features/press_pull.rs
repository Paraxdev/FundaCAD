//! Moving faces: press/pull and offset face, sidecar/solid_ops.py `_press_pull`,
//! `_offset_faces`, `_thicken_press_pull`, `_sweep_press_pull` and the
//! handlers of sidecar/builder.py.
//!
//! The Python engine runs the whole-body BRepOffset pass in offset_child.py
//! because it has crashed its worker. Here it runs in process: the engine is
//! itself a supervised worker, the freeform faces measured to crash are refused
//! before any offset (`guard_offsetable`, the analytic-only dispatch below),
//! and on OCCT 7.8.1 the chamfered cylinder offset_child.py documents refuses
//! with an error instead of crashing. The BREP round trip the child did is kept,
//! since it changes which offsets the kernel accepts.

use fundacad_core::schema::{OffsetFace, Operation, PressPull, Selector};
use glam::{dvec3, DVec3};
use opencascade::modify::{OffsetJoin, OffsetOptions};
use opencascade::primitives::{Shape, ShapeType, SurfaceType};
use opencascade::progress::ProgressRange;
use opencascade::select_access as sa;
use opencascade::shape_io::BrepWriteOptions;
use opencascade_sys as ffi;
use serde_json::Value;

use super::boolean::combine;
use super::extrude::prisms;
use super::solid_ops::{
    faces_of, guard_offsetable, offsettable_curved, resolve_field, surface_type,
};
use crate::builder::{py_g, Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind, Kind};
use crate::select::entity::FaceEnt;
use crate::select::Resolver;

const CANT_OFFSET: &str = "can't offset this face by that amount";
const RAN_PAST: &str = "that offset ran past what this surface can hold, try a smaller amount";
const SWEEP_REFUSAL: &str = "can't press/pull this face, it is freeform and wraps around, so there is no one direction to push it in. Try a neighbouring face instead.";

fn v3(a: [f64; 3]) -> DVec3 {
    dvec3(a[0], a[1], a[2])
}

/// build123d `face.normal_at()`, zero where it raises.
fn normal(face: &Shape) -> DVec3 {
    kernel::face_normal_mid(face).map_or(DVec3::ZERO, v3)
}

/// build123d `face.center()`.
fn centre(face: &Shape) -> DVec3 {
    FaceEnt::new(face.clone()).map_or(DVec3::ZERO, |f| f.centroid())
}

fn valid(s: &Shape) -> bool {
    s.is_valid().unwrap_or(false)
}

fn fused(part: &Shape, tool: &Shape, grow: bool) -> FResult<Shape> {
    let kind = if grow { BoolKind::Fuse } else { BoolKind::Cut };
    Ok(kernel::boolean_op(part, &[tool], kind)?)
}

fn vertices(shape: &Shape) -> Vec<DVec3> {
    kernel::subshapes(shape, Kind::Vertex)
        .iter()
        .filter_map(kernel::bbox)
        .map(|b| dvec3(b[0], b[1], b[2]))
        .collect()
}

/// `_clamp_cylinder`: an inward push stops at 90% of the radius.
fn clamp_cylinder(face: &Shape, d: f64) -> f64 {
    match FaceEnt::new(face.clone()).ok().and_then(|f| f.radius) {
        Some(r) if r > 1e-6 => d.clamp(-0.9 * r, 0.9 * r),
        _ => d,
    }
}

/// `_clamp_planar`: an inward push stops at 90% of the body's extent along the normal.
fn clamp_planar(part: &Shape, face: &Shape, d: f64) -> f64 {
    if d >= 0.0 {
        return d;
    }
    let n = normal(face);
    let proj: Vec<f64> = vertices(part).iter().map(|v| v.dot(n)).collect();
    let (Some(hi), Some(lo)) = (
        proj.iter().copied().reduce(f64::max),
        proj.iter().copied().reduce(f64::min),
    ) else {
        return d;
    };
    let thickness = hi - lo;
    if thickness > 1e-6 {
        d.max(-0.9 * thickness)
    } else {
        d
    }
}

fn solid_from_shell(shell: &Shape) -> Option<Shape> {
    let mut make =
        ffi::b_rep_builder_api::BRepBuilderAPI_MakeSolid_new(ffi::topo_ds::Shell(shell.raw()));
    make.IsDone()
        .then(|| Shape::from_raw_ref(make.pin_mut().Shape()))
}

enum Refusal {
    Refused,
    Invalid,
}

/// offset_child.py `run`: every face offset in one BRepOffset pass.
fn offset_pass(part: &Shape, faces: &[Shape], dists: &[f64]) -> Result<Shape, Refusal> {
    let detached = ProgressRange::detached();
    let mut bundle = vec![part.clone()];
    bundle.extend(faces.iter().cloned());
    let text = kernel::compound(&bundle)
        .to_brep_text(BrepWriteOptions::default(), &detached)
        .map_err(|_| Refusal::Refused)?;
    let read = Shape::from_brep_text(&text, &detached).map_err(|_| Refusal::Refused)?;
    let kids = kernel::children(&read);
    if kids.len() != dists.len() + 1 {
        return Err(Refusal::Refused);
    }
    let (part, faces) = (&kids[0], &kids[1..]);
    let owned = faces_of(part);
    let mut pairs = Vec::with_capacity(faces.len());
    for (f, d) in faces.iter().zip(dists) {
        if !owned.iter().any(|o| o.is_same(f)) {
            return Err(Refusal::Refused);
        }
        pairs.push((f.as_face().ok_or(Refusal::Refused)?, *d));
    }
    let pairs: Vec<_> = pairs.iter().map(|(f, d)| (f, *d)).collect();
    let options = OffsetOptions {
        tolerance: 1e-4,
        join: OffsetJoin::Intersection,
        ..Default::default()
    };
    let mut out = part
        .offset_shape(0.0, &pairs, options, &detached)
        .map_err(|_| Refusal::Refused)?;
    if out.shape_type() == ShapeType::Shell {
        out = solid_from_shell(&out).ok_or(Refusal::Refused)?;
    }
    if !valid(&out) {
        return Err(Refusal::Invalid);
    }
    let text = out
        .to_brep_text(BrepWriteOptions::default(), &detached)
        .map_err(|_| Refusal::Refused)?;
    Shape::from_brep_text(&text, &detached).map_err(|_| Refusal::Refused)
}

/// `_offset_faces`.
fn offset_faces(part: &Shape, pairs: &[(Shape, f64)]) -> FResult<Shape> {
    let pairs: Vec<&(Shape, f64)> = pairs.iter().filter(|(_, d)| d.abs() > 1e-9).collect();
    if pairs.is_empty() {
        return Ok(part.clone());
    }
    let faces: Vec<Shape> = pairs.iter().map(|(f, _)| f.clone()).collect();
    let dists: Vec<f64> = pairs.iter().map(|(_, d)| *d).collect();
    // solid_ops.py waits on its offset child for _OFFSET_TIMEOUT, beating meanwhile.
    crate::heartbeat::while_running(std::time::Duration::from_secs(180), || {
        offset_pass(part, &faces, &dists)
    })
    .map_err(|r| match r {
        Refusal::Invalid => Fail::msg(RAN_PAST),
        Refusal::Refused => Fail::msg(CANT_OFFSET),
    })
}

/// `_thicken_press_pull`: one face grown into a slab and booleaned in.
fn thicken_press_pull(part: &Shape, face: &Shape, d: f64) -> FResult<Shape> {
    let options = OffsetOptions {
        tolerance: 1e-4,
        join: OffsetJoin::Intersection,
        thickening: true,
        ..Default::default()
    };
    let slab = face
        .offset_thick_solid(d, &[], options, &ProgressRange::detached())
        .map_err(|_| Fail::msg(CANT_OFFSET))?;
    // OCCT hands the slab back inside out for one sign, and fusing that erases the body.
    let slab = if kernel::volume(&slab) < 0.0 {
        slab.reversed()
    } else {
        slab
    };
    let out = fused(part, &slab, d > 0.0)?;
    let (before, after) = (kernel::volume(part), kernel::volume(&out));
    if !valid(&out) || after <= 0.0 || (after > before) != (d > 0.0) {
        return Err(Fail::msg(RAN_PAST));
    }
    Ok(out)
}

/// `_sweep_press_pull`: the face extruded along its centre normal and booleaned.
fn sweep_press_pull(part: &Shape, face: &Shape, d: f64) -> FResult<Shape> {
    let n = normal(face);
    let dir = if d > 0.0 { n } else { -n } * d.abs();
    let prism = kernel::clean(&kernel::prism(face, dir.to_array())?)?;
    let out = fused(part, &prism, d > 0.0)?;
    if !valid(&out) {
        return Err(Fail::msg(SWEEP_REFUSAL));
    }
    let (before, after) = (kernel::volume(part), kernel::volume(&out));
    if after <= 0.0 || (after > before) != (d > 0.0) {
        return Err(Fail::msg(SWEEP_REFUSAL));
    }
    Ok(out)
}

/// `_press_pull`.
fn press_pull_shape(part: &Shape, face: &Shape, d: f64, clamp: bool, taper: f64) -> FResult<Shape> {
    if d.abs() < 1e-9 {
        return Ok(part.clone());
    }
    let t = surface_type(face);
    if t == Some(SurfaceType::Plane) {
        if faces_of(part).len() > 300 && kernel::area(face) < 1.0 {
            return Err(Fail::msg(
                "can't press/pull this region, it's a single mesh facet, not a clean face (the imported body is faceted, not prismatic)",
            ));
        }
        let dd = if clamp {
            clamp_planar(part, face, d)
        } else {
            d
        };
        if dd.abs() < 1e-9 {
            return Ok(part.clone());
        }
        let prism = prisms(face, dd, false, taper)?;
        return fused(part, &prism, dd > 0.0);
    }
    if offsettable_curved(t) {
        let dd = if matches!(t, Some(SurfaceType::Cylinder | SurfaceType::Cone)) {
            clamp_cylinder(face, d)
        } else {
            d
        };
        if let Ok(out) = offset_faces(part, &[(face.clone(), dd)]) {
            return Ok(out);
        }
        return thicken_press_pull(part, face, dd).or_else(|_| sweep_press_pull(part, face, dd));
    }
    // A wrapping surface of revolution thickens both ways and a BSpline only
    // outward; the inward BSpline case is where OCCT was measured to crash.
    let thickenable = match t {
        Some(SurfaceType::SurfaceOfRevolution) => true,
        Some(SurfaceType::BSplineSurface) => d > 0.0,
        _ => false,
    };
    if thickenable && face.as_face().is_some_and(|f| f.wraps()) {
        if let Ok(out) = thicken_press_pull(part, face, d) {
            return Ok(out);
        }
    }
    sweep_press_pull(part, face, d)
}

/// `_face_prism`: a tapered extrude for a flat face, a straight prism otherwise.
fn face_prism(face: &Shape, d: f64, taper: f64) -> FResult<Shape> {
    if surface_type(face) == Some(SurfaceType::Plane) {
        return prisms(face, d, false, taper);
    }
    let n = centre_normal(face);
    let refuse = || Fail::msg("Press/Pull: this face does not extrude into a valid solid");
    let prism = kernel::prism(face, (n * d).to_array()).map_err(|_| refuse())?;
    if !valid(&prism) {
        return Err(refuse());
    }
    Ok(prism)
}

/// build123d `face.normal_at(face.center())`.
fn centre_normal(face: &Shape) -> DVec3 {
    let c = centre(face);
    face.as_face()
        .and_then(|f| {
            let p = f.project_point(c).ok()??;
            f.point_and_normal(p.u, p.v).ok().map(|(_, n)| n)
        })
        .unwrap_or_else(|| normal(face))
}

fn selector_list(sel: &fundacad_core::schema::OneOrMany<Selector>) -> Vec<Selector> {
    sel.as_slice().to_vec()
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

/// The plane (point, normal) an `upTo` target contributes.
fn up_to_plane(ctx: &mut Ctx, f: &PressPull, act: usize, up: &Value) -> FResult<(DVec3, DVec3)> {
    let point = (up.get("by").and_then(Value::as_str) == Some("nearest"))
        .then(|| up.get("point"))
        .flatten()
        .filter(|p| !p.is_null());
    let mut target: Option<Shape> = None;
    if let Some(p) = point {
        let xyz: Vec<f64> = p
            .as_array()
            .ok_or_else(|| Fail::Internal("TypeError".into()))?
            .iter()
            .map(|c| c.as_f64().ok_or_else(|| Fail::Internal("TypeError".into())))
            .collect::<FResult<_>>()?;
        let [x, y, z] = xyz[..] else {
            return Err(Fail::Internal("TypeError".into()));
        };
        let mut best: Option<(f64, Shape)> = None;
        for b in &ctx.bodies {
            for fc in kernel::subshapes(b.shape(), Kind::Face) {
                let d = sa::distance_to_point(&fc, [x, y, z]).map_or(f64::INFINITY, |r| r.0);
                if best.as_ref().map_or(true, |(bd, _)| d < *bd) {
                    best = Some((d, fc));
                }
            }
        }
        target = best.map(|b| b.1);
    }
    let target = match target {
        Some(t) => Some(t),
        None => {
            let part = ctx.bodies[act].shape().clone();
            Resolver::new(Some(&mut ctx.diagnostics), Some(&f.id))
                .faces(&part, up)?
                .into_iter()
                .next()
        }
    };
    let Some(target) = target else {
        return Err(Fail::msg(
            "Press/Pull: the 'up to' target surface wasn't found",
        ));
    };
    Ok((centre(&target), normal(&target)))
}

/// `_distance_to_target`.
fn distance_to_target(face: &Shape, point: DVec3, n: DVec3) -> FResult<f64> {
    let (c, fnorm) = (centre(face), normal(face));
    let denom = fnorm.dot(n);
    if denom.abs() < 1e-6 {
        return Err(Fail::msg(
            "Press/Pull: the face is parallel to the 'up to' surface, can't reach it",
        ));
    }
    Ok((point - c).dot(n) / denom)
}

pub fn press_pull(ctx: &mut Ctx, f: &PressPull) -> FResult {
    let named = f.body.as_deref().filter(|b| !b.is_empty());
    let act = match named {
        Some(id) => ctx.find_body(id),
        None => Some(ctx.require_active("Press/Pull")?),
    };
    let Some(mut act) = act else {
        return Err(Fail::msg("Press/Pull: the target body no longer exists"));
    };
    let sels = selector_list(&f.face);
    let up = f
        .up_to
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| Fail::Internal("TypeError".into()))?
        .filter(truthy);
    let target = match &up {
        Some(up) => Some(up_to_plane(ctx, f, act, up)?),
        None => None,
    };
    let dist = ctx.val(&f.distance)?;
    let taper = ctx.val_or(f.taper.as_ref(), 0.0)?;
    if taper != 0.0 && !(-89.0 < taper && taper < 89.0) {
        return Err(Fail::msg(format!(
            "Press/Pull: taper must be between -89 and 89 degrees (got {})",
            py_g(taper)
        )));
    }
    let taper = if target.is_some() { 0.0 } else { taper };
    let mode = f
        .mode
        .as_ref()
        .map(|m| m.as_str())
        .filter(|m| !m.is_empty())
        .unwrap_or("auto")
        .to_owned();
    let targets: Option<Vec<String>> = f
        .extra
        .get("targets")
        .and_then(|t| serde_json::from_value(t.clone()).ok());
    let mut act_shape = ctx.bodies[act].shape().clone();
    for sel in &sels {
        if mode != "auto" {
            if let Some(i) = named.and_then(|id| ctx.find_body(id)) {
                act = i;
                act_shape = ctx.bodies[act].shape().clone();
            }
        }
        let found = resolve_field(
            ctx,
            &f.id,
            &act_shape,
            &fundacad_core::schema::OneOrMany::One(sel.clone()),
        )?;
        let Some(src) = found.into_iter().next() else {
            return Err(Fail::msg("no face found to press/pull"));
        };
        let d = match target {
            Some((p, n)) => distance_to_target(&src, p, n)?,
            None => dist,
        };
        if mode != "auto" {
            if d.abs() < 1e-9 {
                continue;
            }
            let prism = face_prism(&src, d, taper)?;
            let op = Operation::from(mode.as_str());
            combine(ctx, &f.id, prism, Some(&op), targets.as_deref(), None, None)?;
            continue;
        }
        act_shape = press_pull_shape(&act_shape, &src, d, false, taper)?;
        ctx.set_shape(act, act_shape.clone());
    }
    Ok(())
}

pub fn offset_face(ctx: &mut Ctx, f: &OffsetFace) -> FResult {
    let act = match f.body.as_deref().filter(|b| !b.is_empty()) {
        Some(id) => ctx.find_body(id),
        None => Some(ctx.require_active("Offset face")?),
    };
    let Some(act) = act else {
        return Err(Fail::msg("Offset face: the target body no longer exists"));
    };
    let part = ctx.bodies[act].shape().clone();
    let faces = resolve_field(ctx, &f.id, &part, &f.faces)?;
    if faces.is_empty() {
        return Err(Fail::msg("no face found to offset"));
    }
    guard_offsetable(&part, &faces, "Offset face")?;
    let d = ctx.val(&f.distance)?;
    if d == 0.0 {
        return Err(Fail::msg("Offset face: distance must not be 0"));
    }
    let pairs: Vec<(Shape, f64)> = faces
        .iter()
        .map(|fc| {
            let dd = if surface_type(fc) == Some(SurfaceType::Cylinder) {
                clamp_cylinder(fc, d)
            } else {
                clamp_planar(&part, fc, d)
            };
            (fc.clone(), dd)
        })
        .collect();
    if let Ok(out) = offset_faces(&part, &pairs) {
        ctx.set_shape(act, out);
        return Ok(());
    }
    // One BRepOffset pass refuses every face if one fails, so go face by face.
    let mut shape = part;
    for sel in f.faces.as_slice() {
        let one = fundacad_core::schema::OneOrMany::One(sel.clone());
        for fc in resolve_field(ctx, &f.id, &shape, &one)? {
            shape = press_pull_shape(&shape, &fc, d, true, 0.0)?;
        }
    }
    ctx.set_shape(act, shape);
    Ok(())
}
