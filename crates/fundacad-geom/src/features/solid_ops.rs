//! Shell, thicken and draft: the Python engine's `solid_ops.py` `_shell`, `_draft` and the
//! handlers of the Python engine's `builder.py` that drive them.

use fundacad_core::schema::{Draft, OneOrMany, Selector, Shell, Thicken};
use glam::DVec3;
use opencascade::heal::FixOptions;
use opencascade::modify::{OffsetJoin, OffsetOptions};
use opencascade::primitives::{Shape, ShapeType, SurfaceType};
use opencascade::progress::ProgressRange;

use super::boolean::combine;
use crate::builder::{py_g, Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind, Kind};
use crate::select::{group_by_body, Resolver};

/// The class name an OpenCASCADE failure reaches Python as.
pub(crate) fn occt_class(e: &opencascade::Error) -> String {
    match e {
        opencascade::Error::Occt(m) => m.split(':').next().unwrap_or(m).trim().to_owned(),
        opencascade::Error::Cancelled => "UserBreak".into(),
        other => format!("{other:?}"),
    }
}

pub(crate) fn internal(e: opencascade::Error) -> Fail {
    Fail::Internal(occt_class(&e))
}

pub(crate) fn resolve(
    ctx: &mut Ctx,
    feature_id: &str,
    part: &Shape,
    sels: &[&Selector],
) -> FResult<Vec<Shape>> {
    let v = serde_json::to_value(sels).map_err(|_| Fail::Internal("TypeError".into()))?;
    Resolver::new(Some(&mut ctx.diagnostics), Some(feature_id)).faces(part, &v)
}

pub(crate) fn resolve_field(
    ctx: &mut Ctx,
    feature_id: &str,
    part: &Shape,
    sel: &OneOrMany<Selector>,
) -> FResult<Vec<Shape>> {
    Resolver::new(Some(&mut ctx.diagnostics), Some(feature_id)).face_selectors(part, sel)
}

pub(crate) fn faces_of(shape: &Shape) -> Vec<Shape> {
    shape.shape_map(ShapeType::Face).iter().collect()
}

/// The face's surface kind, `None` where the guarded probe cannot read it,
/// since the adaptor behind `Face::surface_type` does not catch.
pub(crate) fn surface_type(face: &Shape) -> Option<SurfaceType> {
    opencascade::select_access::face_probe(face)?;
    face.as_face().map(|f| f.surface_type())
}

/// `OFFSETTABLE_CURVED`: the analytic surfaces BRepOffset has a closed form for.
pub(crate) fn offsettable_curved(t: Option<SurfaceType>) -> bool {
    matches!(
        t,
        Some(SurfaceType::Cylinder | SurfaceType::Cone | SurfaceType::Sphere | SurfaceType::Torus)
    )
}

/// `_guard_offsetable`. Freeform surfaces are refused because BRepOffset
/// crashes on them rather than failing.
pub(crate) fn guard_offsetable(part: &Shape, faces: &[Shape], label: &str) -> FResult {
    let total = faces_of(part).len();
    for f in faces {
        let t = surface_type(f);
        if t != Some(SurfaceType::Plane) && !offsettable_curved(t) {
            return Err(Fail::msg(format!(
                "{label} needs a flat or a regularly-curved face (round, cone, sphere or torus), this one is freeform"
            )));
        }
        if total > 300 && kernel::area(f) < 1.0 {
            return Err(Fail::msg(format!(
                "can't {} this region, it's a single mesh facet, not a clean face",
                label.to_lowercase()
            )));
        }
    }
    Ok(())
}

