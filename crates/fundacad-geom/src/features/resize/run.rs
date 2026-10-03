//! A whole closed tangent run (a slot's walls and ends) resized as one: its
//! cross section offset in 2D and swept along the axis, then split and kept
//! the way a lone face is.

use glam::DVec3;
use opencascade::primitives::{JoinType, Shape};

use super::band::whole_surface;
use super::cells::{boolean, split_keep};
use super::check::{checked, Expect};
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

/// The body's cross section through `p` square to `dir`, as the closed wire
/// through `p`, and the face it bounds.
fn section(body: &Shape, p: DVec3, dir: DVec3) -> Option<(Shape, Shape)> {
    let l = 2.0 * kernel::bbox_diagonal(body);
    let x = dir.any_orthonormal_vector();
    let y = dir.cross(x);
    let c = |a: f64, b: f64| (p + x * a + y * b).to_array();
    let plane = kernel::polygon_face(&[c(-l, -l), c(l, -l), c(l, l), c(-l, l)]).ok()?;
    let edges = opencascade::section::edges(body, &plane);
    let wire = kernel::wires_from_edges(&edges, 1e-6)
        .ok()?
        .into_iter()
        .find(|w| kernel::distance_to_point(w, p.to_array()).is_some_and(|d| d < 1e-4))?;
    if !kernel::wire_closed(&wire) {
        return None;
    }
    let face = kernel::face_from_wire(&wire).ok()?;
    Some((wire, face))
}

/// The run's cross section, when the run is prismatic along `face`'s axis and
/// closes into one loop made of its own faces only.
fn closed_section(body: &Shape, run: &[Shape], face: &Shape) -> Option<Shape> {
    let Surf::Cyl { dir, .. } = surf(face) else { return None };
    if !prismatic(run, dir) {
        return None;
    }
    let (p, _) = inner_point(face)?;
    let (wire, profile) = section(body, p, dir)?;
    let own = kernel::subshapes(&wire, kernel::Kind::Edge).iter().all(|e| {
        let Some((m, _)) = kernel::edge_eval(e, 0.0).and_then(|(_, [a, b])| kernel::edge_eval(e, 0.5 * (a + b))) else {
            return false;
        };
        run.iter().any(|f| kernel::distance_to_point(f, m).is_some_and(|d| d < 1e-5))
    });
    own.then_some(profile)
}

pub(super) fn closed(body: &Shape, run: &[Shape], face: &Shape) -> bool {
    closed_section(body, run, face).is_some()
}

/// The run moved so `face` changes size by `delta`; None when the run is not
/// closed and prismatic.
pub(super) fn run_offset(body: &Shape, run: &[Shape], face: &Shape, delta: f64, cut: bool) -> Option<Result<Shape, Bad>> {
    let s = surf(face);
    let Surf::Cyl { dir, .. } = s else { return None };
    let old = closed_section(body, run, face)?;
    Some(offset_swept(body, run, &old, &s, dir, delta, cut))
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
    let l = 2.0 * kernel::bbox_diagonal(body);
    let sweep = |f: &Shape| -> Result<Shape, Bad> {
        let moved = kernel::translated(f, (-dir * l).to_array()).map_err(|_| Bad::Failed)?;
        kernel::prism(&moved, (dir * 2.0 * l).to_array()).map_err(|_| Bad::Failed)
    };
    let (po, pn) = (sweep(old)?, sweep(&new)?);
    let band = if delta > 0.0 { boolean(&pn, &po, BoolKind::Cut)? } else { boolean(&po, &pn, BoolKind::Cut)? };
    let adj = FaceAdjacency::new(body);
    let size = 2.0 * (kernel::bbox_diagonal(&band).min(4.0 * l) + kernel::bbox_diagonal(&kernel::compound(run)));
    let tools: Vec<Shape> = neighbours(&adj, run)
        .iter()
        .filter(|nb| nb.kind != Some(EdgeKind::Tangent))
        .map(|nb| whole_surface(&nb.face, size).ok_or(Bad::Failed))
        .collect::<Result<_, _>>()?;
    let keep = split_keep(body, &band, cut, &tools, run)?;
    let out = boolean(body, &kernel::compound(&keep), if cut { BoolKind::Cut } else { BoolKind::Fuse })?;
    checked(body, &out, cut, &Expect { surf: s, delta, keep: &keep })
}
