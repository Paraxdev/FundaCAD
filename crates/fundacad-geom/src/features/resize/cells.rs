//! A resize as the band between the old and the new surface, split along each
//! neighbour's whole surface, keeping the cells that touch the face: the
//! neighbours keep their own surfaces and are trimmed or extended to meet it.

use opencascade::boolean_op::{bop_split, BooleanKind, BooleanOp, BooleanOptions, Glue};
use opencascade::primitives::Shape;
use opencascade::progress::ProgressRange;
use opencascade::query::PointState;
use opencascade_sys::builder_ops as ffi;

use super::band::{long_tool, whole_surface};
use super::check::{checked, Expect};
use super::memo;
use super::neighbours::{splits_band, Nb};
use super::surface::{faces_of, inner_points, parallel, surf, Surf};
use super::{refusal, Bad};
use crate::kernel::{self, BoolKind, Kind};

/// `kernel::boolean_op`, handed the operands' volumes where they are known.
pub(super) fn boolean(a: &Shape, b: &Shape, k: BoolKind, vols: &[f64]) -> Result<Shape, Bad> {
    let t = kernel::compound([b]);
    let ki = k as i32;
    let mut vol = f64::NAN;
    let args = || format!("base={}, tool={}", kernel::describe(a), kernel::describe(b));
    let out = crate::trace::call(k.occt(), args, || {
        let raw = ffi::bo_bool_build(a.raw(), t.raw(), ki, true, 0.0)?;
        let checked = ffi::bo_bool_check(&raw, a.raw(), t.raw(), ki, true, 0.0, vols, &mut vol)?;
        ffi::bo_clean(&checked)
    })
    .map_err(|_| Bad::Failed)?;
    if out.is_null() {
        return Err(Bad::Failed);
    }
    Ok(kernel::unwrap_compound(&Shape::from_raw(out)))
}

/// `keep` taken out of `body` (`cut`) or added to it. The cells lie inside
/// the body or outside it, meeting it only where their faces lie on its
/// faces, so the kernel is first told they only touch, which skips
/// intersecting faces that cannot cross. That answer is taken only as a
/// valid solid of the volume expected, else it is built in full.
pub(super) fn apply(body: &Shape, keep: &[Shape], cut: bool, e: &Expect) -> Result<Shape, Bad> {
    let a = memo::volume(body);
    let vols: Vec<f64> = keep.iter().map(kernel::volume).collect();
    let cells: f64 = vols.iter().sum();
    if cut && cells >= a * (1.0 - 1e-6) {
        return Err(Bad::Refused(refusal::past_body(matches!(e.surf, Surf::Cone { .. }))));
    }
    let want = if cut { a - cells } else { a + cells };
    let tools = kernel::compound(keep);
    let glued = crate::bench::phase("resize_glued", || {
        let kind = if cut { BooleanKind::Cut } else { BooleanKind::Fuse };
        let options = BooleanOptions { glue: Glue::Shift, parallel: true, ..BooleanOptions::default() };
        let op = BooleanOp::run(kind, [body], [&tools], options, &ProgressRange::detached()).ok()?;
        let out = kernel::unwrap_compound(&op.shape().ok()?);
        let v = kernel::volume(&out);
        if (v - want).abs() > 1e-6 * a.max(cells) + 1e-3 * cells {
            return None;
        }
        let clean = ffi::bo_clean(out.raw()).ok().filter(|s| !s.is_null())?;
        Some((kernel::unwrap_compound(&Shape::from_raw(clean)), v))
    });
    if let Some((out, v)) = glued {
        if let Ok(done) = crate::bench::phase("resize_check", || checked(body, &out, cut, Some((a, v)), e)) {
            memo::count(|s| s.glued += 1);
            return Ok(done);
        }
    }
    let all: Vec<f64> = std::iter::once(a).chain(vols).collect();
    let kind = if cut { BoolKind::Cut } else { BoolKind::Fuse };
    let out = crate::bench::phase("resize_apply", || boolean(body, &tools, kind, &all))?;
    crate::bench::phase("resize_check", || checked(body, &out, cut, None, e))
}

/// `a` could lie on `b`: the same plane or analytic surface, or `b` is
/// freeform. A boolean keeps the surface of a face it splits, so a piece of
/// an analytic face is never freeform.
fn could_lie_on(a: &Surf, b: &Surf) -> bool {
    match (*a, *b) {
        (Surf::Plane { n, loc }, Surf::Plane { n: n2, loc: l2 }) => parallel(n, n2) && (l2 - loc).dot(n).abs() < 1e-5,
        (_, Surf::Other) => true,
        (Surf::Other, _) => false,
        _ => a.offset_of(b).is_some_and(|o| o.abs() < 1e-5),
    }
}

