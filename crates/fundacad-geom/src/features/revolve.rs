//! Revolve about a world axis or a stored line, sidecar/revolve_feature.py
//! `_handle_revolve` and `_revolve_axis`.
//!
//! Not ported yet: a `pitch` (the screw revolve) and re-resolving `axisEdge`
//! against the bodies; an axis aimed at an edge uses its cached line, which is
//! where the Python engine falls back to when that edge stops resolving.

use fundacad_core::schema::{AxisSpec, Revolve};
use opencascade::primitives::Shape;

use super::sketch::{region_target, require};
use super::{combine, not_ported};
use crate::builder::{Ctx, FResult, Fail};
use crate::kernel::{self, Kind};

fn axis_of(f: &Revolve) -> ([f64; 3], [f64; 3], String) {
    match &f.axis {
        AxisSpec::Named(a) => {
            let dir = match a.as_str() {
                "X" => [1.0, 0.0, 0.0],
                "Y" => [0.0, 1.0, 0.0],
                _ => [0.0, 0.0, 1.0],
            };
            ([0.0; 3], dir, a.as_str().to_owned())
        }
        AxisSpec::Line(l) => {
            let v = |r: &[fundacad_core::schema::Real; 3]| [r[0].get(), r[1].get(), r[2].get()];
            let (o, d) = (v(&l.origin), v(&l.dir));
            let repr = format!(
                "{{'origin': [{}, {}, {}], 'dir': [{}, {}, {}]}}",
                l.origin[0].0, l.origin[1].0, l.origin[2].0, l.dir[0].0, l.dir[1].0, l.dir[2].0
            );
            (o, d, repr)
        }
    }
}

pub fn handle(ctx: &mut Ctx, f: &Revolve) -> FResult {
    let entry = require(ctx, &f.sketch, "revolve")?;
    let pts: Vec<[f64; 3]> = f
        .regions
        .iter()
        .flatten()
        .map(|p| [p[0].get(), p[1].get(), p[2].get()])
        .collect();
    let sk = match region_target(ctx, &pts, entry)? {
        Some(s) => s,
        None => entry
            .sketch
            .clone()
            .ok_or_else(|| Fail::msg("sketch has no closed profile to revolve"))?,
    };
    let mut angle = ctx.val(&f.angle)?;
    if angle == 0.0 {
        return Err(Fail::msg(
            "Revolve: angle must not be 0, nothing would be swept",
        ));
    }
    let pitch = ctx.val_or(f.pitch.as_ref(), 0.0)?;
    if pitch != 0.0 {
        return Err(not_ported("revolve with a pitch"));
    }
    let (origin, dir, axis_label) = axis_of(f);
    angle = angle.clamp(-360.0, 360.0);
    let sign = if angle >= 0.0 { 1.0 } else { -1.0 };
    let mut arc = angle % (sign * 360.0);
    if arc == 0.0 {
        arc = sign * 360.0;
    }
    let solid = revolve_faces(&sk, origin, dir, arc).map_err(|name| {
        Fail::msg(format!(
            "Revolve failed, the profile probably crosses the axis of revolution ({axis_label}). Move it fully to one side (it may touch the axis, but not cross it). [{name}]"
        ))
    })?;
    combine(
        ctx,
        &f.id,
        solid,
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        None,
    )
}

fn revolve_faces(sk: &Shape, origin: [f64; 3], dir: [f64; 3], arc: f64) -> Result<Shape, String> {
    let mut solids = Vec::new();
    for face in kernel::subshapes(sk, Kind::Face) {
        solids.push(kernel::revolve(&face, origin, dir, arc).map_err(|e| e.0)?);
    }
    let c = kernel::compound(&solids);
    kernel::clean(&c).map_err(|e| e.0)
}
