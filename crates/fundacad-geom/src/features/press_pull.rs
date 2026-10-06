//! Moving faces: press/pull and offset face, the Python engine's `solid_ops.py` `_press_pull`,
//! `_offset_faces`, `_thicken_press_pull`, `_sweep_press_pull` and the
//! handlers of the Python engine's `builder.py`.
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
use opencascade::query::PointState;
use opencascade::select_access as sa;
use opencascade::shape_io::BrepWriteOptions;
use opencascade_sys as ffi;
use serde_json::Value;

use super::axis_push;
use super::blend::ops as blend_ops;
use super::boolean::combine;
use super::extrude::prisms;
use super::resize::{self, Bad, Resize};
use super::solid_ops::{
    faces_of, guard_offsetable, offsettable_curved, resolve_field, surface_type,
};
use crate::builder::{py_g, Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind, Kind};
use crate::mesh::edges::SMOOTH_EDGE_DEG;
use crate::select::entity::FaceEnt;
use crate::select::Resolver;

const CANT_OFFSET: &str = "can't offset this face by that amount";
const RAN_PAST: &str = "that offset ran past what this surface can hold, try a smaller amount";
const SWEEP_REFUSAL: &str = "can't press/pull this face, it is freeform and wraps around, so there is no one direction to push it in. Try a neighbouring face instead.";
const SWEEP_INVALID: &str = "can't press/pull this face, pushed straight out along its normal it leaves no valid solid. Try a smaller distance or a neighbouring face instead.";

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

const CLOSED_IN: &str = "the faces beside this one meet before it gets that far, try a smaller distance";

/// The first step of a push, short enough not to reach any other part of the body.
const FIRST_STEP: f64 = 0.05;

fn right_way(part: &Shape, out: &Shape, d: f64) -> bool {
    let (before, after) = (kernel::volume(part), kernel::volume(out));
    valid(out) && after > 0.0 && (after > before) == (d > 0.0)
}

/// The face of `slab` lying `along` from `face`'s plane and facing `dir`.
fn slab_face(slab: &Shape, face: &Shape, dir: DVec3, along: f64) -> Option<Shape> {
    let origin = centre(face);
    faces_of(slab).into_iter().find(|f| {
        normal(f).dot(dir) > 0.999 && ((centre(f) - origin).dot(dir) - along).abs() < 0.5 * along
    })
}

/// A flat face moved along its normal with each face around it carried along
/// its own surface to meet it, so a sloped side keeps its slope and a curved
/// one keeps its curve, instead of a straight wall rising off the old edge.
///
/// Offsetting the face in the body itself fails once it runs into another part
/// of the body, so the offset only takes a first short step there. That step's
/// slab is bounded by the face's own neighbours and nothing else, so pushed on
/// alone it goes as far as asked unless its sides meet, and merging it with
/// the body settles whatever it ran into. None where the face cannot follow its
/// neighbours at all, and the caller extrudes it straight.
fn follow_neighbours(part: &Shape, face: &Shape, d: f64) -> FResult<Option<Shape>> {
    // A round running into the face tangentially has no slope to carry on, so
    // the face sinks or rises inside it as a straight recess or boss.
    let smooth = kernel::subshapes(face, Kind::Edge)
        .iter()
        .any(|e| blend_ops::dihedral_deg(part, e).is_some_and(|a| a < SMOOTH_EDGE_DEG));
    if smooth {
        return Ok(None);
    }
    let step = FIRST_STEP.min(0.5 * d.abs());
    let Ok(stepped) = offset_faces(part, &[(face.clone(), step.copysign(d))]) else {
        return Ok(None);
    };
    let slab = if d > 0.0 {
        kernel::boolean_op(&stepped, &[part], BoolKind::Cut)
    } else {
        kernel::boolean_op(part, &[&stepped], BoolKind::Cut)
    };
    let Ok(slab) = slab.map(|s| kernel::unwrap_compound(&s)) else {
        return Ok(None);
    };
    let dir = normal(face) * d.signum();
    let lone = kernel::count(&slab, Kind::Solid) == 1;
    let Some(front) = lone.then(|| slab_face(&slab, face, dir, step)).flatten() else {
        return Ok(None);
    };
    let grown = offset_faces(&slab, &[(front.clone(), d.abs() - step)])
        .ok()
        .filter(|g| kernel::volume(g) > kernel::volume(&slab));
    let grown = match grown {
        Some(g) => g,
        None => collapsed(&slab, &front, face, dir, d.abs()).ok_or_else(|| Fail::msg(CLOSED_IN))?,
    };
    Ok(fused(part, &grown, d > 0.0)
        .ok()
        .filter(|out| right_way(part, out, d)))
}

