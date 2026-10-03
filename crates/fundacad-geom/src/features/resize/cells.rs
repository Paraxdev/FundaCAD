//! A resize as the band between the old and the new surface, split along each
//! neighbour's whole surface, keeping the cells that touch the face: the
//! neighbours keep their own surfaces and are trimmed or extended to meet it.

use opencascade::boolean_op::{bop_split, BooleanOptions};
use opencascade::primitives::Shape;
use opencascade::progress::ProgressRange;
use opencascade::query::PointState;

use super::band::{long_tool, whole_surface};
use super::check::{checked, Expect};
use super::neighbours::{splits_band, Nb};
use super::surface::{faces_of, inner_points, Surf};
use super::{refusal, Bad};
use crate::kernel::{self, BoolKind, Kind};

pub(super) fn boolean(a: &Shape, b: &Shape, k: BoolKind) -> Result<Shape, Bad> {
    kernel::boolean_op(a, &[b], k).map_err(|_| Bad::Failed)
}

/// A face of `cell` lies on one of `faces`, inside it.
pub(super) fn touches(cell: &Shape, faces: &[Shape]) -> bool {
    let tau = std::f64::consts::TAU;
    faces.iter().filter_map(Shape::as_face).any(|f| {
        let closure = f.closure().ok();
        // A projection answers in the surface's first period, the face may sit in another.
        let us: &[f64] = if closure.is_some_and(|c| c.u_periodic) { &[0.0, tau, -tau] } else { &[0.0] };
        let vs: &[f64] = if closure.is_some_and(|c| c.v_periodic) { &[0.0, tau, -tau] } else { &[0.0] };
        faces_of(cell).iter().any(|cf| {
            inner_points(cf, 4).into_iter().any(|q| {
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
    let pieces = if cut { boolean(body, band, BoolKind::Common)? } else { boolean(band, body, BoolKind::Cut)? };
    let split = if tools.is_empty() {
        pieces
    } else {
        bop_split([&pieces], tools.iter(), BooleanOptions::default(), &ProgressRange::detached()).map_err(|_| Bad::Failed)?
    };
    let keep: Vec<Shape> = kernel::subshapes(&split, Kind::Solid).into_iter().filter(|c| touches(c, faces)).collect();
    if keep.is_empty() {
        return Err(Bad::Failed);
    }
    Ok(keep)
}

/// `group` (one face and its same surface siblings) moved to size + `delta`.
pub(super) fn cells(body: &Shape, group: &[Shape], s: &Surf, nbs: &[Nb], delta: f64, cut: bool) -> Result<Shape, Bad> {
    let g = kernel::compound(group);
    let ext = 2.0 * kernel::bbox_diagonal(&g).max(1.0) + 2.0 * delta.abs();
    let tool = |d: f64| long_tool(&g, s, d, ext).ok_or_else(|| Bad::Refused(refusal::size_at_zero(s)));
    let band = if delta > 0.0 { tool(delta)? } else { boolean(&tool(0.0)?, &tool(delta)?, BoolKind::Cut)? };
    let size = 2.0 * (kernel::bbox_diagonal(&band) + kernel::bbox_diagonal(&g));
    let tools: Vec<Shape> = nbs
        .iter()
        .filter(|nb| splits_band(s, nb, delta))
        .map(|nb| whole_surface(&nb.face, size).ok_or(Bad::Failed))
        .collect::<Result<_, _>>()?;
    let keep = split_keep(body, &band, cut, &tools, group)?;
    let out = boolean(body, &kernel::compound(&keep), if cut { BoolKind::Cut } else { BoolKind::Fuse })?;
    checked(body, &out, cut, &Expect { surf: s, delta, keep: &keep })
}
