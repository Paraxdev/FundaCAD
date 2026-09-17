//! Box, cylinder, sphere, cone and torus, sidecar/builder.py `_handle_box` and
//! its siblings with handler_util.py `_require_positive`. Every primitive is
//! centred on the origin on all three axes.

use fundacad_core::schema::{BoxFeature, Cone, Cylinder, Sphere, Torus};

use super::combine;
use crate::builder::{py_g, Ctx, FResult, Fail};
use crate::kernel;

/// `_require_positive`: a non-positive dimension refused by name.
pub fn require_positive(op: &str, dims: &[(&str, f64)]) -> FResult {
    for (name, v) in dims {
        if !(*v > 0.0) {
            return Err(Fail::msg(format!(
                "{op}: {name} must be greater than 0 (got {})",
                py_g(*v)
            )));
        }
    }
    Ok(())
}

pub fn make_box(ctx: &mut Ctx, f: &BoxFeature) -> FResult {
    let (l, w, h) = (ctx.val(&f.length)?, ctx.val(&f.width)?, ctx.val(&f.height)?);
    require_positive("Box", &[("length", l), ("width", w), ("height", h)])?;
    let solid = kernel::make_box(l, w, h)?;
    combine(
        ctx,
        &f.id,
        solid,
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        Some("Box"),
    )
}

pub fn cylinder(ctx: &mut Ctx, f: &Cylinder) -> FResult {
    let (r, h) = (ctx.val(&f.radius)?, ctx.val(&f.height)?);
    require_positive("Cylinder", &[("radius", r), ("height", h)])?;
    let solid = kernel::make_cylinder(r, h)?;
    combine(
        ctx,
        &f.id,
        solid,
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        Some("Cylinder"),
    )
}

pub fn sphere(ctx: &mut Ctx, f: &Sphere) -> FResult {
    let r = ctx.val(&f.radius)?;
    require_positive("Sphere", &[("radius", r)])?;
    let solid = kernel::make_sphere(r)?;
    combine(
        ctx,
        &f.id,
        solid,
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        Some("Sphere"),
    )
}

pub fn cone(ctx: &mut Ctx, f: &Cone) -> FResult {
    let (rb, rt, h) = (
        ctx.val(&f.bottom_radius)?,
        ctx.val(&f.top_radius)?,
        ctx.val(&f.height)?,
    );
    require_positive("Cone", &[("height", h)])?;
    if rb < 0.0 || rt < 0.0 {
        return Err(Fail::msg("Cone: radii must not be negative"));
    }
    if rb == rt {
        return Err(Fail::msg(
            "Cone: the two radii must differ (equal radii is a cylinder)",
        ));
    }
    if rb <= 0.0 && rt <= 0.0 {
        return Err(Fail::msg(
            "Cone: at least one radius must be greater than 0",
        ));
    }
    let solid = kernel::make_cone(rb, rt, h)?;
    combine(
        ctx,
        &f.id,
        solid,
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        Some("Cone"),
    )
}

pub fn torus(ctx: &mut Ctx, f: &Torus) -> FResult {
    let (big, small) = (ctx.val(&f.major_radius)?, ctx.val(&f.minor_radius)?);
    require_positive("Torus", &[("majorRadius", big), ("minorRadius", small)])?;
    if small >= big {
        return Err(Fail::msg(
            "Torus: the tube radius must be smaller than the ring radius",
        ));
    }
    let solid = kernel::make_torus(big, small)?;
    combine(
        ctx,
        &f.id,
        solid,
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        Some("Torus"),
    )
}
