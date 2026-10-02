//! Mechanisms: bodies joined by revolute, slider and rigid joints into one
//! linkage, closed loops included, posed together. `ground` stays where it is;
//! every other body in a joint is moved rigidly so all the joints meet, with
//! the `drive` joint at `offset` (a slider) or `angle` (a revolute).
//!
//! Connectors resolve once, on the bodies as the features above left them,
//! and then ride on their bodies. The solve starts from that modelled pose and
//! walks the drive to its value in small steps, so the linkage stays on the
//! branch it was modelled on and the result depends on the document alone.

mod solve;

use std::collections::HashSet;

use fundacad_core::schema::{JointMode, MateConnector, Mechanism};
use glam::DVec3;
use serde_json::json;

use super::joint;
use crate::builder::{missing_reference, py_g, py_g_prec, Ctx, FResult, Fail, RigidMove, BAD_REQUEST};
use crate::kernel;
use solve::{Frame, Kind, Problem};

fn refuse(message: String) -> Fail {
    Fail::Value {
        message,
        code: Some(BAD_REQUEST),
    }
}

/// One validated joint: its id, kind, and each side's body and connector.
struct Entry {
    id: String,
    kind: Kind,
    sides: [(String, MateConnector); 2],
}

/// The body a connector rides on: its own `body`, else the one its selector names.
fn side_body(c: &MateConnector) -> Option<String> {
    c.body.clone().or_else(|| {
        [&c.axis, &c.face, &c.edge]
            .into_iter()
            .flatten()
            .find_map(|s| s.body().map(str::to_owned))
    })
}

