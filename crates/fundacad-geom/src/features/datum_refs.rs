//! Datums rebuilt from model references every rebuild: the `through` planes and
//! axes and a datum point's `at`. A reference that stops resolving keeps the
//! cached placement and leaves a diagnostic, never an error.

use fundacad_core::schema::{AxisThrough, DatumAxis, DatumPlane, DatumPoint, PlaneOf, PlaneThrough, PointAt, Selector};
use glam::{DQuat, DVec3};
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, CurveType, SurfaceType};
use serde_json::Value;

use super::face_anchor::{agree_with, cylinder_axis, plane_from_point_normal, unit, with_x_dir, Placement};
use crate::builder::plane::{named, plane_of, PlaneRef};
use crate::builder::{missing_reference, Ctx, FResult};
use crate::kernel::{self, Frame};
use crate::select::{entity::EdgeEnt, Resolver};

/// Below this, two lines count as parallel or as meeting, in mm or as a sine.
const TOL: f64 = 1e-6;

struct Look<'c> {
    ctx: &'c Ctx,
    id: &'c str,
    notes: Vec<Value>,
    missed: Option<(&'static str, [f64; 3])>,
}

impl<'c> Look<'c> {
    fn new(ctx: &'c Ctx, id: &'c str) -> Self {
        Look { ctx, id, notes: Vec::new(), missed: None }
    }

    fn done(self) -> Lost {
        (self.notes, self.missed)
    }

    /// Keeps the first selector that gave nothing usable, by the point the
    /// re-pick flow finds it with: its stored point, or a fingerprint's middle.
    fn miss<T>(&mut self, kind: &'static str, sel: &Selector) -> Option<T> {
        if self.missed.is_none() {
            let v = serde_json::to_value(sel).unwrap_or(Value::Null);
            let at = v.get("point").or_else(|| v.get("fp").and_then(|fp| fp.get("mid")));
            if let Some(at) = at.and_then(arr3) {
                self.missed = Some((kind, at.to_array()));
            }
        }
        None
    }

    fn part(&self, sel: &Selector) -> Option<Shape> {
        match sel.body().filter(|b| !b.is_empty()) {
            Some(b) => self.ctx.find_body(b).map(|i| self.ctx.bodies[i].shape().clone()),
            None => match self.ctx.shapes().as_slice() {
                [] => None,
                [one] => Some((*one).clone()),
                many => Some(kernel::compound(many.iter().copied())),
            },
        }
    }

    fn edge(&mut self, sel: &Selector) -> Option<Shape> {
        let found = self.part(sel).and_then(|part| {
            let v = serde_json::to_value(sel).ok()?;
            Resolver::new(Some(&mut self.notes), Some(self.id)).edges(&part, &v).ok()?.into_iter().next()
        });
        found.or_else(|| self.miss("edge", sel))
    }

    fn face(&mut self, sel: &Selector) -> Option<Shape> {
        let found = self.part(sel).and_then(|part| {
            let v = serde_json::to_value(sel).ok()?;
            Resolver::new(Some(&mut self.notes), Some(self.id)).faces(&part, &v).ok()?.into_iter().next()
        });
        found.or_else(|| self.miss("face", sel))
    }

    fn line(&mut self, sel: &Selector) -> Option<(DVec3, DVec3)> {
        let ent = EdgeEnt::new(self.edge(sel)?).ok()?;
        match unit(ent.dir()) {
            Some(d) if ent.curve == CurveType::Line => Some((ent.mid, d)),
            _ => self.miss("edge", sel),
        }
    }

    /// A datum named by id has to be above this feature, or it is refused
    /// like any other reference to a feature below.
    fn above(&self, name: &str, what: &str) -> FResult<()> {
        let at = |id: &str| self.ctx.timeline.iter().position(|s| s.id == id);
        match (at(name), at(self.id)) {
            (Some(k), Some(me)) if k < me => Ok(()),
            (_, None) => Ok(()),
            _ => Err(missing_reference(format!("{{\"{what}\": \"{name}\"}} names no datum above this one."))),
        }
    }

    /// A point on the plane and its unit normal.
    fn plane(&mut self, r: &PlaneOf) -> FResult<Option<(DVec3, DVec3)>> {
        Ok(match r {
            PlaneOf::Named { plane } => {
                if named(plane).is_none() {
                    self.above(plane, "plane")?;
                }
                plane_of(PlaneRef::Name(plane), &self.ctx.datums)
                    .ok()
                    .map(|f| (DVec3::from(f.origin), DVec3::from(f.z)))
            }
            PlaneOf::Face { face } => {
                let flat = self.face(face).and_then(|f| sa::face_probe(&f)).and_then(|probe| {
                    if probe.surface != SurfaceType::Plane {
                        return None;
                    }
                    Some((DVec3::from(probe.centre?), unit(DVec3::from(probe.normal?))?))
                });
                flat.or_else(|| self.miss("face", face))
            }
        })
    }

