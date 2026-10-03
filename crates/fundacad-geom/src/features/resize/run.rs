//! A whole closed tangent run (a slot's walls and ends) resized as one: its
//! cross section offset in 2D and swept along the axis, then split and kept
//! the way a lone face is.

use glam::DVec3;
use opencascade::primitives::{JoinType, Shape};

use super::band::{clipped, whole_surface};
use super::cells::{apply, boolean, split_keep};
use super::check::Expect;
use super::memo;
use super::neighbours::{neighbours, EdgeKind};
use super::surface::{inner_point, parallel, surf, Surf};
use super::Bad;
use crate::kernel::{self, BoolKind};
use crate::topo::FaceAdjacency;

/// Every face of the run is a plane or a cylinder along `dir`.
fn prismatic(run: &[Shape], dir: DVec3) -> bool {
    run.iter().all(|f| match surf(f) {
        Surf::Plane { n, .. } => n.dot(dir).abs() < 1e-6,
        Surf::Cyl { dir: d2, .. } => parallel(dir, d2),
        _ => false,
    })
}

/// The face bounded by the run's cross section through `p` square to `dir`.
/// Only the run's own faces are cut, so the wire through `p` closes only
/// when the run closes into one loop by itself.
fn section(run: &[Shape], p: DVec3, dir: DVec3) -> Option<Shape> {
    let faces = kernel::compound(run);
    let l = 2.0 * kernel::bbox_diagonal(&faces) + 1.0;
    let x = dir.any_orthonormal_vector();
    let y = dir.cross(x);
    let c = |a: f64, b: f64| (p + x * a + y * b).to_array();
    let plane = kernel::polygon_face(&[c(-l, -l), c(l, -l), c(l, l), c(-l, l)]).ok()?;
    let edges = opencascade::section::edges(&faces, &plane);
    let wire = kernel::wires_from_edges(&edges, 1e-6)
        .ok()?
        .into_iter()
        .find(|w| kernel::distance_to_point(w, p.to_array()).is_some_and(|d| d < 1e-4))?;
    if !kernel::wire_closed(&wire) {
        return None;
    }
    kernel::face_from_wire(&wire).ok()
}

/// The run's cross section, when the run is prismatic along `face`'s axis and
/// closes into one loop made of its own faces only.
fn closed_section(body: &Shape, run: &[Shape], face: &Shape) -> Option<Shape> {
    memo::section(body, face, || {
        let Surf::Cyl { dir, .. } = surf(face) else { return None };
        if !prismatic(run, dir) {
            return None;
        }
        let (p, _) = inner_point(face)?;
        section(run, p, dir)
    })
}

pub(super) fn closed(body: &Shape, run: &[Shape], face: &Shape) -> bool {
    closed_section(body, run, face).is_some()
}

/// The run moved so `face` changes size by `delta`; None when the run is not
/// closed and prismatic.
pub(super) fn run_offset(body: &Shape, run: &[Shape], face: &Shape, delta: f64, cut: bool) -> Option<Result<Shape, Bad>> {
    let s = surf(face);
    let Surf::Cyl { dir, .. } = s else { return None };
    crate::bench::phase("resize_run", || {
        let old = crate::bench::phase("resize_section", || closed_section(body, run, face))?;
        Some(offset_swept(body, run, &old, &s, dir, delta, cut))
    })
}

fn offset_swept(body: &Shape, run: &[Shape], old: &Shape, s: &Surf, dir: DVec3, delta: f64, cut: bool) -> Result<Shape, Bad> {
    let of = old.as_face().ok_or(Bad::Failed)?;
    // The section is the cutout's void or the boss's material, either way it
    // grows with the radius.
    let new = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| of.offset(delta, JoinType::Arc)))
        .map_err(|_| Bad::Failed)?;
    let new: Shape = new.into();
    if (kernel::area(&new) > kernel::area(old)) != (delta > 0.0) {
        return Err(Bad::Failed);
    }
    // The control point box, since an exact box of a freeform body takes far longer.
    let b = kernel::coarse_bbox(body).ok_or(Bad::Failed)?;
    let l = 2.0 * DVec3::new(b[3] - b[0], b[4] - b[1], b[5] - b[2]).length();
    let (at, _) = inner_point(old).ok_or(Bad::Failed)?;
    let (lo, hi) = clipped((-l, l), body, at, dir, 1.0 + 2.0 * delta.abs());
    let sweep = |f: &Shape| -> Result<Shape, Bad> {
        let moved = kernel::translated(f, (dir * lo).to_array()).map_err(|_| Bad::Failed)?;
        kernel::prism(&moved, (dir * (hi - lo)).to_array()).map_err(|_| Bad::Failed)
    };
    let band = crate::bench::phase("resize_band", || {
        let (po, pn) = (sweep(old)?, sweep(&new)?);
        if delta > 0.0 {
            boolean(&pn, &po, BoolKind::Cut, &[])
        } else {
            boolean(&po, &pn, BoolKind::Cut, &[])
        }
    })?;
    let adj = FaceAdjacency::new(body);
    let size = 2.0 * (kernel::bbox_diagonal(&band).min(4.0 * l) + kernel::bbox_diagonal(&kernel::compound(run)));
    let tools: Vec<Shape> = crate::bench::phase("resize_tools", || {
        neighbours(&adj, run)
            .iter()
            .filter(|nb| nb.kind != Some(EdgeKind::Tangent))
            .map(|nb| memo::whole_surface(&nb.face, size, |l| whole_surface(&nb.face, l)).ok_or(Bad::Failed))
            .collect::<Result<_, _>>()
    })?;
    let keep = split_keep(body, &band, cut, &tools, run)?;
    apply(body, &keep, cut, &Expect { surf: s, delta, keep: &keep })
}
