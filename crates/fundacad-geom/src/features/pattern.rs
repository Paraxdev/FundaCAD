//! Body patterns, the Python engine's `builder.py` `_handle_pattern_rect`,
//! `_handle_pattern_linear`, `_handle_pattern_circular` and `_pattern_targets`
//! over the Python engine's `solid_ops.py` `_pattern_*` and `_fuse_pattern_cells`. A pattern
//! rewrites its target body in place, so it mints no body ids.
//!
//! With `features` a pattern repeats what those features did instead: the cut
//! or join each one recorded is copied to every other place and applied to the
//! same body again.

use fundacad_core::schema::{Axis3, Feature, PatternCircular, PatternLinear, PatternRect};
use opencascade::primitives::Shape;

use super::primitives::require_positive;
use crate::builder::{Ctx, FResult, Fail, ToolRecord};
use crate::kernel::{self, BoolKind, Kind};

const MAX_PATTERN_COUNT: usize = 10_000;

/// Python `max(1, int(round(n)))`.
fn copies(n: f64) -> usize {
    let r = n.round_ties_even();
    if r.is_finite() && r >= 1.0 {
        (r as usize).min(MAX_PATTERN_COUNT)
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

fn circular_step(n: usize, total: f64) -> f64 {
    // Deliberately `total - 360`, not patternMath.ts's `|total| - 360`: -360
    // divides by the gaps here, and parity is with this engine.
    let full = (total - 360.0).abs() < 1e-6;
    if full {
        total / n as f64
    } else if n > 1 {
        total / (n - 1) as f64
    } else {
        0.0
    }
}

pub fn pattern_circular_shape(shape: &Shape, count: f64, total: f64, axis: &Axis3) -> FResult<Shape> {
    let n = copies(count);
    let step = circular_step(n, total);
    let cells = (0..n)
        .map(|k| kernel::rotated(shape, axis_rotation(axis, k as f64 * step)))
        .collect::<Result<Vec<_>, _>>()?;
    fuse_cells(cells)
}

pub fn pattern_rect(ctx: &mut Ctx, f: &PatternRect) -> FResult {
    let act = ctx.require_active("Pattern")?;
    let (cx, cy) = (ctx.val(&f.count_x)?, ctx.val(&f.count_y)?);
    require_positive("Pattern", &[("countX", cx), ("countY", cy)])?;
    for (name, n) in [("countX", cx), ("countY", cy)] {
        if n.round_ties_even() as usize > MAX_PATTERN_COUNT {
            return Err(Fail::msg(format!(
                "Pattern: {name} must be at most {MAX_PATTERN_COUNT} (got {n})"
            )));
        }
    }
    let (dx, dy) = (ctx.val(&f.spacing_x)?, ctx.val(&f.spacing_y)?);
    if let Some(sources) = listed(f.features.as_ref()) {
        let (nx, ny) = (copies(cx), copies(cy));
        let places = (0..nx)
            .flat_map(|i| (0..ny).map(move |j| (i, j)))
            .skip(1)
            .map(|(i, j)| Place::Shift([i as f64 * dx, j as f64 * dy, 0.0]))
            .collect::<Vec<_>>();
        return pattern_features(ctx, &f.id, "patternRect", sources, &places);
    }
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
    if n.round_ties_even() as usize > MAX_PATTERN_COUNT {
        return Err(Fail::msg(format!(
            "Pattern: count must be at most {MAX_PATTERN_COUNT} (got {n})"
        )));
    }
    let spacing = ctx.val(&f.spacing)?;
    if let Some(sources) = listed(f.features.as_ref()) {
        exclusive(f.bodies.as_ref())?;
        let off = axis_unit(&f.axis);
        let places = (1..copies(n))
            .map(|i| {
                let d = i as f64 * spacing;
                Place::Shift([d * off[0], d * off[1], d * off[2]])
            })
            .collect::<Vec<_>>();
        return pattern_features(ctx, &f.id, "patternLinear", sources, &places);
    }
    for i in targets(ctx, &f.id, "patternLinear", f.bodies.as_ref())? {
        let out = pattern_linear_shape(ctx.bodies[i].shape(), n, spacing, &f.axis)?;
        ctx.set_shape(i, out);
    }
    Ok(())
}

pub fn pattern_circular(ctx: &mut Ctx, f: &PatternCircular) -> FResult {
    let n = ctx.val(&f.count)?;
    require_positive("Pattern", &[("count", n)])?;
    if n.round_ties_even() as usize > MAX_PATTERN_COUNT {
        return Err(Fail::msg(format!(
            "Pattern: count must be at most {MAX_PATTERN_COUNT} (got {n})"
        )));
    }
    let angle = ctx.val(&f.angle)?;
    if let Some(sources) = listed(f.features.as_ref()) {
        exclusive(f.bodies.as_ref())?;
        let n = copies(n);
        let step = circular_step(n, angle);
        let places = (1..n)
            .map(|k| Place::Turn(axis_rotation(&f.axis, k as f64 * step)))
            .collect::<Vec<_>>();
        return pattern_features(ctx, &f.id, "patternCircular", sources, &places);
    }
    for i in targets(ctx, &f.id, "patternCircular", f.bodies.as_ref())? {
        let out = pattern_circular_shape(ctx.bodies[i].shape(), n, angle, &f.axis)?;
        ctx.set_shape(i, out);
    }
    Ok(())
}

/// The features a pattern repeats, when it lists any.
pub fn pattern_sources(f: &Feature) -> Option<&Vec<String>> {
    match f {
        Feature::PatternRect(p) => listed(p.features.as_ref()),
        Feature::PatternLinear(p) => listed(p.features.as_ref()),
        Feature::PatternCircular(p) => listed(p.features.as_ref()),
        _ => None,
    }
}

fn listed(ids: Option<&Vec<String>>) -> Option<&Vec<String>> {
    ids.filter(|v| !v.is_empty())
}

fn exclusive(bodies: Option<&Vec<String>>) -> FResult {
    if listed(bodies).is_some() {
        return Err(Fail::msg(
            "Pattern: list either bodies or features, not both. A pattern repeats whole bodies, or the cuts and joins of features.",
        ));
    }
    Ok(())
}

enum Place {
    Shift([f64; 3]),
    Turn([f64; 3]),
}

impl Place {
    fn apply(&self, s: &Shape) -> FResult<Shape> {
        Ok(match self {
            Place::Shift(d) => kernel::translated(s, *d)?,
            Place::Turn(r) => kernel::rotated(s, *r)?,
        })
    }
}

const PATTERNABLE: &str = "Only a feature that cuts or joins material can be patterned: a hole, or an extrude, revolve, sweep or loft set to cut or join. To repeat a whole body, pattern the body instead.";

/// The cuts and joins `src` recorded, or why it has none to repeat.
fn recorded(ctx: &Ctx, own: &str, src: &str) -> FResult<Vec<ToolRecord>> {
    if let Some(records) = ctx.tools.get(src) {
        return Ok(records.clone());
    }
    let at = |id: &str| ctx.timeline.iter().position(|s| s.id == id);
    let Some(k) = at(src) else {
        return Err(Fail::msg(format!(
            "Pattern: there is no feature called {src} to repeat."
        )));
    };
    let step = &ctx.timeline[k];
    if at(own).is_some_and(|me| k >= me) {
        return Err(Fail::msg(format!(
            "Pattern: {} comes after this pattern in the timeline, a pattern can only repeat features above it.",
            step.label
        )));
    }
    let why = match step.kind.as_str() {
        "hole" | "extrude" | "revolve" | "sweep" | "loft" | "press-pull" | "patternRect"
        | "patternLinear" | "patternCircular" => format!(
            "Pattern: {} has no cut or join to repeat, it made a new body, is switched off, or did not build.",
            step.label
        ),
        kind => format!("Pattern: {} is a {kind}, which cannot be patterned.", step.label),
    };
    Err(Fail::msg(format!("{why} {PATTERNABLE}")))
}

/// Copies of each listed feature's tool at every place, applied to the body it
/// changed in one boolean. A copy whose box misses that body is left out.
fn pattern_features(
    ctx: &mut Ctx,
    id: &str,
    kind: &str,
    sources: &[String],
    places: &[Place],
) -> FResult {
    let mut records = Vec::new();
    for src in sources {
        records.extend(recorded(ctx, id, src)?);
    }
    for rec in records {
        for bid in &rec.bodies {
            let Some(i) = ctx.find_body(bid) else {
                ctx.skip_feature(id, kind, "target body already consumed or missing");
                continue;
            };
            let body_box = kernel::bbox(ctx.bodies[i].shape());
            let mut tools = Vec::with_capacity(places.len());
            for p in places {
                let copy = p.apply(&rec.tool)?;
                if boxes_meet(kernel::bbox(&copy), body_box) {
                    tools.push(copy);
                }
            }
            if tools.is_empty() {
                continue;
            }
            let out = apply(ctx.bodies[i].shape(), &tools, rec.kind)?;
            ctx.set_shape(i, out);
            ctx.record_tool(id, rec.kind, vec![bid.clone()], kernel::compound(&tools));
        }
    }
    Ok(())
}

fn boxes_meet(a: Option<[f64; 6]>, b: Option<[f64; 6]>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    let tol = 1e-6;
    (0..3).all(|k| a[k] <= b[k + 3] + tol && b[k] <= a[k + 3] + tol)
}

fn apply(body: &Shape, tools: &[Shape], kind: BoolKind) -> FResult<Shape> {
    let solids = kernel::count(body, Kind::Solid);
    let refs: Vec<&Shape> = tools.iter().collect();
    let out = kernel::boolean_op(body, &refs, kind)?;
    match kind {
        BoolKind::Fuse if kernel::count(&out, Kind::Solid) > solids => {
            // A copy whose box overlaps the body without touching it comes out
            // as a separate lump, so each copy stays only when fusing it
            // leaves the solid count alone.
            let mut out = body.clone();
            for tool in tools {
                let next = kernel::boolean_op(&out, &[tool], kind)?;
                if kernel::count(&next, Kind::Solid) <= solids {
                    out = next;
                }
            }
            Ok(kernel::unify_body(&out))
        }
        BoolKind::Fuse => Ok(kernel::unify_body(&out)),
        _ if kernel::count(&out, Kind::Solid) == 0 => Err(Fail::msg(
            "Pattern: the copies would remove the whole body",
        )),
        _ => Ok(out),
    }
}