    fn point(&mut self, p: &PointAt) -> FResult<Option<DVec3>> {
        Ok(match p {
            PointAt::Datum { datum } => {
                self.above(datum, "datum")?;
                self.ctx
                .datum_marks
                .get(datum)
                .and_then(|m| m.get("position"))
                .and_then(arr3)
                .or_else(|| self.ctx.points.get(datum).map(|p| DVec3::from(*p)))
            }
            PointAt::Face { face } => self
                .face(face)
                .and_then(|f| sa::face_probe(&f))
                .and_then(|p| p.centre)
                .map(DVec3::from),
            PointAt::Edge { edge, end, t, point } => {
                let frac = match end.as_deref() {
                    Some("start") => 0.0,
                    Some("end") => 1.0,
                    Some("mid") => 0.5,
                    _ => self.ctx.val_or(t.as_ref(), 0.5)?,
                };
                let hint = point.as_ref().map(|p| DVec3::new(p[0].get(), p[1].get(), p[2].get()));
                self.edge(edge).and_then(|e| e.as_edge()).map(|e| {
                    let (a, b) = (e.position_at(frac), e.position_at(1.0 - frac));
                    match hint.map(|h| h + moved_by(&e, edge)) {
                        Some(h) if b.distance(h) < a.distance(h) => b,
                        _ => a,
                    }
                })
            }
        })
    }

}

