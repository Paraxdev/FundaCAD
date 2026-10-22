//! A helical thread along a round face. The face is found again at every
//! build, so a thread follows its hole or shaft when that changes size.
//!
//! Each start is its own single profile sweep on a meridian turned 360k/N about
//! the axis: profiles stacked in one sketch and swept once leave open shells.

use fundacad_core::schema::{Hand, Operation, Thread};
use glam::DVec3;
use opencascade::primitives::Shape;
use serde_json::Value;

use super::face_anchor::cylinder_axis;
use super::revolve::screw_revolve;
use crate::builder::{Ctx, FResult, Fail, BAD_REQUEST};
use crate::kernel::{self, BoolKind, Kind};
use crate::select::Resolver;

const REFERENCE_NOT_FOUND: &str = "referenceNotFound";

fn bad(message: impl Into<String>) -> Fail {
    Fail::Value { message: message.into(), code: Some(BAD_REQUEST) }
}

fn missing_ref(message: impl Into<String>) -> Fail {
    Fail::Value { message: message.into(), code: Some(REFERENCE_NOT_FOUND) }
}

fn arr(v: DVec3) -> [f64; 3] {
    v.to_array()
}

fn pick_body(ctx: &Ctx, f: &Thread, sel: &Value) -> FResult<usize> {
    let named = f.body.as_deref().or_else(|| sel.get("body").and_then(Value::as_str)).filter(|b| !b.is_empty());
    if let Some(bid) = named {
        return ctx.find_body(bid).ok_or_else(|| missing_ref("Thread: the body to thread no longer exists"));
    }
    if ctx.bodies.is_empty() {
        return Err(bad("Thread needs an existing body"));
    }
    let point = sel.get("point").and_then(Value::as_array).and_then(|p| {
        let v: Vec<f64> = p.iter().filter_map(Value::as_f64).collect();
        (v.len() == 3).then(|| [v[0], v[1], v[2]])
    });
    let Some(p) = point else { return Ok(ctx.bodies.len() - 1) };
    let mut best = (f64::INFINITY, ctx.bodies.len() - 1);
    for (i, b) in ctx.bodies.iter().enumerate() {
        let d = kernel::distance_to_point(b.shape(), p).unwrap_or(f64::INFINITY);
        if d < best.0 {
            best = (d, i);
        }
    }
    Ok(best.1)
}

/// The meridians to probe from: a partial round face may not cover the first.
fn meridians(d: DVec3) -> Vec<DVec3> {
    let x = d.any_orthonormal_vector();
    let y = d.cross(x);
    (0..8)
        .map(|k| {
            let t = k as f64 * std::f64::consts::FRAC_PI_4;
            x * t.cos() + y * t.sin()
        })
        .collect()
}

