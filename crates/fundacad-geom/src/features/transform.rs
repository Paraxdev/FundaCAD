//! Move, duplicate, scale, mirror and remove body, sidecar/builder.py
//! `_handle_move`, `_handle_duplicate`, `_handle_scale`, `_handle_mirror` and
//! `_handle_remove_body`.

use std::collections::HashSet;

use fundacad_core::schema::{Mirror, Move, RemoveBody, Scale};

use crate::builder::plane::{plane_of, PlaneRef};
use crate::builder::{Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind};

/// The bodies a move-like feature acts on: the listed ids (stale ones as
/// `None`), or the active body.
fn targets(ctx: &Ctx, ids: Option<&Vec<String>>, label: &str) -> FResult<Vec<Option<usize>>> {
    match ids.filter(|v| !v.is_empty()) {
        Some(ids) => Ok(ids.iter().map(|id| ctx.find_body(id)).collect()),
        None => Ok(vec![Some(ctx.require_active(label)?)]),
    }
}

fn placement(ctx: &Ctx, m: &Move) -> FResult<([f64; 3], [f64; 3])> {
    let v = |n: &Option<_>| ctx.val_or(n.as_ref(), 0.0);
    let r = [v(&m.rx)?, v(&m.ry)?, v(&m.rz)?];
    let d = [v(&m.dx)?, v(&m.dy)?, v(&m.dz)?];
    Ok((r, d))
}

fn placed(
    shape: &opencascade::primitives::Shape,
    r: [f64; 3],
    d: [f64; 3],
) -> FResult<opencascade::primitives::Shape> {
    let mut sh = shape.clone();
    if r.iter().any(|x| *x != 0.0) {
        sh = kernel::rotated(&sh, r)?;
    }
    if d.iter().any(|x| *x != 0.0) {
        sh = kernel::translated(&sh, d)?;
    }
    Ok(sh)
}

pub fn move_bodies(ctx: &mut Ctx, m: &Move) -> FResult {
    let (r, d) = placement(ctx, m)?;
    for t in targets(ctx, m.bodies.as_ref(), "Move")? {
        let Some(i) = t else {
            ctx.skip_feature(&m.id, "move", "target body already consumed or missing");
            continue;
        };
        let sh = placed(ctx.bodies[i].shape(), r, d)?;
        ctx.set_shape(i, sh);
    }
    Ok(())
}

pub fn duplicate(ctx: &mut Ctx, m: &Move) -> FResult {
    let (r, d) = placement(ctx, m)?;
    for t in targets(ctx, m.bodies.as_ref(), "Duplicate")? {
        let Some(i) = t else {
            ctx.skip_feature(
                &m.id,
                "duplicate",
                "target body already consumed or missing",
            );
            continue;
        };
        let copy = kernel::copy(ctx.bodies[i].shape())?;
        let sh = placed(&copy, r, d)?;
        let name = format!("{} copy", ctx.bodies[i].name);
        ctx.new_body(sh, Some(name), None);
    }
    Ok(())
}

pub fn scale(ctx: &mut Ctx, s: &Scale) -> FResult {
    let tgts = targets(ctx, s.bodies.as_ref(), "Scale")?;
    let factor = ctx.val(&s.factor)?;
    let axes = [
        ctx.val_or(s.sx.as_ref(), factor)?,
        ctx.val_or(s.sy.as_ref(), factor)?,
        ctx.val_or(s.sz.as_ref(), factor)?,
    ];
    for (name, v) in [
        ("factor", factor),
        ("sx", axes[0]),
        ("sy", axes[1]),
        ("sz", axes[2]),
    ] {
        if v == 0.0 {
            return Err(Fail::msg(format!(
                "Scale: {name} must not be 0, it would collapse the body flat"
            )));
        }
    }
    let uniform = axes == [factor; 3];
    for t in tgts {
        let Some(i) = t else {
            ctx.skip_feature(&s.id, "scale", "target body already consumed or missing");
            continue;
        };
        let shape = ctx.bodies[i].shape();
        let about = match &s.about {
            Some(a) => [a[0].get(), a[1].get(), a[2].get()],
            None => kernel::location_translation(shape),
        };
        let f = if uniform { [factor; 3] } else { axes };
        let out = kernel::scaled(shape, f, about, uniform)?;
        ctx.set_shape(i, out);
    }
    Ok(())
}

pub fn mirror(ctx: &mut Ctx, m: &Mirror) -> FResult {
    let i = ctx.require_active("Mirror")?;
    let plane = plane_of(PlaneRef::Name(m.plane.as_str()), &ctx.datums)?;
    let shape = ctx.bodies[i].shape();
    let mirrored = kernel::mirrored(shape, plane.origin, plane.z)?;
    let wrapped = kernel::compound([&mirrored]);
    let fused = kernel::boolean_op(shape, &[&wrapped], BoolKind::Fuse)?;
    ctx.set_shape(i, fused);
    Ok(())
}

pub fn remove_body(ctx: &mut Ctx, r: &RemoveBody) -> FResult {
    let ids: HashSet<String> = r.bodies.iter().cloned().collect();
    let have: HashSet<&str> = ctx.bodies.iter().map(|b| b.id.as_str()).collect();
    let mut missing: Vec<&str> = ids
        .iter()
        .map(String::as_str)
        .filter(|i| !have.contains(i))
        .collect();
    missing.sort_unstable();
    if !missing.is_empty() {
        return Err(Fail::msg(format!(
            "Remove: no such body {}, it may have been renumbered or consumed by an earlier feature",
            missing.join(", ")
        )));
    }
    ctx.remove_bodies(&ids);
    Ok(())
}
