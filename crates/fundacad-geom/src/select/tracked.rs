//! `by:"tracked"`: a flat face kept by its outward normal, found again however
//! far a change upstream moves it.
//!
//! The candidates are the flat faces that still face the stored way. Each is
//! scored as if it were the face moved: by how far its outline moved from the
//! stored `center`, plus how far the pick point, moved with it, lands off it.
//! Without a `center` only the travel along the normal counts, the one motion
//! the pick point alone can follow.

use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade::select_access::SurfaceType;
use serde_json::{Map, Value};

use super::entity::{faces_of, need, unit, vector, FaceEnt, Key};
use super::{Kind, Resolver, REFERENCE_NOT_FOUND};
use crate::builder::FResult;
use crate::kernel;

/// 1 - dot of a face normal against the stored one, about 2.6 degrees.
const ANG_TOL: f64 = 1e-3;

pub fn outline_center(face: &Shape) -> Option<DVec3> {
    kernel::outline_center(face).map(DVec3::from_array)
}

/// How far `face` moved since the selector was written, zero without a
/// stored `center` to measure it from.
pub fn shift(face: &Shape, sel: &Map<String, Value>) -> FResult<DVec3> {
    let Some(c) = sel.get("center").filter(|c| !c.is_null()) else {
        return Ok(DVec3::ZERO);
    };
    let c = vector(c)?;
    Ok(outline_center(face).map_or(DVec3::ZERO, |now| now - c))
}

pub(super) fn resolve(r: &mut Resolver, part: &Shape, m: &Map<String, Value>) -> FResult<Vec<FaceEnt>> {
    let p = vector(need(m, "point")?)?;
    let n = unit(vector(need(m, "normal")?)?);
    let center = m.get("center").filter(|c| !c.is_null()).map(vector).transpose()?;
    let cands: Vec<FaceEnt> = faces_of(part)?
        .into_iter()
        .filter(|f| f.surface == SurfaceType::Plane && f.normal().dot(n) >= 1.0 - ANG_TOL)
        .collect();
    if cands.is_empty() {
        r.push(
            "face",
            0,
            0.0,
            true,
            Some("no flat face faces the way this one did".into()),
            m.get("point"),
            None,
            Some(REFERENCE_NOT_FOUND),
        );
        return Ok(Vec::new());
    }
    let costs: Vec<f64> = cands
        .iter()
        .map(|f| {
            let moved = match center {
                Some(c) => outline_center(&f.shape).map_or(f.centroid() - c, |now| now - c),
                None => n * (n.dot(f.centroid()) - n.dot(p)),
            };
            let q = p + moved;
            let fnorm = f.normal();
            let flat = q - fnorm * (fnorm.dot(q) - fnorm.dot(f.centroid()));
            let off = f.distance(flat).map_or((f.centroid() - flat).length(), |d| d.0);
            off + moved.length()
        })
        .collect();
    let keys: Vec<Key> = cands.iter().map(FaceEnt::canonical_key).collect();
    let pick = r.nearest_one(Kind::Face, m, &costs, &keys, |i| cands[i].describe(), |_| None)?;
    Ok(cands.into_iter().nth(pick.index).into_iter().collect())
}
