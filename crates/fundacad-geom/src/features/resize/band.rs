//! The solids a resize is cut from: the face's surface at a new size, and a
//! neighbour's whole surface to split it along.

use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade_sys as ffi;

use super::surface::{faces_of, inner_point, nappe, radial, surf, Surf};
use crate::kernel;

/// The cone offset by `delta` along its normal, between axial bounds measured
/// from the apex toward `p`'s nappe.
pub(super) fn cone_tool(s: &Surf, delta: f64, p: DVec3, bounds: (f64, f64)) -> Option<Shape> {
    let Surf::Cone { dir, semi, apex } = *s else { return None };
    let a = nappe(dir, apex, p);
    let al = semi.abs();
    let e = radial(a, apex, p).normalize_or_zero();
    let shift = delta / al.sin();
    let apex2 = apex - a * shift;
    let (lo, hi) = bounds;
    let (lo2, hi2) = ((lo + shift).max(0.0), hi + shift);
    if hi2 <= 1e-6 {
        return None;
    }
    let pt = |t: f64, rho: f64| (apex2 + a * t + e * rho).to_array();
    let mut pts = vec![pt(lo2, 0.0), pt(hi2, 0.0), pt(hi2, hi2 * al.tan())];
    if lo2 > 1e-9 {
        pts.push(pt(lo2, lo2 * al.tan()));
    }
    let profile = kernel::polygon_face(&pts).ok()?;
    kernel::revolve(&profile, apex2.to_array(), a.to_array(), 360.0).ok()
}

/// The solid on the centre side of the group's surface offset by `delta`,
/// reaching `ext` past the group along its axis but not far past `body`.
/// None where the offset surface does not exist.
pub(super) fn long_tool(group: &Shape, s: &Surf, delta: f64, ext: f64, body: &Shape) -> Option<Shape> {
    let margin = 1.0 + 2.0 * delta.abs();
    match *s {
        Surf::Cyl { dir, loc, r } => {
            let (lo, hi) = kernel::axial_extent(group, loc.to_array(), dir.to_array())?;
            let (lo, hi) = clipped((lo - ext, hi + ext), body, loc, dir, margin);
            (r + delta > 1e-6).then(|| Shape::cylinder(loc + dir * lo, r + delta, dir, hi - lo))
        }
        Surf::Cone { dir, apex, .. } => {
            let p = kernel::subshapes(group, kernel::Kind::Face).iter().find_map(inner_point)?.0;
            let a = nappe(dir, apex, p);
            let (lo, hi) = kernel::axial_extent(group, apex.to_array(), a.to_array())?;
            cone_tool(s, delta, p, clipped((lo - ext, hi + ext), body, apex, a, margin))
        }
        Surf::Sphere { c, r } => (r + delta > 1e-6).then(|| Shape::sphere(r + delta).at(c).build()),
        Surf::Torus { dir, loc, big, small } => {
            let s2 = small + delta;
            (s2 > 1e-6 && s2 < big).then(|| Shape::torus().at(loc).z_axis(dir).radius_1(big).radius_2(s2).build())
        }
        _ => None,
    }
}

/// `span` along the axis through `o` along `dir`, cut back to `margin` past
/// the body, read off the corners of its control point box.
pub(super) fn clipped(span: (f64, f64), body: &Shape, o: DVec3, dir: DVec3, margin: f64) -> (f64, f64) {
    let Some(b) = kernel::coarse_bbox(body) else { return span };
    let along = (0..8).map(|i| {
        let c = DVec3::new(b[if i & 1 == 0 { 0 } else { 3 }], b[if i & 2 == 0 { 1 } else { 4 }], b[if i & 4 == 0 { 2 } else { 5 }]);
        (c - o).dot(dir)
    });
    let (blo, bhi) = along.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), t| (lo.min(t), hi.max(t)));
    let (lo, hi) = (span.0.max(blo - margin), span.1.min(bhi + margin));
    if lo < hi {
        (lo, hi)
    } else {
        span
    }
}

/// The neighbour's whole surface as faces reaching `size` around it, so a
/// band split along it is cut right through.
pub(super) fn whole_surface(n: &Shape, size: f64) -> Option<Shape> {
    let l = size;
    let s = surf(n);
    let solid = match s {
        Surf::Plane { n: nn, .. } => {
            let (p, _) = inner_point(n)?;
            let x = nn.any_orthonormal_vector();
            let y = nn.cross(x);
            let c = |a: f64, b: f64| (p + x * a + y * b).to_array();
            return kernel::polygon_face(&[c(-l, -l), c(l, -l), c(l, l), c(-l, l)]).ok();
        }
        Surf::Cyl { dir, loc, r } => {
            let (p, _) = inner_point(n)?;
            let base = loc + dir * ((p - loc).dot(dir) - l);
            Shape::cylinder(base, r, dir, 2.0 * l)
        }
        Surf::Sphere { c, r } => Shape::sphere(r).at(c).build(),
        Surf::Torus { dir, loc, big, small } => Shape::torus().at(loc).z_axis(dir).radius_1(big).radius_2(small).build(),
        Surf::Cone { dir, apex, .. } => {
            let (p, _) = inner_point(n)?;
            let a = nappe(dir, apex, p);
            let (lo, hi) = kernel::axial_extent(n, apex.to_array(), a.to_array())?;
            cone_tool(&s, 0.0, p, ((lo - l).max(0.0), hi + l))?
        }
        Surf::Other => {
            // A freeform neighbour is cut along its untrimmed surface, which covers any opening cut through it.
            let f = ffi::topo_ds::Face(n.raw());
            let h = ffi::b_rep::BRep_Tool_Surface(f);
            let mut mk = ffi::b_rep_builder_api::BRepBuilderAPI_MakeFace_surface(&h, 1e-7);
            if !mk.IsDone() {
                return None;
            }
            return Some(Shape::from_raw_ref(mk.pin_mut().Shape()));
        }
    };
    Some(kernel::compound(&faces_of(&solid)))
}
