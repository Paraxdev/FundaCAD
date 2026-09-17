//! Joints, sidecar/joints.py: one body placed by mating a frame on it to a
//! frame on another, both re-resolved every rebuild so the assembly follows
//! the parts.

use fundacad_core::schema::{Joint, MateConnector, Num, Selector, Vec3};
use opencascade::primitives::Shape;
use opencascade::select_access as sa;
use opencascade_sys::joint_ops as ffi;
use serde_json::json;

use crate::builder::{Ctx, FResult, Fail, BAD_REQUEST};

use crate::select::{entity::EdgeEnt, Resolver};

/// A mate connector: an origin, the mating direction and a rotational
/// reference, `None` where the x axis is left to the kernel.
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    origin: [f64; 3],
    zdir: [f64; 3],
    xdir: [f64; 3],
}

impl Frame {
    fn wire(&self) -> [f64; 9] {
        let mut out = [0.0; 9];
        out[..3].copy_from_slice(&self.origin);
        out[3..6].copy_from_slice(&self.zdir);
        out[6..].copy_from_slice(&self.xdir);
        out
    }
}

fn v3(v: &Vec3) -> [f64; 3] {
    [v[0].get(), v[1].get(), v[2].get()]
}

fn length(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// `plane(o, z, x)`: a zero z axis is a refusal, a zero x is no x at all.
fn frame(origin: [f64; 3], zdir: [f64; 3], xdir: Option<[f64; 3]>) -> FResult<Frame> {
    if length(zdir) < 1e-9 {
        return Err(Fail::Value {
            message: "joint: a connector's axis is zero length".into(),
            code: Some(BAD_REQUEST),
        });
    }
    Ok(Frame {
        origin,
        zdir,
        xdir: xdir.filter(|x| length(*x) > 1e-9).unwrap_or([0.0; 3]),
    })
}

/// `_joint_body_shape`.
fn body_shape<'a>(ctx: &'a Ctx, id: Option<&String>) -> Option<&'a Shape> {
    let i = ctx.find_body(id?)?;
    Some(ctx.bodies[i].shape())
}

fn resolve_one(
    ctx: &mut Ctx,
    shape: &Shape,
    sel: &Selector,
    fid: &str,
    faces: bool,
) -> FResult<Option<Shape>> {
    let mut diag = std::mem::take(&mut ctx.diagnostics);
    let mut r = Resolver::new(Some(&mut diag), Some(fid));
    let one = if faces {
        r.face_selectors(shape, &fundacad_core::schema::OneOrMany::One(sel.clone()))
    } else {
        r.edge_selectors(shape, &fundacad_core::schema::OneOrMany::One(sel.clone()))
    };
    ctx.diagnostics = diag;
    Ok(one?.into_iter().next())
}

/// `_joint_frame`.
fn connector(ctx: &mut Ctx, spec: &MateConnector, fid: &str) -> FResult<Option<Frame>> {
    if let Some(origin) = &spec.origin {
        let z = spec.zdir.as_ref().map_or([0.0, 0.0, 1.0], v3);
        return frame(v3(origin), z, spec.xdir.as_ref().map(v3)).map(Some);
    }
    if let Some(datum) = &spec.datum {
        let Some(d) = ctx.datums.get(datum).copied() else {
            return Ok(None);
        };
        return frame(d.origin, d.normal, Some(d.xdir)).map(Some);
    }
    let Some(shape) = body_shape(ctx, spec.body.as_ref()).cloned() else {
        return Ok(None);
    };
    if let Some(sel) = &spec.face {
        let Some(face) = resolve_one(ctx, &shape, sel, fid, true)? else {
            return Ok(None);
        };
        let probe = sa::face_probe(&face);
        let centre = probe.and_then(|p| p.centre).unwrap_or([0.0; 3]);
        let normal = probe.and_then(|p| p.normal).unwrap_or([0.0; 3]);
        return frame(centre, normal, None).map(Some);
    }
    if let Some(sel) = &spec.edge {
        let Some(edge) = resolve_one(ctx, &shape, sel, fid, false)? else {
            return Ok(None);
        };
        let Ok(ent) = EdgeEnt::new(edge) else {
            return Ok(None);
        };
        return frame(ent.mid.to_array(), ent.dir().to_array(), None).map(Some);
    }
    Err(Fail::Value {
        message: "joint: a connector needs one of origin, datum, face or edge".into(),
        code: Some(BAD_REQUEST),
    })
}

pub fn handle(ctx: &mut Ctx, f: &Joint) -> FResult {
    let Some(moving) = ctx.find_body(&f.moving) else {
        ctx.skip_feature(
            &f.id,
            "joint",
            "the body to position is missing or was consumed",
        );
        return Ok(());
    };
    let mate = connector(ctx, &f.mate, &f.id)?;
    let fixed = connector(ctx, &f.to, &f.id)?;
    let (Some(mate), Some(fixed)) = (mate, fixed) else {
        ctx.skip_feature(
            &f.id,
            "joint",
            "a mate reference no longer resolves, the body was left in place",
        );
        return Ok(());
    };

    // The mate axis rides the datum mark channel so the frontend can stand its
    // offset and angle handles on the line the joint turns about.
    let n = length(fixed.zdir);
    let dir = fixed.zdir.map(|c| c / n);
    ctx.datum_marks.insert(
        f.id.clone(),
        json!({"kind": "axis", "origin": fixed.origin, "dir": dir}),
    );

    let val = |n: &Option<Num>| ctx.val_or(n.as_ref(), 0.0);
    let offset = val(&f.offset)?;
    let angle = val(&f.angle)?;
    let shape = ctx.bodies[moving].shape().clone();
    let moved = ffi::jt_mated(
        shape.raw(),
        &fixed.wire(),
        &mate.wire(),
        offset,
        angle,
        f.flush.unwrap_or(false),
    )
    .map_err(|e| Fail::Internal(e.what().to_owned()))?;
    ctx.set_shape(moving, Shape::from_raw(moved));
    Ok(())
}