/// The slab with its front face gone and its sides carried on until they meet
/// in a ridge or a point: a push past where the sides close in, which goes no
/// further however far it is asked to.
fn collapsed(slab: &Shape, front: &Shape, face: &Shape, dir: DVec3, reach: f64) -> Option<Shape> {
    let front = front.as_face()?;
    let out = slab
        .remove_features(&[&front], true, &ProgressRange::detached())
        .ok()?
        .shape;
    let closed = kernel::count(&out, Kind::Face) < kernel::count(slab, Kind::Face)
        && valid(&out)
        && kernel::volume(&out) > kernel::volume(slab);
    let (_, far) = kernel::axial_extent(&out, centre(face).to_array(), dir.to_array())?;
    (closed && far <= reach + 1e-6).then_some(out)
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
    let refusal = || {
        let wraps = face.as_face().is_some_and(|f| f.wraps());
        Fail::msg(if wraps { SWEEP_REFUSAL } else { SWEEP_INVALID })
    };
    if !valid(&out) {
        return Err(refusal());
    }
    let (before, after) = (kernel::volume(part), kernel::volume(&out));
    if after <= 0.0 || (after > before) != (d > 0.0) {
        return Err(refusal());
    }
    Ok(out)
}

fn built(r: Resize) -> FResult<Shape> {
    match r {
        Resize::Built(out) => Ok(out),
        Resize::Refused(f) => Err(f),
        Resize::Failed => Err(resize::resize_invalid()),
    }
}

/// A cylinder, cone, sphere or torus face resized about its own axis or
/// centre. Where that cannot be built, a face nothing runs smoothly into is
/// offset by the kernel instead, as far as asked and checked the same way.
fn resize_round(part: &Shape, face: &Shape, d: f64, follow: bool) -> FResult<Shape> {
    let r = match resize::resize(part, std::slice::from_ref(face), d, follow) {
        // Adding material never cuts a body apart. A sphere fused with the
        // shell around it comes back as two solids, which is the kernel's doing.
        Resize::Refused(Fail::Value { code: Some("cutsApart"), .. }) if d > 0.0 => Resize::Failed,
        r => r,
    };
    match r {
        Resize::Failed if !resize::has_tangent_neighbour(part, face) => {
            let out = offset_faces(part, &[(face.clone(), d)]).map_err(|_| resize::resize_invalid())?;
            match resize::checked_solid(part, &out, d < 0.0) {
                Ok(out) => Ok(out),
                Err(Bad::Refused(f)) => Err(f),
                Err(Bad::Failed) => Err(resize::resize_invalid()),
            }
        }
        r => built(r),
    }
}

/// The selected faces that together are every face of one closed tangent
/// run, such as all four faces of a slot, each run to be resized once, and
/// which of `faces` that leaves nothing to do for: the run's faces, and the
/// faces on the same surface as a round face picked before them, which move
/// with it.
fn whole_runs(part: &Shape, faces: &[Shape]) -> (Vec<Vec<Shape>>, Vec<bool>) {
    let n = faces.len();
    let mut taken = vec![false; n];
    let mut runs = Vec::new();
    if n < 2 {
        return (runs, taken);
    }
    for i in 0..n {
        if taken[i] || !offsettable_curved(surface_type(&faces[i])) {
            continue;
        }
        let Some(info) = resize::describe(part, &faces[i]) else { continue };
        let on = |p: &DVec3| {
            (0..n).find(|&j| kernel::distance_to_point(&faces[j], p.to_array()).is_some_and(|d| d < 1e-6))
        };
        let hits: Vec<Option<usize>> = info.tangent.run.iter().map(on).collect();
        if info.tangent.faces == 0 {
            hits.into_iter().flatten().filter(|&j| j != i).for_each(|j| taken[j] = true);
            continue;
        }
        let Some(hits) = hits.into_iter().collect::<Option<Vec<usize>>>() else { continue };
        if !info.tangent.closed {
            continue;
        }
        let mut run: Vec<Shape> = Vec::new();
        for j in hits {
            if !run.iter().any(|f| f.is_same(&faces[j])) {
                run.push(faces[j].clone());
            }
        }
        for (k, f) in faces.iter().enumerate() {
            taken[k] |= run.iter().any(|r| r.is_same(f));
        }
        runs.push(run);
    }
    (runs, taken)
}