/// build123d `Solid.offset_3d` with the Intersection kind, then `fix()`.
fn offset_3d(solid: &Shape, openings: &[Shape], amount: f64) -> Result<Shape, String> {
    let faces = faces_of(solid);
    let mine: Vec<_> = openings
        .iter()
        .filter(|o| faces.iter().any(|f| f.is_same(o)))
        .filter_map(Shape::as_face)
        .collect();
    let refs: Vec<_> = mine.iter().collect();
    let options = OffsetOptions {
        tolerance: 1e-4,
        join: OffsetJoin::Intersection,
        intersection: true,
        remove_internal_edges: true,
        ..Default::default()
    };
    let out = solid
        .thick_solid_by_join(&refs, amount, options, &ProgressRange::detached())
        .map_err(|e| match &e {
            opencascade::Error::Occt(m) if m.contains("did not finish") => {
                "RuntimeError".to_owned()
            }
            _ => occt_class(&e),
        })?;
    let out = if out.volume() < 0.0 {
        out.reversed()
    } else {
        out
    };
    if out.is_valid().unwrap_or(false) {
        return Ok(out);
    }
    out.fix(FixOptions::default())
        .map(|f| f.shape)
        .map_err(|e| occt_class(&e))
}

/// build123d `offset(shape, amount, openings, kind=INTERSECTION)` on a part.
fn offset_part(shape: &Shape, openings: &[Shape], amount: f64) -> Result<Shape, String> {
    let solids = kernel::subshapes(shape, Kind::Solid);
    let mut out = Vec::with_capacity(solids.len());
    for s in &solids {
        out.push(offset_3d(s, openings, amount)?);
    }
    Ok(kernel::compound(&out))
}

/// `_shell`: hollow inward by the wall, `openings` removed, or sealed when none.
fn shell_shape(shape: &Shape, thickness: f64, openings: &[Shape]) -> FResult<Shape> {
    let amount = -thickness.abs();
    let run = || -> Result<Shape, String> {
        if !openings.is_empty() {
            return offset_part(shape, openings, amount);
        }
        // An offset with nothing opened shrinks the solid instead of hollowing
        // it, so the sealed wall is the original minus that shrunk solid.
        let inner = offset_part(shape, &[], amount)?;
        kernel::boolean_op(shape, &[&inner], BoolKind::Cut).map_err(|e| {
            e.0.split(':')
                .next()
                .unwrap_or("RuntimeError")
                .trim()
                .to_owned()
        })
    };
    run().map_err(|class| {
        Fail::msg(format!(
            "Shell failed with a wall of {}mm, this is usually thicker than the body's narrowest span; try a smaller thickness. [{class}]",
            py_g(thickness.abs())
        ))
    })
}

pub fn shell(ctx: &mut Ctx, f: &Shell) -> FResult {
    let t = ctx.val(&f.thickness)?;
    if t == 0.0 {
        return Err(Fail::msg("Shell: thickness must not be 0"));
    }
    let Some(sels) = f.faces.as_ref().filter(|s| !s.as_slice().is_empty()) else {
        let act = ctx.require_active("Shell")?;
        let hollow = shell_shape(ctx.bodies[act].shape(), t, &[])?;
        ctx.set_shape(act, hollow);
        return Ok(());
    };
    let mut staged = Vec::new();
    for (body, group) in group_by_body(ctx, sels, "Shell")? {
        let part = ctx.bodies[body].shape().clone();
        let openings = resolve(ctx, &f.id, &part, &group)?;
        staged.push((body, shell_shape(&part, t, &openings)?));
    }
    for (body, shape) in staged {
        ctx.set_shape(body, shape);
    }
    Ok(())
}

/// build123d `Solid.thicken(face, depth)`.
fn thicken_face(face: &Shape, depth: f64) -> FResult<Shape> {
    let options = OffsetOptions {
        tolerance: 1e-5,
        join: OffsetJoin::Intersection,
        intersection: true,
        thickening: true,
        remove_internal_edges: true,
        ..Default::default()
    };
    let out = face
        .offset_shape(depth, &[], options, &ProgressRange::detached())
        .map_err(|e| match e {
            opencascade::Error::Occt(m) if m.starts_with("BRepOffset_MakeOffset error") => {
                Fail::Internal("RuntimeError".into())
            }
            other => internal(other),
        })?;
    if out.shape_type() != ShapeType::Solid {
        return Err(Fail::Internal("Standard_TypeMismatch".into()));
    }
    Ok(out)
}