fn entries(ctx: &Ctx, f: &Mechanism) -> FResult<Vec<Entry>> {
    let joints = f.joints.as_deref().unwrap_or_default();
    if joints.is_empty() {
        return Err(refuse("mechanism: it needs at least one joint in joints".into()));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(joints.len());
    for (i, j) in joints.iter().enumerate() {
        let Some(id) = j.id.clone().filter(|s| !s.is_empty()) else {
            return Err(refuse(format!("mechanism: joints[{i}] has no id")));
        };
        if !seen.insert(id.clone()) {
            return Err(refuse(format!("mechanism: two joints are called {id}")));
        }
        let kind = match &j.mode {
            Some(JointMode::Revolute) => Kind::Revolute,
            Some(JointMode::Slider) => Kind::Slider,
            Some(JointMode::Rigid) => Kind::Rigid,
            Some(JointMode::Other(m)) => {
                return Err(refuse(format!(
                    "mechanism: joints[{id}] has the mode \"{m}\", which is not rigid, revolute or slider"
                )))
            }
            None => {
                return Err(refuse(format!(
                    "mechanism: joints[{id}] has no mode, give rigid, revolute or slider"
                )))
            }
        };
        let side = |c: &Option<MateConnector>, name: &str| -> FResult<(String, MateConnector)> {
            let Some(c) = c else {
                return Err(refuse(format!("mechanism: joints[{id}].{name} is missing")));
            };
            let Some(body) = side_body(c) else {
                return Err(refuse(format!("mechanism: joints[{id}].{name} has no body")));
            };
            if ctx.find_body(&body).is_none() {
                return Err(missing_reference(format!(
                    "mechanism: joints[{id}].{name} is on {body}, which is missing or was consumed"
                )));
            }
            let mut c = c.clone();
            c.body = Some(body.clone());
            Ok((body, c))
        };
        let a = side(&j.a, "a")?;
        let b = side(&j.b, "b")?;
        if a.0 == b.0 {
            return Err(refuse(format!(
                "mechanism: joints[{id}] has both sides on {}, a joint joins two bodies",
                a.0
            )));
        }
        out.push(Entry { id, kind, sides: [a, b] });
    }
    Ok(out)
}

/// The union of the bodies' boxes: its diagonal and each body's centre.
fn extent(ctx: &Ctx, bodies: &[usize]) -> (f64, Vec<DVec3>) {
    let mut lo = DVec3::splat(f64::INFINITY);
    let mut hi = DVec3::splat(f64::NEG_INFINITY);
    let mut centres = Vec::with_capacity(bodies.len());
    for &i in bodies {
        let b = kernel::bbox(ctx.bodies[i].shape()).unwrap_or([0.0; 6]);
        let (l, h) = (DVec3::new(b[0], b[1], b[2]), DVec3::new(b[3], b[4], b[5]));
        lo = lo.min(l);
        hi = hi.max(h);
        centres.push((l + h) / 2.0);
    }
    let size = if lo.is_finite() && hi.is_finite() { (hi - lo).length() } else { 1.0 };
    (size, centres)
}

/// "body3", "body3 and body7", "body3, body7 and body8".
fn listed(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// A gap in mm to three figures, a sliver as "less than 0.001".
fn mm(v: f64) -> String {
    if v < 1e-3 { "less than 0.001".into() } else { py_g_prec(v, 3) }
}

pub fn handle(ctx: &mut Ctx, f: &Mechanism) -> FResult {
    let Some(ground_id) = f.ground.clone() else {
        return Err(Fail::Missing("ground".into()));
    };
    let Some(ground) = ctx.find_body(&ground_id) else {
        return Err(missing_reference(format!(
            "mechanism: the ground {ground_id} is missing or was consumed"
        )));
    };
    let entries = entries(ctx, f)?;
    let drive = match &f.drive {
        None => None,
        Some(d) => {
            let Some(k) = entries.iter().position(|e| &e.id == d) else {
                return Err(refuse(format!("mechanism: the drive {d} is not one of the joints")));
            };
            if entries[k].kind == Kind::Rigid {
                return Err(refuse(format!(
                    "mechanism: the drive {d} is a rigid joint, drive a revolute or slider joint"
                )));
            }
            Some(k)
        }
    };
    // The value the drive's mode reads; the other is read only to resolve it.
    let slide = drive.is_some_and(|k| entries[k].kind == Kind::Slider);
    let (used, other) = if slide { (&f.offset, &f.angle) } else { (&f.angle, &f.offset) };
    let target = match (drive, used) {
        (Some(_), Some(n)) => Some(ctx.val(n)?),
        _ => None,
    };
    let _ = other.as_ref().map(|n| ctx.val(n));

    // Every body a joint moves, in the order the joints name them.
    let mut movers: Vec<String> = Vec::new();
    for e in &entries {
        for (body, _) in &e.sides {
            if body != &ground_id && !movers.contains(body) {
                movers.push(body.clone());
            }
        }
    }
    // A ground no joint names holds nothing, and the parts meant to stay put would float.
    if !entries.iter().any(|e| e.sides.iter().any(|(b, _)| b == &ground_id)) {
        return Err(Fail::msg(format!(
            "mechanism: no joint holds the ground {ground_id}, name it as a side of the joints it carries"
        )));
    }
    let unknown = |body: &str| movers.iter().position(|m| m == body);

    // Resolve every connector before anything moves: selectors are found by
    // where things are now.
    let mut joints = Vec::with_capacity(entries.len());
    for e in &entries {
        let mut frames = [None, None];
        let mut own_x = false;
        for (k, (body, c)) in e.sides.iter().enumerate() {
            let who = format!("mechanism: joints[{}].{}", e.id, ["a", "b"][k]);
            let Some(fr) = joint::connector(ctx, c, &f.id, &who)? else {
                return Err(missing_reference(format!("{who} no longer resolves on {body}")));
            };
            let x = (fr.xdir != [0.0; 3]).then(|| DVec3::from_array(fr.xdir));
            own_x |= x.is_some();
            let Some(fr) = Frame::new(DVec3::from_array(fr.origin), DVec3::from_array(fr.zdir), x) else {
                return Err(refuse(format!("{who}: its x direction runs along its axis")));
            };
            frames[k] = Some(fr);
        }
        let [Some(fa), Some(fb)] = frames else { unreachable!("both sides resolved") };
        // Neither side gives an x: a's is b's, so the joint reads 0 as modelled.
        let fa = if own_x { fa } else { fa.x_from(&fb) };
        joints.push(solve::Joint {
            kind: e.kind,
            a: unknown(&e.sides[0].0),
            b: unknown(&e.sides[1].0),
            fa,
            fb,
        });
    }

    let indices: Vec<usize> = movers.iter().filter_map(|m| ctx.find_body(m)).collect();
    let (scale, _) = extent(ctx, &[&[ground][..], &indices[..]].concat());
    let (_, centres) = extent(ctx, &indices);
    let problem = Problem::new(joints, centres, scale);
    let mut tick = || {
        crate::heartbeat::beat();
        !crate::cancel::requested()
    };
    let cancelled = |_| Fail::msg("cancelled");

    let mut pose = solve::Pose::modelled(movers.len());
    if !problem.settle(&mut pose, None, &mut tick).map_err(cancelled)? {
        let gap = problem.worst(&pose);
        let e = &entries[gap.joint];
        return Err(Fail::msg(format!(
            "mechanism: the joints cannot all be met, {} stays {} mm apart ({} to {})",
            e.id,
            mm(gap.size),
            e.sides[0].0,
            e.sides[1].0
        )));
    }
    if let (Some(k), Some(value)) = (drive, target) {
        let from = problem.coordinate(&pose, k);
        let (to, most, unit, word) = match entries[k].kind {
            // The angle a whole number of turns away that is nearest the
            // modelled one: the same pose for a crank, in reach for a rocker.
            Kind::Revolute => (from + solve::wrap(value.to_radians() - from), 2f64.to_radians(), "deg", "angle"),
            _ => (value, problem.scale / 100.0, "mm", "offset"),
        };
        let start = pose.clone();
        let mut swept = problem.sweep(&mut pose, k, from, to, most, &mut tick).map_err(cancelled)?;
        if let (Err(first), false, true) = (swept, slide, to != from) {
            // A rocker that swings more than a half turn may reach it the
            // other way round; locked both ways, the walk that got nearer says why.
            let mut other = start;
            let back = to - std::f64::consts::TAU * (to - from).signum();
            swept = match problem.sweep(&mut other, k, from, back, most, &mut tick).map_err(cancelled)? {
                Ok(()) => {
                    pose = other;
                    Ok(())
                }
                Err(second) if (back - second.reached).abs() < (to - first.reached).abs() => Err(second),
                Err(_) => Err(first),
            };
        }
        if let Err(locked) = swept {
            let near = if slide {
                locked.reached
            } else {
                // Read in the turn of the value asked for.
                let turns = ((value.to_radians() - locked.reached) / std::f64::consts::TAU).round();
                (locked.reached + std::f64::consts::TAU * turns).to_degrees()
            };
            // A gap the message would print as 0 explains nothing.
            let gives = locked.gap.filter(|g| g.size >= 1e-3).map_or(String::new(), |g| {
                format!(" where {} stays {} mm apart", entries[g.joint].id, mm(g.size))
            });
            return Err(Fail::msg(format!(
                "mechanism: the linkage cannot reach {word} {} {unit} on {}, it locks near {} {unit}{gives}",
                py_g(value),
                entries[k].id,
                py_g((near * 10.0).round() / 10.0),
            )));
        }
    }

    let (free, loose) = problem.free_motions(&pose, drive);
    if free > 0 {
        let names: Vec<&str> = loose.iter().map(|&i| movers[i].as_str()).collect();
        let motions = if free == 1 { "1 motion is".to_owned() } else { format!("{free} motions are") };
        let reason = match drive {
            Some(_) => format!("mechanism: {motions} left free besides the drive, {} can still move", listed(&names)),
            None => format!(
                "mechanism: no drive, the joints were closed as modelled and {motions} left free, {} can still move",
                listed(&names)
            ),
        };
        ctx.advise(&f.id, "mechanism", reason);
    }

    // All or nothing: every body is placed before any is set.
    let mut placed = Vec::new();
    for (i, &index) in indices.iter().enumerate() {
        if pose.rot[i] == glam::DQuat::IDENTITY && pose.shift[i] == DVec3::ZERO {
            continue;
        }
        let (rot, shift) = problem.placement(&pose, i);
        let shape = kernel::rigid_moved(
            ctx.bodies[index].shape(),
            rot.x_axis.to_array(),
            rot.z_axis.to_array(),
            shift.to_array(),
        )
        .map_err(|e| Fail::Internal(e.0))?;
        placed.push((index, shape, rot, shift));
    }
    for (index, shape, rot, shift) in placed {
        let body = ctx.bodies[index].id.clone();
        ctx.set_shape(index, shape);
        ctx.rigid_moves.push(RigidMove { body, rot, shift });
    }

    // The drive's reference axis, where the app stands its handle.
    if let Some(k) = drive {
        let (_, b) = problem.frames(&pose, k);
        // Where the drive sits, so a handle on a mechanism with no value yet
        // starts from the pose it shows: mm on a slider, degrees on a pin.
        let at = problem.coordinate(&pose, k);
        let value = match (target, entries[k].kind) {
            (Some(v), _) => v,
            (None, Kind::Revolute) => solve::wrap(at).to_degrees(),
            (None, _) => at,
        };
        ctx.datum_marks.insert(
            f.id.clone(),
            json!({"kind": "axis", "origin": b.p.to_array(), "dir": b.z.to_array(), "value": value}),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
