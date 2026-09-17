//! Face-anchored sketch and datum planes, sidecar/geom_select.py
//! `resolve_face_on_plane` and its fallback prose.

use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade::select_access::SurfaceType;
use serde_json::Value;

use super::entity::{faces_of, key_cmp, unit, FaceEnt};
use super::{finite3, Resolver, AMBIGUOUS_REFERENCE, PLANE_TILTED, REFERENCE_NOT_FOUND};

/// 1 - |dot| of a face normal against the cached plane normal, about 2.6 degrees.
const PLANE_ANG_TOL: f64 = 1e-3;
/// mm of plane offset within which two co-normal faces are the same plane.
const PLANE_COPLANAR_TOL: f64 = 1e-3;

/// The sentence a face-anchored plane that fell back reports. The tilted case
/// does not say re-pick: picking the tilted face again reproduces it.
pub fn plane_fallback_reason(code: &str, label: &str, detail: Option<&str>) -> String {
    let noun = label.to_lowercase();
    let stayed = format!("{noun} stayed at its saved position. Re-pick the face.");
    if code == PLANE_TILTED {
        return format!(
            "{label}: the face this {noun} sits on has tilted, so the {noun} stayed at its saved position. Put it on the face again to follow the new angle."
        );
    }
    if code == AMBIGUOUS_REFERENCE {
        return format!(
            "{label}: this {noun}'s face reference no longer identifies one face, {}. The {stayed}",
            detail.unwrap_or("None")
        );
    }
    format!("{label}: the face this {noun} sits on is gone, so the {stayed}")
}

/// `push_plane_fallback`: lossy stays false, no match was taken at all, and a
/// lossy entry would make a projection refuse an unrelated source.
fn push_plane_fallback(
    r: &mut Resolver,
    code: &'static str,
    label: &str,
    sel: &Value,
    detail: Option<&str>,
) {
    let reason = plane_fallback_reason(code, label, detail);
    let at = sel.as_object().and_then(|m| m.get("point"));
    r.push(
        "face",
        0,
        0.0,
        false,
        Some(Value::from(reason)),
        at,
        None,
        Some(code),
    );
}

pub(super) fn resolve_face_on_plane(
    r: &mut Resolver,
    part: Option<&Shape>,
    sel: &Value,
    normal: [f64; 3],
    label: &str,
) -> Option<Shape> {
    let faces = match part {
        Some(p) => faces_of(p).unwrap_or_default(),
        None => Vec::new(),
    };
    let planar: Vec<FaceEnt> = faces
        .into_iter()
        .filter(|f| f.surface == SurfaceType::Plane)
        .collect();
    if planar.is_empty() {
        push_plane_fallback(r, REFERENCE_NOT_FOUND, label, sel, None);
        return None;
    }
    // A point that is not three finite numbers is never guessed at: read as the
    // origin, the anchor would bind whatever face is nearest it, silently.
    let Some(pt) = sel.as_object().and_then(|m| finite3(m.get("point"))) else {
        push_plane_fallback(r, REFERENCE_NOT_FOUND, label, sel, None);
        return None;
    };

    let d = unit(DVec3::from_array(normal));
    // Same sign first: the body's far side is co-normal under abs and would
    // take the anchor whenever it is nearer the point.
    let mut cands: Vec<&FaceEnt> = planar
        .iter()
        .filter(|f| f.normal().dot(d) >= 1.0 - PLANE_ANG_TOL)
        .collect();
    if cands.is_empty() {
        cands = planar
            .iter()
            .filter(|f| f.normal().dot(d).abs() >= 1.0 - PLANE_ANG_TOL)
            .collect();
    }
    if cands.is_empty() {
        push_plane_fallback(r, PLANE_TILTED, label, sel, None);
        return None;
    }

    let p = DVec3::from_array(pt);
    // Ranked in-plane: the point stays over its face however far that face
    // slides along its normal, the one motion this follows.
    let flat = |f: &FaceEnt| {
        let n = f.normal();
        p - n * (n.dot(p) - n.dot(f.centroid()))
    };
    let travel = |f: &FaceEnt| (d.dot(f.centroid()) - d.dot(p)).abs();
    let bounded: Option<Vec<f64>> = cands
        .iter()
        .map(|f| f.distance(flat(f)).map(|x| x.0))
        .collect();
    let dists = bounded.unwrap_or_else(|| {
        cands
            .iter()
            .map(|f| (f.centroid() - flat(f)).length())
            .collect()
    });

    let mut scored: Vec<(f64, usize)> = dists.iter().copied().zip(0..).collect();
    super::stable_sort_by_cost(&mut scored);
    let (mut best_d, mut best_i) = scored[0];

    // A winner that contains the point but left the saved plane is either the
    // anchored face moved there or the floor of a cut under the point; an
    // unmoved face nearer in-plane than that travel is the better story.
    let win_travel = travel(cands[best_i]);
    if best_d <= PLANE_COPLANAR_TOL && win_travel > PLANE_COPLANAR_TOL {
        let stayed: Vec<(f64, usize)> = scored
            .iter()
            .copied()
            .filter(|&(dd, i)| travel(cands[i]) <= PLANE_COPLANAR_TOL && dd < win_travel)
            .collect();
        if !stayed.is_empty() {
            scored = stayed;
            (best_d, best_i) = scored[0];
        }
    }
    let runner = scored.get(1).map_or(f64::INFINITY, |s| s.0);
    let margin = super::margin_of(best_d, runner);
    let band = r.tuning.nearest_tie_band;
    if margin >= band {
        return Some(cands[best_i].shape.clone());
    }

    let mut tied: Vec<&FaceEnt> = scored
        .iter()
        .filter(|(dd, _)| (dd - best_d) / (runner + 1e-9) < band)
        .map(|&(_, i)| cands[i])
        .collect();
    // A tie within one plane (a slot splitting the anchored face) has nothing
    // to be wrong about. Never a margin rule: that split is exact by construction.
    let off = d.dot(cands[best_i].centroid());
    if tied
        .iter()
        .all(|f| (d.dot(f.centroid()) - off).abs() <= PLANE_COPLANAR_TOL)
    {
        return Some(cands[best_i].shape.clone());
    }

    tied.sort_by(|a, b| key_cmp(&a.canonical_key(), &b.canonical_key()));
    let detail = tied
        .iter()
        .take(3)
        .map(|f| f.describe().unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" and ");
    push_plane_fallback(r, AMBIGUOUS_REFERENCE, label, sel, Some(&detail));
    None
}