pub fn thicken(ctx: &mut Ctx, f: &Thicken) -> FResult {
    let act = match f.body.as_deref().filter(|b| !b.is_empty()) {
        Some(id) => ctx.find_body(id),
        None => Some(ctx.require_active("Thicken")?),
    };
    let Some(act) = act else {
        return Err(Fail::msg("Thicken: the target body no longer exists"));
    };
    let part = ctx.bodies[act].shape().clone();
    let faces = match f.faces.as_ref().filter(|s| !s.as_slice().is_empty()) {
        Some(sel) => resolve_field(ctx, &f.id, &part, sel)?,
        None => kernel::subshapes(&part, Kind::Face),
    };
    if faces.is_empty() {
        return Err(Fail::msg("no face found to thicken"));
    }
    guard_offsetable(&part, &faces, "Thicken")?;
    let t = ctx.val(&f.thickness)?;
    if t.abs() < 1e-9 {
        return Err(Fail::msg("Thicken: the thickness is zero"));
    }
    let both = f.symmetric.unwrap_or(false);
    let mut solids = Vec::new();
    for face in &faces {
        solids.push(thicken_face(face, t)?);
        if both {
            solids.push(thicken_face(face, -t)?);
        }
    }
    let merged = if solids.len() > 1 {
        let tools: Vec<&Shape> = solids[1..].iter().collect();
        kernel::boolean_op(&solids[0], &tools, BoolKind::Fuse)?
    } else {
        kernel::clean(&solids[0])?
    };
    combine(
        ctx,
        &f.id,
        kernel::compound([&merged]),
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        None,
    )
}

fn draft_shape(shape: &Shape, faces: &[Shape], angle_deg: f64, axis: &str) -> FResult<Shape> {
    let pull = match axis {
        "X" => DVec3::X,
        "Y" => DVec3::Y,
        _ => DVec3::Z,
    };
    let bb = kernel::bbox(shape).unwrap_or([0.0; 6]);
    let base = match axis {
        "X" => bb[0],
        "Y" => bb[1],
        _ => bb[2],
    };
    let faces: Vec<_> = faces.iter().filter_map(Shape::as_face).collect();
    let refs: Vec<_> = faces.iter().collect();
    shape
        .draft(&refs, pull, angle_deg.to_radians(), pull * base, pull)
        .map_err(|e| match &e {
            opencascade::Error::Occt(m) if m.contains("the draft did not build") => {
                Fail::msg("draft failed for these faces / angle")
            }
            // A refused Add leaves the drafter to raise on Build in Python.
            opencascade::Error::Occt(m) if m.starts_with("the draft refused") => {
                Fail::Internal("Standard_ConstructionError".into())
            }
            _ => internal(e),
        })
}

pub fn draft(ctx: &mut Ctx, f: &Draft) -> FResult {
    let angle = ctx.val(&f.angle)?;
    if !(-90.0 < angle && angle < 90.0) {
        return Err(Fail::msg(format!(
            "Draft: angle must be between -90 and 90 degrees (got {})",
            py_g(angle)
        )));
    }
    let axis = f.axis.as_str().to_owned();
    let mut staged = Vec::new();
    for (body, group) in group_by_body(ctx, &f.faces, "Draft")? {
        let part = ctx.bodies[body].shape().clone();
        let faces = resolve(ctx, &f.id, &part, &group)?;
        if faces.is_empty() {
            return Err(Fail::msg(format!(
                "no face found to draft on {}",
                ctx.bodies[body].name
            )));
        }
        staged.push((body, draft_shape(&part, &faces, angle, &axis)?));
    }
    for (body, shape) in staged {
        ctx.set_shape(body, shape);
    }
    Ok(())
}
