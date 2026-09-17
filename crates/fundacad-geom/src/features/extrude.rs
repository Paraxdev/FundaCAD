//! Extrude, sidecar/builder.py `_handle_extrude` with build123d's `extrude`
//! and `Solid.extrude_taper`.

use std::collections::HashSet;

use fundacad_core::schema::Extrude;
use opencascade::primitives::Shape;

use super::combine;
use super::sketch::{frame_for_normal, region_target, require};
use crate::builder::{py_g, Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind, Kind};

/// build123d `extrude(target, amount, both, taper)`: every planar face along
/// its own normal, both ways when symmetric, each result cleaned.
pub fn prisms(target: &Shape, amount: f64, both: bool, taper: f64) -> FResult<Shape> {
    let faces = kernel::subshapes(target, Kind::Face);
    let mut solids: Vec<Shape> = Vec::new();
    for face in &faces {
        if !kernel::face_is_planar(face) {
            return Err(Fail::msg(
                "dir must be provided when extruding non-planar faces",
            ));
        }
        let Some(n) = kernel::face_plane_normal(face) else {
            return Err(Fail::msg(
                "dir must be provided when extruding non-planar faces",
            ));
        };
        for direction in if both { &[1.0, -1.0][..] } else { &[1.0][..] } {
            let s = amount * direction;
            let d = [n[0] * s, n[1] * s, n[2] * s];
            let solid = if taper == 0.0 {
                kernel::prism(face, d)?
            } else {
                let normal_mid = kernel::face_normal_mid(face).unwrap_or(n);
                let len = s.abs();
                let unit = [d[0] / len, d[1] / len, d[2] / len];
                let aligned = (0..3).all(|k| (unit[k] - normal_mid[k]).abs() <= 1e-6);
                let dprism = aligned && n[2] > 0.0 && taper > 0.0 && !kernel::face_has_holes(face);
                let origin =
                    kernel::face_area_centre(face).map_or([0.0; 3], |a| [a[1], a[2], a[3]]);
                kernel::prism_taper(face, d, taper, &frame_for_normal(origin, n), dprism)?
            };
            solids.push(solid);
        }
    }
    if both && solids.len() > 1 {
        let last = solids
            .pop()
            .ok_or_else(|| Fail::Internal("IndexError".into()))?;
        let tools: Vec<&Shape> = solids.iter().collect();
        let fused = kernel::boolean_op(&last, &tools, BoolKind::Fuse)?;
        solids = if kernel::shape_type(&fused) == Some(kernel::ShapeType::Compound) {
            kernel::children(&fused)
        } else {
            vec![fused]
        };
    }
    let mut out: Vec<Shape> = Vec::new();
    for s in &solids {
        let cleaned = kernel::clean(s)?;
        out.extend(kernel::subshapes(&cleaned, Kind::Solid));
    }
    Ok(kernel::compound(&out))
}

pub fn handle(ctx: &mut Ctx, f: &Extrude) -> FResult {
    let entry = require(ctx, &f.sketch, "extrude")?;
    let Some(sk) = entry.sketch.clone() else {
        return Err(Fail::msg("sketch has no closed profile to extrude"));
    };
    let distance = ctx.val(&f.distance)?;
    if distance == 0.0 {
        return Err(Fail::msg("Extrude: distance must not be 0"));
    }
    let both = f.symmetric.unwrap_or(false);
    let mut pts: Vec<[f64; 3]> = f
        .regions
        .iter()
        .flatten()
        .map(|p| [p[0].get(), p[1].get(), p[2].get()])
        .collect();
    if pts.is_empty() {
        if let Some(p) = &f.region {
            pts.push([p[0].get(), p[1].get(), p[2].get()]);
        }
    }
    let target = region_target(ctx, &pts, entry)?.unwrap_or(sk);
    let taper = ctx.val_or(f.taper.as_ref(), 0.0)?;
    if taper != 0.0 && !(-89.0 < taper && taper < 89.0) {
        return Err(Fail::msg(format!(
            "Extrude: taper must be between -89 and 89 degrees (got {})",
            py_g(taper)
        )));
    }
    let solid = prisms(&target, distance, both, taper)?;
    let hidden: Option<HashSet<String>> = f
        .hidden_bodies
        .as_ref()
        .map(|h| h.iter().cloned().collect());
    combine(
        ctx,
        &f.id,
        solid,
        Some(&f.operation),
        f.targets.as_deref(),
        hidden,
        None,
    )
}
