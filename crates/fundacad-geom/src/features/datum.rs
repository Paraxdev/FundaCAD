//! Datum planes and axes, `_handle_datum_plane` and `_handle_datum_axis` of builder.py. A datum follows its face
//! or edge, and a reference that stops resolving is not an error: the datum keeps its cached placement.

use fundacad_core::schema::{DatumAxis, DatumPlane, OneOrMany};
use opencascade::primitives::Shape;
use opencascade::select_access::CurveType;
use serde_json::json;

use glam::{DMat3, DQuat, DVec3};

use crate::select::{entity::EdgeEnt, Resolver};

use super::face_anchor::face_anchor_plane;
use crate::builder::plane::{plane_of, PlaneRecord, PlaneRef};
use crate::builder::{Ctx, FResult};
use crate::kernel::Frame;

pub fn datum_plane(ctx: &mut Ctx, f: &DatumPlane) -> FResult {
    let parent = f.plane_id.as_deref().filter(|p| !p.is_empty() && *p != f.id).and_then(|p| ctx.datums.get(p).copied());
    let followed = match &f.through {
        Some(t) => super::datum_refs::plane_through(ctx, f, t)?,
        None => None,
    };
    let spec = match (followed, parent) {
        (Some(p), _) => PlaneRef::Record(p.record()),
        (None, Some(rec)) => PlaneRef::Record(rec),
        (None, None) => match face_anchor_plane(ctx, &f.id, f.face.as_ref(), f.at.as_ref(), &f.plane, "Plane") {
            Some(p) => PlaneRef::Record(p.record()),
            None => PlaneRef::from(&f.plane),
        },
    };
    let base = plane_of(spec, &ctx.datums)?;
    let pose = Pose {
        shift: [
            ctx.val_or(f.shift_x.as_ref(), 0.0)?,
            ctx.val_or(f.shift_y.as_ref(), 0.0)?,
            ctx.val_or(f.offset.as_ref(), 0.0)?,
        ],
        tilt_x: ctx.val_or(f.tilt_x.as_ref(), 0.0)?,
        tilt_y: ctx.val_or(f.tilt_y.as_ref(), 0.0)?,
        spin: ctx.val_or(f.spin.as_ref(), 0.0)?,
    };
    ctx.datums.insert(f.id.clone(), place(&base, &pose));
    Ok(())
}

/// Where a datum sits relative to its reference: `shift` in the reference's
/// own x, y and normal, then the turns in degrees about that point.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pose {
    pub shift: [f64; 3],
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub spin: f64,
}

/// The reference frame moved by `pose`. The turns are intrinsic X, Y, Z, so each is about an axis the later
/// ones leave alone, which lets a gizmo drag one angle without disturbing the others.
pub fn place(base: &Frame, pose: &Pose) -> PlaneRecord {
    let (x, y, z) = (DVec3::from(base.x), DVec3::from(base.y), DVec3::from(base.z));
    let o = DVec3::from(base.origin) + x * pose.shift[0] + y * pose.shift[1] + z * pose.shift[2];
    if pose.tilt_x == 0.0 && pose.tilt_y == 0.0 && pose.spin == 0.0 {
        return PlaneRecord { origin: o.to_array(), xdir: base.x, normal: base.z };
    }
    let local = DQuat::from_rotation_x(pose.tilt_x.to_radians())
        * DQuat::from_rotation_y(pose.tilt_y.to_radians())
        * DQuat::from_rotation_z(pose.spin.to_radians());
    let world = DMat3::from_cols(x, y, z) * DMat3::from_quat(local);
    PlaneRecord { origin: o.to_array(), xdir: clean(world.x_axis).to_array(), normal: clean(world.z_axis).to_array() }
}

/// Snaps components within a rounding error of 0 or 1 so a 90 degree turn
/// reports an exact axis rather than 6e-17 noise.
fn clean(v: DVec3) -> DVec3 {
    let c = |a: f64| {
        let r = a.round();
        if (a - r).abs() < 1e-12 {
            r
        } else {
            a
        }
    };
    DVec3::new(c(v.x), c(v.y), c(v.z)) + DVec3::ZERO
}

/// `_handle_datum_axis`: an axis anchored to an edge re-resolves it every
/// rebuild, `origin` and `dir` being the fallback cache. Resolution is global
/// across bodies, a body id can come to name a different piece.
pub fn datum_axis(ctx: &mut Ctx, f: &DatumAxis) -> FResult {
    if let Some(t) = &f.through {
        if let Some((o, d)) = super::datum_refs::axis_through(ctx, f, t)? {
            ctx.datum_marks.insert(f.id.clone(), json!({"kind": "axis", "origin": o.to_array(), "dir": d.to_array()}));
        }
        return Ok(());
    }
    let Some(sel) = f.axis_edge.clone() else {
        return Ok(());
    };
    let shapes: Vec<Shape> = ctx.shapes().into_iter().cloned().collect();
    for shape in &shapes {
        let mut diag = std::mem::take(&mut ctx.diagnostics);
        let found = Resolver::new(Some(&mut diag), Some(&f.id)).edge_selectors(shape, &OneOrMany::One(sel.clone()));
        ctx.diagnostics = diag;
        let Ok(edges) = found else { continue };
        for e in edges {
            let Ok(ent) = EdgeEnt::new(e) else { continue };
            if ent.curve != CurveType::Line {
                continue;
            }
            ctx.datum_marks.insert(
                f.id.clone(),
                json!({"kind": "axis", "origin": ent.mid.to_array(), "dir": ent.dir().to_array()}),
            );
            return Ok(());
        }
    }
    Ok(())
}