/// `_press_pull`.
fn press_pull_shape(part: &Shape, face: &Shape, d: f64, clamp: bool, taper: f64, follow: bool) -> FResult<Shape> {
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
        if taper == 0.0 {
            if let Some(out) = follow_neighbours(part, face, dd)? {
                return Ok(out);
            }
        }
        let prism = prisms(face, dd, false, taper)?;
        return fused(part, &prism, dd > 0.0);
    }
    if offsettable_curved(t) {
        return resize_round(part, face, d, follow);
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

/// `_distance_to_target`, travelling along `dir` from `c`.
fn distance_to_target(c: DVec3, dir: DVec3, point: DVec3, n: DVec3) -> FResult<f64> {
    let denom = dir.dot(n);
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
    let along_axis = f.direction.as_ref().is_some_and(|d| d.as_str() == "axis");
    let targets: Option<Vec<String>> = f.targets.clone();
    let follow = f.follow_tangent.unwrap_or(true);
    let mut act_shape = ctx.bodies[act].shape().clone();
    let mut warned = false;
    let mut skip = vec![false; sels.len()];
    if mode == "auto" && target.is_none() && !along_axis && sels.len() > 1 {
        let mut quiet = Resolver::new(None, Some(&f.id));
        let start: Option<Vec<Shape>> = sels
            .iter()
            .map(|sel| quiet.face_selectors(&act_shape, &fundacad_core::schema::OneOrMany::One(sel.clone())).ok()?.into_iter().next())
            .collect();
        let (runs, taken) = start.map(|s| whole_runs(&act_shape, &s)).unwrap_or_default();
        if taken.len() == sels.len() {
            skip = taken;
        }
        for run in runs {
            let out = built(resize::resize(&act_shape, &run, dist, follow))?;
            if !warned && dist < 0.0 && broke_through(&act_shape, &out, &kernel::compound(&run)) {
                warned = true;
                let name = ctx.bodies[act].name.clone();
                ctx.advise(&f.id, "brokeThrough", format!("the offset broke through the outside of {name}"));
            }
            act_shape = out;
            ctx.set_shape(act, act_shape.clone());
        }
    }
    for (sel, _) in sels.iter().zip(&skip).filter(|(_, s)| !**s) {
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
            Some((p, n)) if along_axis => {
                let axis = axis_push::axis_of(&act_shape, &src)?;
                distance_to_target(centre(&src), axis.dir, p, n)?
            }
            Some((p, n)) => distance_to_target(centre(&src), normal(&src), p, n)?,
            None => dist,
        };
        if mode != "auto" {
            if d.abs() < 1e-9 {
                continue;
            }
            let prism = if along_axis {
                axis_push::axis_prism(&act_shape, &src, d)?
            } else {
                face_prism(&src, d, taper)?
            };
            let op = Operation::from(mode.as_str());
            // The body pushed from is named by the feature, so its eye does not
            // keep the prism off it.
            let mut hidden = ctx.hidden_bodies.clone();
            hidden.remove(&ctx.bodies[act].id);
            combine(ctx, &f.id, prism, Some(&op), targets.as_deref(), Some(hidden), None)?;
            continue;
        }
        let out = if along_axis {
            axis_push::push_along_axis(&act_shape, &src, d)?
        } else {
            press_pull_shape(&act_shape, &src, d, false, taper, follow)?
        };
        let may_break_out = along_axis || surface_type(&src) != Some(SurfaceType::Plane);
        if !warned && d < 0.0 && may_break_out && broke_through(&act_shape, &out, &src) {
            warned = true;
            let name = ctx.bodies[act].name.clone();
            ctx.advise(&f.id, "brokeThrough", format!("the offset broke through the outside of {name}"));
        }
        act_shape = out;
        ctx.set_shape(act, act_shape.clone());
    }
    Ok(())
}

/// A point inside the face's trimmed boundary.
fn inner_point(face: &Shape) -> Option<DVec3> {
    let f = face.as_face()?;
    let b = f.uv_bounds().ok()?;
    let at = |s: f64, t: f64| (b.u_min + s * (b.u_max - b.u_min), b.v_min + t * (b.v_max - b.v_min));
    let grid = (0..5).flat_map(|i| (0..5).map(move |j| ((f64::from(i) + 0.5) / 5.0, (f64::from(j) + 0.5) / 5.0)));
    std::iter::once((0.5, 0.5)).chain(grid).find_map(|(s, t)| {
        let (u, v) = at(s, t);
        (f.classify_uv(u, v, 1e-7).ok()? == PointState::In)
            .then(|| f.point_and_normal(u, v).ok().map(|(p, _)| p))
            .flatten()
    })
}

