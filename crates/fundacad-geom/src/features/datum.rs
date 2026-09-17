//! Datum planes and axes, sidecar/builder.py `_handle_datum_plane` and
//! `_handle_datum_axis`.
//!
//! A datum plane made on a face follows it (face_anchor.rs). Not ported yet:
//! an axis following an edge (`axisEdge`) through `geom_select`. Such a datum keeps its cached placement, which is
//! what the Python engine also does whenever the reference stops resolving.

use fundacad_core::schema::{DatumAxis, DatumPlane, Num};

use crate::builder::plane::{plane_of, PlaneRecord, PlaneRef};
use super::face_anchor::face_anchor_plane;
use crate::builder::{Ctx, FResult, Fail};

pub fn datum_plane(ctx: &mut Ctx, f: &DatumPlane) -> FResult {
    let followed = face_anchor_plane(ctx, &f.id, f.face.as_ref(), f.at.as_ref(), &f.plane, "Plane");
    let spec = match followed {
        Some(p) => PlaneRef::Record(p.record()),
        None => PlaneRef::from(&f.plane),
    };
    let base = plane_of(spec, &ctx.datums)?;
    // Python reads `offset` raw, so a parameter name there is a TypeError.
    let off = match &f.offset {
        None => 0.0,
        Some(Num::Number(r)) => r.get(),
        Some(Num::Expr(_)) => return Err(Fail::Internal("TypeError".into())),
    };
    let o = base.origin;
    let z = base.z;
    ctx.datums.insert(
        f.id.clone(),
        PlaneRecord {
            origin: [o[0] + z[0] * off, o[1] + z[1] * off, o[2] + z[2] * off],
            xdir: base.x,
            normal: base.z,
        },
    );
    Ok(())
}

pub fn datum_axis(_ctx: &mut Ctx, _f: &DatumAxis) -> FResult {
    Ok(())
}
