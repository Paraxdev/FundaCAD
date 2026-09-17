//! Body patterns, sidecar/builder.py `_handle_pattern_rect`,
//! `_handle_pattern_linear`, `_handle_pattern_circular` and `_pattern_targets`
//! over sidecar/solid_ops.py `_pattern_*` and `_fuse_pattern_cells`. A pattern
//! rewrites its target body in place, so it mints no body ids.

use fundacad_core::schema::{Axis3, PatternCircular, PatternLinear, PatternRect};
use opencascade::primitives::Shape;

use super::primitives::require_positive;
use crate::builder::{Ctx, FResult};
use crate::kernel::{self, BoolKind};

/// Python `max(1, int(round(n)))`.
fn copies(n: f64) -> usize {
    let r = n.round_ties_even();
    if r.is_finite() && r >= 1.0 {
        r as usize
    } else {
        1
    }
}

/// Bbox-disjoint cells are already their union, so they compound without a
/// boolean; touching counts as overlapping so shared faces still merge.
fn fuse_cells(mut cells: Vec<Shape>) -> FResult<Shape> {
    if cells.len() == 1 {
        return Ok(cells.remove(0));
    }
    let tol = 1e-6;
    let boxes: Vec<Option<[f64; 6]>> = cells.iter().map(kernel::bbox).collect();
    let apart = |a: &[f64; 6], b: &[f64; 6]| {
        a[3] < b[0] - tol
            || b[3] < a[0] - tol
            || a[4] < b[1] - tol
            || b[4] < a[1] - tol
            || a[5] < b[2] - tol
            || b[5] < a[2] - tol
    };
    let disjoint = boxes.iter().enumerate().all(|(i, a)| {
        boxes[i + 1..].iter().all(|b| match (a, b) {
            (Some(a), Some(b)) => apart(a, b),
            _ => false,
        })
    });
    if disjoint {
        return Ok(kernel::compound(&cells));
    }
    let mut it = cells.into_iter();
    let mut result = it.next().expect("more than one cell");
    for cell in it {
        result = kernel::boolean_op(&result, &[&cell], BoolKind::Fuse)?;
    }
    Ok(result)
}

fn axis_rotation(axis: &Axis3, deg: f64) -> [f64; 3] {
    match axis {
        Axis3::X => [deg, 0.0, 0.0],
        Axis3::Y => [0.0, deg, 0.0],
        _ => [0.0, 0.0, deg],
    }
}

fn axis_unit(axis: &Axis3) -> [f64; 3] {
    match axis {
        Axis3::X => [1.0, 0.0, 0.0],
        Axis3::Y => [0.0, 1.0, 0.0],
        _ => [0.0, 0.0, 1.0],
    }
}

pub fn pattern_rect_shape(shape: &Shape, nx: f64, ny: f64, dx: f64, dy: f64) -> FResult<Shape> {
    let (nx, ny) = (copies(nx), copies(ny));
    let mut cells = Vec::with_capacity(nx * ny);
    for i in 0..nx {
        for j in 0..ny {
            cells.push(kernel::translated(
                shape,
                [i as f64 * dx, j as f64 * dy, 0.0],
            )?);
        }
    }
    fuse_cells(cells)
}

pub fn pattern_linear_shape(shape: &Shape, count: f64, spacing: f64, axis: &Axis3) -> FResult<Shape> {
    let off = axis_unit(axis);
    let cells = (0..copies(count))
        .map(|i| {
            let d = i as f64 * spacing;
            kernel::translated(shape, [d * off[0], d * off[1], d * off[2]])
        })
        .collect::<Result<Vec<_>, _>>()?;
    fuse_cells(cells)
}

pub fn pattern_circular_shape(shape: &Shape, count: f64, total: f64, axis: &Axis3) -> FResult<Shape> {
    let n = copies(count);
    // Deliberately `total - 360`, not patternMath.ts's `|total| - 360`: -360
    // divides by the gaps here, and parity is with this engine.
    let full = (total - 360.0).abs() < 1e-6;
    let step = if full {
        total / n as f64
    } else if n > 1 {
        total / (n - 1) as f64
    } else {
        0.0
    };
    let cells = (0..n)
        .map(|k| kernel::rotated(shape, axis_rotation(axis, k as f64 * step)))
        .collect::<Result<Vec<_>, _>>()?;
    fuse_cells(cells)
}

pub fn pattern_rect(ctx: &mut Ctx, f: &PatternRect) -> FResult {
    let act = ctx.require_active("Pattern")?;
    let (cx, cy) = (ctx.val(&f.count_x)?, ctx.val(&f.count_y)?);
    require_positive("Pattern", &[("countX", cx), ("countY", cy)])?;
    let (dx, dy) = (ctx.val(&f.spacing_x)?, ctx.val(&f.spacing_y)?);
    let out = pattern_rect_shape(ctx.bodies[act].shape(), cx, cy, dx, dy)?;
    ctx.set_shape(act, out);
    Ok(())
}

/// `_pattern_targets`: a stale listed id is skipped with a diagnostic.
fn targets(ctx: &mut Ctx, id: &str, kind: &str, ids: Option<&Vec<String>>) -> FResult<Vec<usize>> {
    let Some(ids) = ids.filter(|v| !v.is_empty()) else {
        return Ok(vec![ctx.require_active("Pattern")?]);
    };
    let mut out = Vec::new();
    for bid in ids {
        match ctx.find_body(bid) {
            Some(i) => out.push(i),
            None => ctx.skip_feature(id, kind, "target body already consumed or missing"),
        }
    }
    Ok(out)
}

pub fn pattern_linear(ctx: &mut Ctx, f: &PatternLinear) -> FResult {
    let n = ctx.val(&f.count)?;
    require_positive("Pattern", &[("count", n)])?;
    let spacing = ctx.val(&f.spacing)?;
    for i in targets(ctx, &f.id, "patternLinear", f.bodies.as_ref())? {
        let out = pattern_linear_shape(ctx.bodies[i].shape(), n, spacing, &f.axis)?;
        ctx.set_shape(i, out);
    }
    Ok(())
}

pub fn pattern_circular(ctx: &mut Ctx, f: &PatternCircular) -> FResult {
    let n = ctx.val(&f.count)?;
    require_positive("Pattern", &[("count", n)])?;
    let angle = ctx.val(&f.angle)?;
    for i in targets(ctx, &f.id, "patternCircular", f.bodies.as_ref())? {
        let out = pattern_circular_shape(ctx.bodies[i].shape(), n, angle, &f.axis)?;
        ctx.set_shape(i, out);
    }
    Ok(())
}
