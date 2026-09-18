//! Revolve about a world axis or a stored line, sidecar/revolve_feature.py
//! `_handle_revolve` and `_revolve_axis`.
//!
//! Not ported yet: re-resolving `axisEdge` against the bodies; an axis aimed at
//! an edge uses its cached line, which is where the Python engine falls back to
//! when that edge stops resolving.

use fundacad_core::schema::{AxisSpec, Revolve};
use opencascade::primitives::Shape;

use super::sketch::{region_target, require};
use super::combine;
use crate::builder::{py_g_prec, Ctx, FResult, Fail};
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
    let (origin, dir, axis_label) = axis_of(f);
    if pitch != 0.0 {
        let solid = screw_revolve(&sk, origin, dir, angle, pitch)?;
        return combine(
            ctx,
            &f.id,
            solid,
            f.operation.as_ref(),
            f.targets.as_deref(),
            None,
            None,
        );
    }
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

fn turn_clearance(tall: f64) -> f64 {
    f64::max(1e-3, 1e-4 * tall)
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn mul(a: [f64; 3], k: f64) -> [f64; 3] {
    [a[0] * k, a[1] * k, a[2] * k]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn unit(a: [f64; 3]) -> [f64; 3] {
    let m = norm(a);
    [a[0] / m, a[1] / m, a[2] / m]
}

/// revolve_feature.py `_screw_revolve`: a pipe sweep along a helix whose
/// binormal is pinned to the axis, so each section stays a meridian section.
fn screw_revolve(
    profile: &Shape,
    origin: [f64; 3],
    dir: [f64; 3],
    angle: f64,
    pitch: f64,
) -> FResult<Shape> {
    let d = unit(dir);
    let o = origin;
    let mut faces = kernel::subshapes(profile, Kind::Face);
    if faces.is_empty() {
        return Err(Fail::msg("Revolve: no closed profile to sweep"));
    }
    if angle.abs() > 360.0 {
        let (zmin, zmax) = kernel::axial_extent(&kernel::compound(&faces), o, d)
            .ok_or_else(|| Fail::Internal("Standard_Failure".into()))?;
        let tall = zmax - zmin;
        let clear = turn_clearance(tall);
        if tall > pitch.abs() + clear {
            return Err(Fail::msg(format!(
                "Revolve: the profile is {} mm tall along the axis but climbs only {} mm each turn, so every turn would run into the one before. Raise the pitch, or draw a shorter profile, or stay within one turn.",
                py_g_prec(tall, 4),
                py_g_prec(pitch.abs(), 4)
            )));
        }
        // Crest landing exactly on root makes a solid every boolean quietly ignores,
        // so the profile is squeezed a hair short of the next turn.
        if tall > pitch.abs() - clear {
            let hold = dot(o, d) + (zmin + zmax) / 2.0;
            let factor = (pitch.abs() - clear) / tall;
            faces = faces
                .iter()
                .map(|f| kernel::axial_scale(f, factor, d, hold))
                .collect::<Result<_, _>>()?;
        }
    }
    let turns = angle / 360.0;
    let rise = turns * pitch;
    let mut out: Option<Shape> = None;
    for face in &faces {
        let c = kernel::face_area_centre(face)
            .ok_or_else(|| Fail::Internal("Standard_Failure".into()))?;
        let rel = sub([c[1], c[2], c[3]], o);
        let axial = dot(rel, d);
        let radial = sub(rel, mul(d, axial));
        let r = norm(radial);
        if r < 1e-6 {
            return Err(Fail::msg(
                "Revolve: a climbing revolve needs a profile that sits off to one side of the axis. This one is centred on it, so there is no direction for it to start from.",
            ));
        }
        let at = add(o, mul(d, axial));
        let x = unit(radial);
        let z = if rise >= 0.0 { d } else { mul(d, -1.0) };
        let swept = |wire: &Shape| -> FResult<Shape> {
            kernel::screw_sweep(wire, at, x, z, d, r, pitch.abs(), rise.abs(), pitch < 0.0).map_err(
                |e| {
                    if e.0 == "ScrewSweepNotDone" {
                        Fail::msg("Revolve: the climbing sweep failed. A profile that is very close to the axis, or a pitch far larger than the profile, can make a surface that crosses itself.")
                    } else {
                        Fail::from(e)
                    }
                },
            )
        };
        let wires = kernel::face_wire_list(face)?;
        let mut solid = swept(&wires[0])?;
        for hole in &wires[1..] {
            let h = swept(hole)?;
            solid = kernel::boolean_op(&solid, &[&h], kernel::BoolKind::Cut)?;
        }
        out = Some(match out {
            None => solid,
            Some(prev) => kernel::boolean_op(&prev, &[&solid], kernel::BoolKind::Fuse)?,
        });
    }
    out.ok_or_else(|| Fail::msg("Revolve: no closed profile to sweep"))
}