pub fn handle(ctx: &mut Ctx, f: &Thread) -> FResult {
    let sel = serde_json::to_value(&f.face).map_err(|_| Fail::Internal("TypeError".into()))?;
    let body = ctx.editable(pick_body(ctx, f, &sel)?, "Thread")?;
    let shape = ctx.bodies[body].shape().clone();
    let face = Resolver::new(Some(&mut ctx.diagnostics), Some(&f.id))
        .faces(&shape, &sel)?
        .into_iter()
        .next()
        .ok_or_else(|| missing_ref("Thread: the round face to thread is no longer in the model"))?;
    let (o, mut d, r) = cylinder_axis(&face).ok_or_else(|| bad("Thread: the face must be round, a shaft or a bore"))?;
    if let Some(h) = &f.axis {
        if d.dot(DVec3::new(h[0].get(), h[1].get(), h[2].get())) < 0.0 {
            d = -d;
        }
    }

    let pitch = ctx.val(&f.pitch)?;
    if !(pitch > 0.0) {
        return Err(bad("Thread: the pitch must be greater than 0"));
    }
    let starts_raw = ctx.val_or(f.starts.as_ref(), 1.0)?;
    if starts_raw.fract() != 0.0 || !(1.0..=8.0).contains(&starts_raw) {
        return Err(bad("Thread: starts must be a whole number from 1 to 8"));
    }
    let starts = starts_raw as usize;
    let lead = pitch * starts as f64;
    let clearance = ctx.val_or(f.clearance.as_ref(), 0.0)?;
    if clearance < 0.0 {
        return Err(bad("Thread: the clearance must not be negative"));
    }
    let left = matches!(f.hand, Some(Hand::Left));
    let cut = match &f.operation {
        None | Some(Operation::Cut) => true,
        Some(Operation::Join) => false,
        Some(other) => return Err(bad(format!("Thread: the operation must be cut or join, not {}", other.as_str()))),
    };

    let prof: Vec<(f64, f64)> = f.profile.iter().map(|p| (p[0].get(), p[1].get())).collect();
    if prof.len() < 3 {
        return Err(bad("Thread: the profile needs at least three points"));
    }
    let along_min = prof.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let along_max = prof.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let width = along_max - along_min;
    if width >= pitch {
        return Err(bad(format!(
            "Thread: the profile is {width:.4} mm wide along the axis, it has to be narrower than the {pitch} mm pitch or the turns run into each other"
        )));
    }
    let deepest = prof.iter().map(|p| p.0.abs()).fold(0.0, f64::max).max(1e-3);

    let (z0, z1) = kernel::axial_extent(&face, arr(o), arr(d))
        .ok_or_else(|| bad("Thread: the face has no length along its axis"))?;
    let zm = (z0 + z1) / 2.0;
    let e = (0.05 * r).clamp(1e-3, 0.05);
    let at = |z: f64, rad: f64, x: DVec3| arr(o + d * z + x * rad);
    let probe = meridians(d);
    let into = probe
        .iter()
        .find_map(|&x| {
            let inner = kernel::point_inside(&shape, at(zm, r - e, x), 1e-7);
            let outer = kernel::point_inside(&shape, at(zm, r + e, x), 1e-7);
            match (inner, outer) {
                (true, false) => Some(-1.0),
                (false, true) => Some(1.0),
                _ => None,
            }
        })
        .ok_or_else(|| bad("Thread: cannot tell which side of the face the material is on"))?;
    if into < 0.0 && prof.iter().any(|p| r - p.0 - clearance <= 0.0) {
        return Err(bad("Thread: the profile is deeper than the shaft's radius"));
    }

    // An end with no material beyond it lets the thread run out past it, so the
    // last turn is whole; an end against material (a shoulder, a blind bottom)
    // stops the thread at the face.
    let gap = (0.02 * pitch).max(0.01);
    let open = |z: f64| {
        probe.iter().step_by(2).all(|&x| !kernel::point_inside(&shape, at(z, r + into * deepest * 0.5, x), 1e-7))
    };
    let offset = ctx.val_or(f.offset.as_ref(), 0.0)?;
    let a = z0 + offset;
    let b = match &f.length {
        Some(l) => (a + ctx.val(l)?).min(z1),
        None => z1,
    };
    if !(b > a) {
        return Err(bad("Thread: the offset leaves no length of the face to thread"));
    }
    let run_out = lead + width;
    // A ridge run out past an open end would stand proud of the part there.
    let lo = if cut && offset.abs() < 1e-9 && open(z0 - gap) { a - run_out } else { a };
    let hi = if cut && b >= z1 - 1e-9 && open(z1 + gap) { b + run_out } else { b };
    let c0 = lo - along_min;
    let rise = (hi - along_max) - c0;
    if !(rise > 1e-6) {
        return Err(bad("Thread: the face is shorter than one groove of this profile"));
    }
    let x0 = probe[0];
    let body_id = ctx.bodies[body].id.clone();
    let mut work = shape;
    if clearance > 0.0 {
        let (r_a, r_b) = (r, r + into * clearance);
        let ring = [[r_a, lo], [r_b, lo], [r_b, hi], [r_a, hi]].map(|[rad, z]| at(z, rad, x0));
        let sleeve = kernel::revolve(&kernel::polygon_face(&ring)?, arr(o), arr(d), 360.0)?;
        work = kernel::serial_bool(&work, &[&sleeve], BoolKind::Cut)?;
    }

    // The part of the profile on the side the operation changes, cut into the
    // material or joined into the empty side, and so the volume it must change.
    let side = if cut { 1.0 } else { -1.0 };
    let (area, centre_into) = clipped_area(&prof, side);
    let rc = r + into * (centre_into + clearance);
    let closed_ends = [lo == a, hi == b].iter().filter(|c| **c).count() as f64;
    let want = area * std::f64::consts::TAU * rc * ((b - a) - closed_ends * width / 2.0).max(0.0) / pitch;
    let before = kernel::volume(&work);
    let before_solids = kernel::count(&work, Kind::Solid);
    let kind = if cut { BoolKind::Cut } else { BoolKind::Fuse };

    // A long helical tool nearly parallel to the face defeats the kernel: the
    // boolean reports success and changes nothing, or half. So the sweep is cut
    // up a turn or two per tool, and the first split whose result changes the
    // volume it should is kept.
    // A join is fused whole first: tools a turn long touch end to end, and the
    // fuse refuses those seams.
    let strategies: &[(f64, f64)] = match (cut, lo < a) {
        (false, _) => &[(f64::INFINITY, 0.0), (1.0, 0.0), (2.0, 0.0)],
        (true, true) => &[(1.0, 0.0), (2.0, 0.0), (2.0, 0.37)],
        (true, false) => &[(1.0, 0.0), (2.0, 0.0)],
    };
    let mut last_err = None;
    for &(per_tool, phase) in strategies {
        let start = c0 - phase * pitch;
        let total = (rise + phase * pitch) / lead;
        let mut tools = Vec::new();
        for k in 0..starts {
            let t = k as f64 * std::f64::consts::TAU / starts as f64;
            let x = (x0 * t.cos() + d.cross(x0) * t.sin()).normalize();
            let mut done = 0.0;
            while done < total - 1e-9 {
                let turns = per_tool.min(total - done);
                let z = start + done * lead;
                let pts: Vec<[f64; 3]> = prof.iter().map(|&(i, s)| at(z + s, r + into * (i + clearance), x)).collect();
                let face = kernel::polygon_face(&pts)?;
                let (angle, signed_lead) = if left { (-360.0 * turns, -lead) } else { (360.0 * turns, lead) };
                let face = if left {
                    kernel::rotated_about(&face, arr(o), arr(d), -360.0 * done)?
                } else {
                    kernel::rotated_about(&face, arr(o), arr(d), 360.0 * done)?
                };
                tools.push(screw_revolve(&face, arr(o), arr(d), angle, signed_lead)?);
                done += turns;
            }
        }
        let refs: Vec<&Shape> = tools.iter().collect();
        let out = match kernel::serial_bool(&work, &refs, kind) {
            Ok(out) => out,
            Err(e) => {
                last_err = Some(Fail::from(e));
                continue;
            }
        };
        let solids = kernel::count(&out, Kind::Solid);
        if solids == 0 {
            return Err(bad("Thread: the thread removed the whole body"));
        }
        if solids > before_solids {
            return Err(bad("Thread: the thread split the body in two, the profile is too deep for the wall"));
        }
        let changed = (kernel::volume(&out) - before).abs();
        if (changed - want).abs() > 0.1 * want {
            continue;
        }
        ctx.set_shape(body, out);
        ctx.record_tool(&f.id, kind, vec![body_id], kernel::compound(&tools));
        return Ok(());
    }
    Err(last_err.unwrap_or_else(|| {
        bad("Thread: the kernel could not sweep the thread into the body, try a shorter length or a coarser pitch")
    }))
}

/// The area of the profile on one side of the face (`side` 1 for into the
/// material, -1 for out of it) and how far into the material its centroid is.
fn clipped_area(prof: &[(f64, f64)], side: f64) -> (f64, f64) {
    let mut poly = Vec::new();
    for k in 0..prof.len() {
        let (p, q) = (prof[k], prof[(k + 1) % prof.len()]);
        let (sp, sq) = (p.0 * side, q.0 * side);
        if sp >= 0.0 {
            poly.push(p);
        }
        if (sp >= 0.0) != (sq >= 0.0) {
            let t = sp / (sp - sq);
            poly.push((0.0, p.1 + t * (q.1 - p.1)));
        }
    }
    let (mut a2, mut cx) = (0.0, 0.0);
    for k in 0..poly.len() {
        let (p, q) = (poly[k], poly[(k + 1) % poly.len()]);
        let cr = p.0 * q.1 - q.0 * p.1;
        a2 += cr;
        cx += (p.0 + q.0) * cr;
    }
    if a2.abs() < 1e-15 {
        return (0.0, 0.0);
    }
    (a2.abs() / 2.0, cx / (3.0 * a2))
}
