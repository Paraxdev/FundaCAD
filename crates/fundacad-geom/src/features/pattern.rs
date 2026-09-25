//! Body patterns, the Python engine's `builder.py` `_handle_pattern_rect`,
//! `_handle_pattern_linear`, `_handle_pattern_circular` and `_pattern_targets`
//! over the Python engine's `solid_ops.py` `_pattern_*` and `_fuse_pattern_cells`. A pattern
//! rewrites its target body in place, so it mints no body ids.
//!
//! With `features` a pattern repeats what those features did instead: the cut
//! or join each one recorded is copied to every other place and applied to the
//! same body again.

use fundacad_core::schema::{
    Axis3, AxisLine, Feature, OneOrMany, PatternAxis, PatternCircular, PatternLinear, PatternRect,
    Real, Selector,
};
use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade::select_access::CurveType;
use opencascade_sys::face_query as fq;

use super::primitives::require_positive;
use crate::builder::{missing_reference, Ctx, FResult, Fail, ToolRecord};
use crate::kernel::{self, BoolKind, Kind};
use crate::select::entity::EdgeEnt;
use crate::select::Resolver;

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
    if !result.is_valid().unwrap_or(false) {
        return Err(Fail::msg(
            "Pattern: the copies overlap and could not be fused into one valid solid. Space them apart, or pattern the feature that made the detail instead of the whole body.",
        ));
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

fn turned_cells(shape: &Shape, count: f64, total: f64, turn: &Turn) -> FResult<Shape> {
    let n = copies(count);
    let step = circular_step(n, total);
    let cells = (0..n)
        .map(|k| turn.place(k as f64 * step).apply(shape))
        .collect::<Result<Vec<_>, _>>()?;
    fuse_cells(cells)
}

/// What a circular pattern turns about: a world axis through the origin, or a
/// placed line.
#[derive(Debug, Clone, PartialEq)]
pub enum Turn {
    World(Axis3),
    Line { origin: [f64; 3], dir: [f64; 3] },
}

impl Turn {
    fn place(&self, deg: f64) -> Place {
        match self {
            Turn::World(a) => Place::Turn(axis_rotation(a, deg)),
            Turn::Line { origin, dir } => Place::Spin(*origin, *dir, deg),
        }
    }

    fn describe(&self) -> String {
        match self {
            Turn::World(a) => format!("the world {} axis through the origin", a.as_str()),
            Turn::Line { origin, dir } => {
                let r = |v: [f64; 3]| v.map(|x| (x * 1000.0).round() / 1000.0 + 0.0);
                format!("the line through {:?} along {:?}", r(*origin), r(*dir))
            }
        }
    }
}

fn line(origin: DVec3, dir: DVec3) -> Option<Turn> {
    let d = dir.normalize_or_zero();
    (d != DVec3::ZERO && origin.is_finite()).then(|| Turn::Line {
        origin: origin.to_array(),
        dir: d.to_array(),
    })
}

/// The direction of a line found on the model points the way its largest
/// component is positive, so the same edge or face always turns the same way
/// (src/features/patternAxis.ts `canonicalDir` is the same rule).
fn canonical(d: DVec3) -> DVec3 {
    let a = d.abs();
    let big = if a.x >= a.y && a.x >= a.z { d.x } else if a.y >= a.z { d.y } else { d.z };
    if big < 0.0 { -d } else { d }
}

fn found_line(origin: DVec3, dir: DVec3) -> Option<Turn> {
    line(origin, canonical(dir.normalize_or_zero()))
}

/// The axis `axisRef` names now: a straight edge's line, a round edge's
/// centre line, a round face's axis, or a flat face's normal through the
/// middle of its box.
fn referenced_axis(ctx: &Ctx, id: &str, sel: &Selector) -> Option<Turn> {
    let pool: Vec<&Shape> = match sel.body().and_then(|b| ctx.find_body(b)) {
        Some(i) => vec![ctx.bodies[i].shape()],
        None => ctx.shapes(),
    };
    axis_on(&pool, id, sel)
}

fn axis_on(pool: &[&Shape], id: &str, sel: &Selector) -> Option<Turn> {
    let one = OneOrMany::One(sel.clone());
    for shape in pool {
        let mut scratch = Vec::new();
        let mut r = Resolver::new(Some(&mut scratch), Some(id));
        if sel.kind() == Some("edge") {
            let Ok(edges) = r.edge_selectors(shape, &one) else { continue };
            if let Some(t) = edges.into_iter().find_map(edge_axis) {
                return Some(t);
            }
        } else {
            let Ok(faces) = r.face_selectors(shape, &one) else { continue };
            if let Some(t) = faces.into_iter().find_map(face_axis) {
                return Some(t);
            }
        }
    }
    None
}

fn edge_axis(edge: Shape) -> Option<Turn> {
    let mut o = [0.0; 7];
    if let Ok(true) = fq::FQ_edge_circle(edge.raw(), &mut o) {
        return found_line(DVec3::new(o[3], o[4], o[5]), DVec3::new(o[0], o[1], o[2]));
    }
    let ent = EdgeEnt::new(edge).ok()?;
    (ent.curve == CurveType::Line).then(|| found_line(ent.mid, ent.dir())).flatten()
}

fn face_axis(face: Shape) -> Option<Turn> {
    let mut o = [0.0; 13];
    let kind = fq::FQ_surface(face.raw(), &mut o).ok()?;
    let dir = DVec3::new(o[1], o[2], o[3]);
    let at = DVec3::new(o[4], o[5], o[6]);
    match kind {
        0 => {
            // The middle of the face's box rather than its area centroid, which
            // the holes in it pull off centre.
            let b = kernel::bbox(&face)?;
            let mid = DVec3::new(b[0] + b[3], b[1] + b[4], b[2] + b[5]) / 2.0;
            let n = dir.normalize_or_zero();
            found_line(mid - n * (mid - at).dot(n), n)
        }
        1 | 2 | 4 | 5 => found_line(at, dir),
        _ => None,
    }
}

/// The `patternAxis` op: the line `ref` names on the built model, for the
/// pattern tool's preview, `{axis: {origin, dir}}` or `{reason}`.
pub fn pattern_axis_result(req: &serde_json::Map<String, serde_json::Value>, watch: &dyn crate::builder::Watch) -> fundacad_protocol::JobResult {
    use serde_json::json;
    let (_, built) = match crate::inspect::rebuild_request(req, watch) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Some(sel) = req.get("ref").and_then(|v| serde_json::from_value::<Selector>(v.clone()).ok()) else {
        return fundacad_engine::error_result("'ref'");
    };
    let wanted = sel.body().map(str::to_owned);
    let pool: Vec<&Shape> = built
        .bodies
        .iter()
        .filter(|b| wanted.as_deref().map_or(true, |w| b.id == w))
        .map(|b| &b.shape)
        .collect();
    let reply = match axis_on(&pool, "", &sel) {
        Some(Turn::Line { origin, dir }) => json!({"axis": {"origin": origin, "dir": dir}}),
        _ => json!({"reason": "an axis is a straight or round edge, or a flat, cylindrical or conical face"}),
    };
    fundacad_protocol::JobResult::Json(reply.as_object().cloned().unwrap_or_default())
}

/// The datum axis `name`, above `own`, where it resolved this rebuild.
fn datum_axis(ctx: &Ctx, own: &str, name: &str) -> FResult<Turn> {
    let at = |id: &str| ctx.timeline.iter().position(|s| s.id == id);
    let above = at(name).filter(|&k| at(own).map_or(true, |me| k < me));
    let Some(k) = above.filter(|&k| ctx.timeline[k].kind == "datumAxis") else {
        return Err(missing_reference(format!(
            "Pattern: axis {{\"datum\": \"{name}\"}} names no datum axis above this pattern."
        )));
    };
    let step = &ctx.timeline[k];
    let v = |x: &serde_json::Value| -> Option<DVec3> {
        let a = x.as_array()?;
        Some(DVec3::new(a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?))
    };
    let followed = ctx
        .datum_marks
        .get(name)
        .and_then(|m| Some((v(m.get("origin")?)?, v(m.get("dir")?)?)));
    let stored = step.line.map(|[o, d]| (DVec3::from_array(o), DVec3::from_array(d)));
    followed
        .or(stored)
        .and_then(|(o, d)| line(o, d))
        .ok_or_else(|| Fail::msg(format!("Pattern: the datum axis {} has no direction.", step.label)))
}

fn stored_axis(ctx: &Ctx, own: &str, axis: &PatternAxis) -> FResult<Turn> {
    match axis {
        PatternAxis::Named(a @ (Axis3::X | Axis3::Y | Axis3::Z)) => Ok(Turn::World(a.clone())),
        PatternAxis::Named(other) => Err(Fail::msg(format!(
            "Pattern: axis \"{}\" is not X, Y or Z. A datum axis is {{\"datum\": \"{}\"}}, a placed line {{\"origin\": [x, y, z], \"dir\": [x, y, z]}}.",
            other.as_str(),
            other.as_str()
        ))),
        PatternAxis::Datum(d) => datum_axis(ctx, own, &d.datum),
        PatternAxis::Line(AxisLine { origin, dir, .. }) => {
            let v = |r: &[Real; 3]| DVec3::new(r[0].get(), r[1].get(), r[2].get());
            line(v(origin), v(dir)).ok_or_else(|| Fail::msg("Pattern: the axis line has no direction."))
        }
    }
}

/// A build that predates `axisRef` ignores it and would turn about a bare X, Y
/// or Z without a word, where a line in `axis` makes it refuse the pattern.
const AXIS_REF_NEEDS_A_LINE: &str = "Pattern: with axisRef, axis must be the line it resolves to, {\"origin\": [x, y, z], \"dir\": [x, y, z]}, kept as the fallback for when the reference is lost, not X, Y or Z.";

/// `axisRef` resolved against the bodies now, else the stored `axis`.
pub fn circular_axis(ctx: &mut Ctx, f: &PatternCircular) -> FResult<Turn> {
    if let Some(sel) = &f.axis_ref {
        if matches!(f.axis, PatternAxis::Named(_)) {
            return Err(Fail::msg(AXIS_REF_NEEDS_A_LINE));
        }
        if let Some(t) = referenced_axis(ctx, &f.id, sel) {
            return Ok(t);
        }
        let cached = stored_axis(ctx, &f.id, &f.axis)?;
        ctx.advise(
            &f.id,
            "axisRefLost",
            format!(
                "the edge or face this pattern turns about no longer resolves, it turned about {} as last time",
                cached.describe()
            ),
        );
        return Ok(cached);
    }
    stored_axis(ctx, &f.id, &f.axis)
}

pub fn pattern_rect(ctx: &mut Ctx, f: &PatternRect) -> FResult {
    if listed(f.bodies.as_ref()).is_none() {
        ctx.require_active("Pattern")?;
    }
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
        exclusive(f.bodies.as_ref())?;
        let (nx, ny) = (copies(cx), copies(cy));
        let places = (0..nx)
            .flat_map(|i| (0..ny).map(move |j| (i, j)))
            .skip(1)
            .map(|(i, j)| Place::Shift([i as f64 * dx, j as f64 * dy, 0.0]))
            .collect::<Vec<_>>();
        let missed = pattern_features(ctx, &f.id, "patternRect", sources, &places)?;
        if let Some(note) = missed {
            ctx.advise(&f.id, "copiesMissed", format!("{note}, check the spacing"));
        }
        return Ok(());
    }
    for i in targets(ctx, &f.id, "patternRect", f.bodies.as_ref())? {
        let out = pattern_rect_shape(ctx.bodies[i].shape(), cx, cy, dx, dy)?;
        ctx.set_shape(i, out);
    }
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
        let missed = pattern_features(ctx, &f.id, "patternLinear", sources, &places)?;
        if let Some(note) = missed {
            ctx.advise(&f.id, "copiesMissed", format!("{note}, check the spacing and direction"));
        }
        return Ok(());
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
        let turn = circular_axis(ctx, f)?;
        let n = copies(n);
        let step = circular_step(n, angle);
        let places = (1..n).map(|k| turn.place(k as f64 * step)).collect::<Vec<_>>();
        let missed = pattern_features(ctx, &f.id, "patternCircular", sources, &places)?;
        if let Some(note) = missed {
            let about = turn.describe();
            ctx.advise(&f.id, "copiesMissed", format!("{note}, the pattern turns about {about}, check its axis"));
        }
        return Ok(());
    }
    let ids = targets(ctx, &f.id, "patternCircular", f.bodies.as_ref())?;
    let turn = circular_axis(ctx, f)?;
    for i in ids {
        let out = turned_cells(ctx.bodies[i].shape(), n, angle, &turn)?;
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
    Spin([f64; 3], [f64; 3], f64),
}

