//! The faces, datum planes and points an extrude starts from or ends at, and a
//! press/pull pushes up to, each read as a plane or a point to measure against.

use fundacad_core::schema::{PointRef, Selector};
use glam::{dvec3, DVec3};
use opencascade::primitives::Shape;
use opencascade::select_access as sa;
use serde_json::Value;

use crate::builder::plane::{plane_of, PlaneRef};
use crate::builder::{Ctx, FResult, Fail};
use crate::kernel::{self, Kind};
use crate::select::entity::FaceEnt;
use crate::select::{Resolver, REFERENCE_NOT_FOUND};

pub fn missing(message: impl Into<String>) -> Fail {
    Fail::Value { message: message.into(), code: Some(REFERENCE_NOT_FOUND) }
}

fn v3(a: [f64; 3]) -> DVec3 {
    dvec3(a[0], a[1], a[2])
}

/// The face `sel` names. A `by: "nearest"` point looks over every body; any
/// other form resolves on the selector's own body, else on `fallback`.
pub fn face(ctx: &mut Ctx, fid: &str, label: &str, sel: &Selector, fallback: Option<usize>) -> FResult<Shape> {
    let value = serde_json::to_value(sel).map_err(|_| Fail::Internal("TypeError".into()))?;
    let near = (value.get("by").and_then(Value::as_str) == Some("nearest"))
        .then(|| value.get("point").and_then(Value::as_array))
        .flatten()
        .and_then(|p| Some([p.first()?.as_f64()?, p.get(1)?.as_f64()?, p.get(2)?.as_f64()?]));
    let found = if let Some(p) = near {
        let mut best: Option<(f64, Shape)> = None;
        for b in &ctx.bodies {
            for fc in kernel::subshapes(b.shape(), Kind::Face) {
                let d = sa::distance_to_point(&fc, p).map_or(f64::INFINITY, |r| r.0);
                if best.as_ref().map_or(true, |(bd, _)| d < *bd) {
                    best = Some((d, fc));
                }
            }
        }
        best.map(|b| b.1)
    } else {
        let idx = match sel.body().filter(|b| !b.is_empty()) {
            Some(b) => ctx
                .find_body(b)
                .ok_or_else(|| missing(format!("{label}: the body of the target face no longer exists")))?,
            None => fallback.ok_or_else(|| missing(format!("{label}: the target face names no body")))?,
        };
        let part = ctx.bodies[idx].shape().clone();
        Resolver::new(Some(&mut ctx.diagnostics), Some(fid)).faces(&part, &value)?.into_iter().next()
    };
    found.ok_or_else(|| missing(format!("{label}: the target face was not found")))
}

/// A face's centre and its normal at the middle, build123d `center()` and `normal_at()`.
pub fn face_plane(face: &Shape) -> (DVec3, DVec3) {
    let c = FaceEnt::new(face.clone()).map_or(DVec3::ZERO, |f| f.centroid());
    (c, kernel::face_normal_mid(face).map_or(DVec3::ZERO, v3))
}

/// A flat face's plane, refusing a curved one.
pub fn flat_face_plane(face: &Shape, label: &str) -> FResult<(DVec3, DVec3)> {
    if !kernel::face_is_planar(face) {
        return Err(Fail::msg(format!("{label}: only a flat face can be a start or end target for now")));
    }
    Ok(face_plane(face))
}

/// A datum plane by id, or XY, XZ, YZ.
pub fn datum_plane(ctx: &Ctx, name: &str) -> FResult<(DVec3, DVec3)> {
    let fr = plane_of(PlaneRef::Name(name), &ctx.datums)?;
    Ok((v3(fr.origin), v3(fr.z)))
}

/// A datum point by id, or the body vertex nearest a stored point.
pub fn point(ctx: &Ctx, label: &str, p: &PointRef) -> FResult<DVec3> {
    match p {
        PointRef::Datum(id) => ctx
            .datum_marks
            .get(id)
            .and_then(|m| m.get("position")?.as_array().cloned())
            .and_then(|a| Some(dvec3(a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?)))
            .or_else(|| ctx.points.get(id).map(|p| v3(*p)))
            .ok_or_else(|| missing(format!("{label}: datum point {id} does not exist"))),
        PointRef::Vertex { point, body } => {
            let at = dvec3(point[0].get(), point[1].get(), point[2].get());
            let bodies: Vec<&Shape> = match body.as_deref().filter(|b| !b.is_empty()) {
                Some(b) => {
                    let i = ctx
                        .find_body(b)
                        .ok_or_else(|| missing(format!("{label}: the body of the target vertex no longer exists")))?;
                    vec![ctx.bodies[i].shape()]
                }
                None => ctx.bodies.iter().map(|b| b.shape()).collect(),
            };
            bodies
                .into_iter()
                .flat_map(|s| kernel::subshapes(s, Kind::Vertex))
                .filter_map(|v| kernel::bbox(&v).map(|b| dvec3(b[0], b[1], b[2])))
                .min_by(|a, b| a.distance(at).total_cmp(&b.distance(at)))
                .ok_or_else(|| missing(format!("{label}: the target vertex was not found")))
        }
    }
}
