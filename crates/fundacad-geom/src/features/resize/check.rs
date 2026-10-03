//! Whether a resized body is the one asked for.

use opencascade::modify::UnifyOptions;
use opencascade::primitives::Shape;

use super::surface::{area_at, faces_at, inner_points, tol_apart, Surf};
use super::{refusal, Bad};
use crate::kernel::{self, Kind};

/// What the resized face should look like afterwards.
pub(super) struct Expect<'a> {
    pub surf: &'a Surf,
    pub delta: f64,
    pub keep: &'a [Shape],
}

/// One valid solid that gained or lost material as asked. Solids are counted
/// before anything unifies them: unifying a result in pieces has been seen to
/// rewrite the shapes its input shares.
pub fn checked_solid(before: &Shape, out: &Shape, cut: bool) -> Result<Shape, Bad> {
    one_solid(before, out, cut, false, None)
}

/// `known` is the volume before and after, when the caller measured them.
fn one_solid(before: &Shape, out: &Shape, cut: bool, cone: bool, known: Option<(f64, f64)>) -> Result<Shape, Bad> {
    let out = kernel::unwrap_compound(out);
    match kernel::count(&out, Kind::Solid) {
        0 => return Err(Bad::Failed),
        1 => {}
        _ => return Err(Bad::Refused(refusal::cuts_apart(cone))),
    }
    let valid = |s: &Shape| s.is_valid().unwrap_or(false);
    let out = match out.unify_same_domain(UnifyOptions::default(), &[]).ok().map(|u| u.shape).filter(valid) {
        Some(u) => u,
        None if valid(&out) => out,
        None => return Err(Bad::Failed),
    };
    let (b, a) = known.unwrap_or_else(|| (kernel::volume(before), kernel::volume(&out)));
    if a <= 0.0 || (a < b) != cut || (a - b).abs() < 1e-9 {
        return Err(Bad::Failed);
    }
    Ok(out)
}

pub(super) fn checked(before: &Shape, out: &Shape, cut: bool, known: Option<(f64, f64)>, e: &Expect) -> Result<Shape, Bad> {
    let out = one_solid(before, out, cut, matches!(e.surf, Surf::Cone { .. }), known)?;
    let tol = tol_apart(e.delta);
    if area_at(&out, e.surf, e.delta, tol) < 1e-9 {
        return Err(Bad::Refused(refusal::face_vanishes()));
    }
    // What is left of the old surface must not bound what was added or taken,
    // or the face kept a step of itself where a neighbour should have carried on.
    let stale = faces_at(&out, e.surf, 0.0, tol).into_iter().any(|f| {
        inner_points(&f, 3)
            .into_iter()
            .any(|p| e.keep.iter().any(|c| kernel::distance_to_point(c, p.to_array()).is_some_and(|d| d < 1e-6)))
    });
    if stale {
        return Err(Bad::Refused(refusal::step_left()));
    }
    Ok(out)
}