/// Did pushing `pushed` in eat into a face it does not touch? An offset curved
/// face grows or shrinks as it moves, so it can run out through the far side
/// of a thin wall. What it removed is bounded by the pushed face, its
/// neighbours, which it legitimately trims, and the faces it made; any other
/// face of the body on that boundary is where it broke out.
fn broke_through(before: &Shape, after: &Shape, pushed: &Shape) -> bool {
    const TOL: f64 = 1e-3;
    let Ok(removed) = kernel::boolean_op(before, &[after], BoolKind::Cut) else {
        return false;
    };
    let Some(rb) = kernel::bbox(&removed) else {
        return false;
    };
    let corners = kernel::subshapes(pushed, Kind::Vertex);
    let near = |p: [f64; 3], b: [f64; 6]| (0..3).all(|i| b[i] - TOL <= p[i] && p[i] <= b[i + 3] + TOL);
    let others: Vec<(Shape, [f64; 6])> = faces_of(before)
        .into_iter()
        .filter(|fc| !fc.is_same(pushed))
        .filter(|fc| {
            let vs = kernel::subshapes(fc, Kind::Vertex);
            !vs.iter().any(|v| corners.iter().any(|c| c.is_same(v)))
        })
        .filter_map(|fc| kernel::bbox(&fc).map(|b| (fc, b)))
        .filter(|(_, b)| (0..3).all(|i| b[i] <= rb[i + 3] + TOL && b[i + 3] >= rb[i] - TOL))
        .collect();
    if others.is_empty() {
        return false;
    }
    kernel::subshapes(&removed, Kind::Face).iter().filter_map(inner_point).any(|p| {
        let p = p.to_array();
        others
            .iter()
            .any(|(fc, b)| near(p, *b) && kernel::distance_to_point(fc, p).is_some_and(|d| d < TOL))
    })
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
    let follow = f.follow_tangent.unwrap_or(true);
    let round = faces.iter().any(|fc| offsettable_curved(surface_type(fc)));
    let sels = f.faces.as_slice();
    let mut skip = vec![false; sels.len()];
    let mut shape = part;
    let mut warned = false;
    if round {
        let mut quiet = Resolver::new(None, Some(&f.id));
        let picked: Vec<Vec<Shape>> = sels
            .iter()
            .map(|sel| quiet.face_selectors(&shape, &fundacad_core::schema::OneOrMany::One(sel.clone())).unwrap_or_default())
            .collect();
        let flat: Vec<Shape> = picked.iter().flatten().cloned().collect();
        let (runs, taken) = whole_runs(&shape, &flat);
        let mut at = 0;
        for (i, p) in picked.iter().enumerate() {
            skip[i] = !p.is_empty() && taken[at..at + p.len()].iter().all(|t| *t);
            at += p.len();
        }
        for run in runs {
            let out = built(resize::resize(&shape, &run, d, follow))?;
            if !warned && d < 0.0 && broke_through(&shape, &out, &kernel::compound(&run)) {
                warned = true;
            }
            shape = out;
        }
    } else {
        let pairs: Vec<(Shape, f64)> = faces.iter().map(|fc| (fc.clone(), clamp_planar(&shape, fc, d))).collect();
        if let Ok(out) = offset_faces(&shape, &pairs) {
            ctx.set_shape(act, out);
            return Ok(());
        }
    }
    // Otherwise face by face, since one BRepOffset pass refuses every face if one fails.
    for (sel, _) in sels.iter().zip(&skip).filter(|(_, s)| !**s) {
        let one = fundacad_core::schema::OneOrMany::One(sel.clone());
        for fc in resolve_field(ctx, &f.id, &shape, &one)? {
            let out = press_pull_shape(&shape, &fc, d, true, 0.0, follow)?;
            let curved = surface_type(&fc) != Some(SurfaceType::Plane);
            if !warned && d < 0.0 && curved && broke_through(&shape, &out, &fc) {
                warned = true;
            }
            shape = out;
        }
    }
    if warned {
        let name = ctx.bodies[act].name.clone();
        ctx.advise(&f.id, "brokeThrough", format!("the offset broke through the outside of {name}"));
    }
    ctx.set_shape(act, shape);
    Ok(())
}
