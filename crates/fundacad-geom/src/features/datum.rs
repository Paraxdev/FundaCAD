//! Datum planes and axes, sidecar/builder.py `_handle_datum_plane` and
//! `_handle_datum_axis`.
//!
//! Not ported yet: following a face (`face`, `at`) or an edge (`axisEdge`)
//! through `geom_select`. Such a datum keeps its cached placement, which is
//! what the Python engine also does whenever the reference stops resolving.

use fundacad_core::schema::{DatumAxis, DatumPlane, Num};

use crate::builder::plane::{plane_of, PlaneRecord, PlaneRef};
use crate::builder::{Ctx, FResult, Fail};

pub fn datum_plane(ctx: &mut Ctx, f: &DatumPlane) -> FResult {
    let base = plane_of(PlaneRef::from(&f.plane), &ctx.datums)?;
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