/// A face of `cell` lies on one of `faces`, inside it.
pub(super) fn touches(cell: &Shape, faces: &[Shape]) -> bool {
    let tau = std::f64::consts::TAU;
    let targets: Vec<(Surf, &Shape)> = faces.iter().map(|f| (surf(f), f)).collect();
    faces_of(cell).iter().any(|cf| {
        let cs = surf(cf);
        targets.iter().filter(|(ts, _)| could_lie_on(&cs, ts)).filter_map(|(_, f)| f.as_face()).any(|f| {
            let closure = f.closure().ok();
            // A projection answers in the surface's first period, the face may sit in another.
            let us: &[f64] = if closure.is_some_and(|c| c.u_periodic) { &[0.0, tau, -tau] } else { &[0.0] };
            let vs: &[f64] = if closure.is_some_and(|c| c.v_periodic) { &[0.0, tau, -tau] } else { &[0.0] };
            // A boolean splits faces along every edge it makes, so a face of a cell
            // lies wholly inside one of the faces or wholly outside, and a few points tell.
            let few = inner_points(cf, 2);
            let pts = if few.is_empty() { inner_points(cf, 4) } else { few };
            pts.into_iter().any(|q| {
                let Ok(Some(pr)) = f.project_point(q) else { return false };
                pr.distance < 1e-5
                    && us.iter().any(|du| {
                        vs.iter().any(|dv| f.classify_uv(pr.u + du, pr.v + dv, 1e-7).ok() == Some(PointState::In))
                    })
            })
        })
    })
}

/// The pieces of `band` that are material (`cut`) or void, split along the
/// whole surfaces in `tools`, keeping the ones touching `faces`.
pub(super) fn split_keep(body: &Shape, band: &Shape, cut: bool, tools: &[Shape], faces: &[Shape]) -> Result<Vec<Shape>, Bad> {
    let pieces = crate::bench::phase("resize_pieces", || {
        let (vb, vt) = (memo::volume(body), kernel::volume(band));
        if cut {
            boolean(body, band, BoolKind::Common, &[vb, vt])
        } else {
            boolean(band, body, BoolKind::Cut, &[vt, vb])
        }
    })?;
    let split = if tools.is_empty() {
        pieces
    } else {
        crate::bench::phase("resize_split", || {
            let options = BooleanOptions { parallel: true, ..BooleanOptions::default() };
            bop_split([&pieces], tools.iter(), options, &ProgressRange::detached())
        })
        .map_err(|_| Bad::Failed)?
    };
    let keep: Vec<Shape> = crate::bench::phase("resize_touches", || {
        kernel::subshapes(&split, Kind::Solid).into_iter().filter(|c| touches(c, faces)).collect()
    });
    if keep.is_empty() {
        return Err(Bad::Failed);
    }
    Ok(keep)
}

/// `group` (one face and its same surface siblings) moved to size + `delta`.
pub(super) fn cells(body: &Shape, group: &[Shape], s: &Surf, nbs: &[Nb], delta: f64, cut: bool) -> Result<Shape, Bad> {
    crate::bench::phase("resize_cells", || {
        let g = kernel::compound(group);
        let ext = 2.0 * kernel::bbox_diagonal(&g).max(1.0) + 2.0 * delta.abs();
        let tool = |d: f64| long_tool(&g, s, d, ext, body).ok_or_else(|| Bad::Refused(refusal::size_at_zero(s)));
        let band = if delta > 0.0 { tool(delta)? } else { boolean(&tool(0.0)?, &tool(delta)?, BoolKind::Cut, &[])? };
        let size = 2.0 * (kernel::bbox_diagonal(&band) + kernel::bbox_diagonal(&g));
        let tools: Vec<Shape> = nbs
            .iter()
            .filter(|nb| splits_band(s, nb, delta))
            .map(|nb| memo::whole_surface(&nb.face, size, |l| whole_surface(&nb.face, l)).ok_or(Bad::Failed))
            .collect::<Result<_, _>>()?;
        let keep = split_keep(body, &band, cut, &tools, group)?;
        apply(body, &keep, cut, &Expect { surf: s, delta, keep: &keep })
    })
}