type Lost = (Vec<Value>, Option<(&'static str, [f64; 3])>);

/// The diagnostics a lost reference leaves. A selector that gave nothing is
/// named the way the re-pick flow looks for it; otherwise one of its own when
/// the resolver said nothing, so the timeline always shows why it froze.
fn lost(ctx: &mut Ctx, id: &str, (mut notes, missed): Lost, what: &str) {
    match missed {
        Some((kind, at)) => ctx.diagnostics.push(serde_json::json!({
            "feature_id": id,
            "kind": kind,
            "resolved": 0,
            "confidence": 0.0,
            "lossy": true,
            "reason": format!("{what}: the {kind} it was made from no longer resolves, kept where it was. Re-pick the {kind}."),
            "at": at,
            "code": "referenceNotFound",
        })),
        None if notes.is_empty() => {
            ctx.advise(id, "referenceLost", format!("{what}: a reference no longer resolves, kept where it was"))
        }
        None => {}
    }
    ctx.diagnostics.append(&mut notes);
}

fn arr3(v: &Value) -> Option<DVec3> {
    let a = v.as_array()?;
    Some(DVec3::new(a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?))
}

fn rotate(v: DVec3, axis: DVec3, degrees: f64) -> DVec3 {
    DQuat::from_axis_angle(axis, degrees.to_radians()) * v
}

/// The plane through `point` with `normal`, turned to keep the cached x and
/// facing the cached side, so a rebuild never mirrors a sketch on it.
fn settle(origin: Option<DVec3>, point: DVec3, normal: DVec3, cached: &Frame) -> Option<Placement> {
    let mut p = plane_from_point_normal(point, normal)?;
    if let Some(o) = origin {
        p.origin = o.to_array();
    }
    Some(agree_with(with_x_dir(p, DVec3::from(cached.x)), DVec3::from(cached.z)))
}

/// `midPlane` in planeMath.ts: parallel planes give the plane halfway along
/// a's normal, crossing ones the bisector of their outward normals.
fn mid(a: (DVec3, DVec3), b: (DVec3, DVec3)) -> Option<(DVec3, DVec3)> {
    let ((oa, na), (ob, nb)) = (a, b);
    if na.dot(nb).abs() >= 0.999_999_6 {
        return Some((oa + na * (na.dot(ob - oa) / 2.0), na));
    }
    let n = unit(na - nb)?;
    let in_a = unit(nb - na * nb.dot(na))?;
    let t = nb.dot(ob - oa) / nb.dot(in_a);
    Some((oa + in_a * t, n))
}

/// The base plane `through` names now, `None` (with a diagnostic) to keep the cache.
pub fn plane_through(ctx: &mut Ctx, f: &DatumPlane, through: &PlaneThrough) -> FResult<Option<Placement>> {
    let cached = plane_of(PlaneRef::from(&f.plane), &ctx.datums)?;
    let t = ctx.val_or(f.t.as_ref(), 0.5)?;
    let angle = ctx.val_or(f.angle.as_ref(), 0.0)?;
    let mut look = Look::new(&*ctx, &f.id);
    let found = match through {
        PlaneThrough::Mid { a, b } => match (look.plane(a)?, look.plane(b)?) {
            (Some(a), Some(b)) => mid(a, b).and_then(|(p, n)| settle(None, p, n, &cached)),
            _ => None,
        },
        PlaneThrough::Points { points } => {
            let mut at = Vec::new();
            for p in points.iter().take(3) {
                at.extend(look.point(p)?);
            }
            match at.as_slice() {
                [a, b, c] => settle(None, *a, (*b - *a).cross(*c - *a), &cached),
                _ => None,
            }
        }
        PlaneThrough::NormalToEdge { edge, vertex } => {
            let at = match vertex {
                Some(v) => look.point(v)?,
                None => None,
            };
            match look.edge(edge).and_then(|e| e.as_edge()) {
                Some(e) => {
                    // The cached normal is the path's tangent where the plane
                    // was made, in the direction it was drawn, so the edge's
                    // tangent there says which end t counts from.
                    let made_at = nearest_fraction(&e, DVec3::from(cached.origin) + moved_by(&e, edge));
                    let frac = match at {
                        Some(p) => nearest_fraction(&e, p),
                        None if e.tangent_at(made_at).dot(DVec3::from(cached.z)) < 0.0 => 1.0 - t,
                        None => t,
                    };
                    if vertex.is_some() && at.is_none() {
                        None
                    } else {
                        let p = e.position_at(frac);
                        settle(Some(p), p, e.tangent_at(frac), &cached)
                    }
                }
                None => None,
            }
        }
        PlaneThrough::TwoEdges { a, b } => match (look.line(a), look.line(b)) {
            (Some((ma, da)), Some((mb, db))) => {
                let n = if da.cross(db).length() < TOL {
                    da.cross(mb - ma)
                } else {
                    let n = da.cross(db);
                    if (mb - ma).dot(n.normalize()).abs() > TOL * (1.0 + (mb - ma).length()) {
                        DVec3::ZERO
                    } else {
                        n
                    }
                };
                settle(Some(ma), ma, n, &cached)
            }
            _ => None,
        },
        PlaneThrough::Angle { edge, from } => match (look.line(edge), look.plane(from)?) {
            (Some((o, d)), Some((_, nr))) => {
                unit(nr - d * d.dot(nr)).and_then(|np| settle(Some(o), o, rotate(np, d, angle), &cached))
            }
            _ => None,
        },
    };
    if found.is_none() {
        lost(ctx, &f.id, look.done(), "Plane");
    }
    Ok(found)
}

/// How far the edge's middle has moved since its fingerprint was taken, so a
/// point recorded then can be compared with the edge where it is now.
fn moved_by(e: &opencascade::primitives::Edge, sel: &Selector) -> DVec3 {
    fp_vec(sel, "mid").map_or(DVec3::ZERO, |mid| e.position_at(0.5) - mid)
}

fn fp_vec(sel: &Selector, key: &str) -> Option<DVec3> {
    serde_json::to_value(sel).ok()?.get("fp")?.get(key).and_then(arr3)
}

fn nearest_fraction(e: &opencascade::primitives::Edge, p: DVec3) -> f64 {
    let d = |s: f64| e.position_at(s).distance(p);
    let mut best = (0..=64).map(|i| f64::from(i) / 64.0).min_by(|a, b| d(*a).total_cmp(&d(*b))).unwrap_or(0.0);
    let mut step = 1.0 / 64.0;
    for _ in 0..20 {
        step /= 2.0;
        for c in [best - step, best + step] {
            if (0.0..=1.0).contains(&c) && d(c) < d(best) {
                best = c;
            }
        }
    }
    best
}

/// A datum point's `at`, published as a point mark that extents and the
/// viewport read ahead of the cached `point`.
pub fn datum_point(ctx: &mut Ctx, f: &DatumPoint) -> FResult {
    let Some(at) = &f.at else { return Ok(()) };
    let mut look = Look::new(&*ctx, &f.id);
    match look.point(at)? {
        Some(p) => {
            ctx.datum_marks.insert(f.id.clone(), serde_json::json!({"kind": "point", "position": p.to_array()}));
        }
        None => {
            lost(ctx, &f.id, look.done(), "Point");
        }
    }
    Ok(())
}

/// A datum axis's `through` as a line, `None` (with a diagnostic) to keep the cache.
pub fn axis_through(ctx: &mut Ctx, f: &DatumAxis, through: &AxisThrough) -> FResult<Option<(DVec3, DVec3)>> {
    let mut look = Look::new(&*ctx, &f.id);
    let found = match through {
        AxisThrough::Points { a, b } => match (look.point(a)?, look.point(b)?) {
            (Some(a), Some(b)) => unit(b - a).map(|d| (a, d)),
            _ => None,
        },
        AxisThrough::Cylinder { face } => look.face(face).and_then(|s| cylinder_axis(&s)).map(|(o, d, _)| (o, d)),
        AxisThrough::Planes { a, b } => match (look.plane(a)?, look.plane(b)?) {
            (Some((oa, na)), Some((ob, nb))) => {
                let u = na.cross(nb);
                (u.length() >= TOL).then(|| {
                    let (da, db) = (na.dot(oa), nb.dot(ob));
                    ((nb.cross(u) * da + u.cross(na) * db) / u.length_squared(), u.normalize())
                })
            }
            _ => None,
        },
    };
    let cached = DVec3::new(f.dir[0].get(), f.dir[1].get(), f.dir[2].get());
    match found {
        Some((o, d)) => Ok(Some((o, if d.dot(cached) < 0.0 { -d } else { d }))),
        None => {
            lost(ctx, &f.id, look.done(), "Axis");
            Ok(None)
        }
    }
}

#[cfg(test)]
#[path = "datum_refs_tests.rs"]
mod tests;