impl Place {
    fn apply(&self, s: &Shape) -> FResult<Shape> {
        Ok(match self {
            Place::Shift(d) => kernel::translated(s, *d)?,
            Place::Turn(r) => kernel::rotated(s, *r)?,
            Place::Spin(o, d, deg) => kernel::rotated_about(s, *o, *d, *deg)?,
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
    // Only what is above this pattern may shape the message, a rebuild resumed
    // from a checkpoint keeps it while later features come and go.
    let above = at(src).filter(|&k| at(own).map_or(true, |me| k < me));
    let Some(k) = above else {
        return Err(missing_reference(format!(
            "Pattern: there is no feature called {src} to repeat."
        )));
    };
    let step = &ctx.timeline[k];
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
/// changed in one boolean. A copy whose box misses that body is left out, and
/// saying how many were is the note this returns.
fn pattern_features(
    ctx: &mut Ctx,
    id: &str,
    kind: &str,
    sources: &[String],
    places: &[Place],
) -> FResult<Option<String>> {
    let mut records = Vec::new();
    for src in sources {
        records.extend(recorded(ctx, id, src)?);
    }
    let (mut missed, mut total) = (0usize, 0usize);
    let mut missed_bodies: Vec<String> = Vec::new();
    for rec in records {
        for bid in &rec.bodies {
            let Some(i) = ctx.find_body(bid) else {
                ctx.skip_feature(id, kind, "target body already consumed or missing");
                continue;
            };
            let body_box = kernel::bbox(ctx.bodies[i].shape());
            let mut tools = Vec::with_capacity(places.len());
            total += places.len() + 1;
            for p in places {
                let copy = p.apply(&rec.tool)?;
                if boxes_meet(kernel::bbox(&copy), body_box) {
                    tools.push(copy);
                } else {
                    missed += 1;
                    if !missed_bodies.contains(bid) {
                        missed_bodies.push(bid.clone());
                    }
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
    Ok((missed > 0).then(|| {
        format!("{missed} of {total} copies miss {} and change nothing", missed_bodies.join(", "))
    }))
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
