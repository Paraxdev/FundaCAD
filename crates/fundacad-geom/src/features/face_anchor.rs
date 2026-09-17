//! A sketch or datum plane following the face it was made on, sidecar/builder.py
//! `_face_anchor_plane` and `_nearest_cylinder_face` over sidecar/face_plane.py.

use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, ItemKind};
use opencascade_sys::sketch_ops as ffi;
use serde_json::{json, Value};

use fundacad_core::schema::{PlaneSpec, Selector, Vec3};

use crate::builder::{Ctx, PlaneRecord};
use crate::kernel;
use crate::select::Resolver;

const EPS: f64 = 1e-9;
const Z_REF_LIMIT: f64 = 0.9;

/// Note: off to match the Python engine, whose cylinder arm calls a build123d
/// `Face._geom_adaptor` that no longer exists, so a tangent datum always falls
/// back to its cache there. Turn on together with that fix.
const CYLINDER_ARM: bool = false;

/// The `{origin, normal, xdir}` a followed plane resolves to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub origin: [f64; 3],
    pub normal: [f64; 3],
    pub xdir: [f64; 3],
}

impl Placement {
    pub fn record(&self) -> PlaneRecord {
        PlaneRecord {
            origin: self.origin,
            xdir: self.xdir,
            normal: self.normal,
        }
    }

    pub fn wire(&self) -> Value {
        json!({"origin": self.origin, "normal": self.normal, "xdir": self.xdir})
    }
}

fn unit(v: DVec3) -> Option<DVec3> {
    let n = v.length();
    (n >= EPS).then(|| v / n)
}

fn plane_x_dir(n: DVec3) -> Option<DVec3> {
    let r = if n.z.abs() < Z_REF_LIMIT {
        DVec3::Z
    } else {
        DVec3::X
    };
    unit(r - n * r.dot(n))
}

fn plane_from_point_normal(point: DVec3, normal: DVec3) -> Option<Placement> {
    let n = unit(normal)?;
    let x = plane_x_dir(n)?;
    Some(Placement {
        origin: (n * n.dot(point)).to_array(),
        normal: n.to_array(),
        xdir: x.to_array(),
    })
}

fn with_x_dir(p: Placement, hint: DVec3) -> Placement {
    let Some(n) = unit(DVec3::from_array(p.normal)) else {
        return p;
    };
    match unit(hint - n * n.dot(hint)) {
        Some(x) => Placement {
            origin: p.origin,
            normal: n.to_array(),
            xdir: x.to_array(),
        },
        None => p,
    }
}

fn agree_with(p: Placement, reference: DVec3) -> Placement {
    let (Some(r), Some(n)) = (unit(reference), unit(DVec3::from_array(p.normal))) else {
        return p;
    };
    if n.dot(r) >= 0.0 {
        return p;
    }
    Placement {
        origin: p.origin,
        normal: (-n).to_array(),
        xdir: p.xdir,
    }
}

fn tangent_plane_on_cylinder(
    axis_point: DVec3,
    axis_dir: DVec3,
    radius: f64,
    at: DVec3,
) -> Option<Placement> {
    let ax = unit(axis_dir)?;
    let rel = at - axis_point;
    let along = rel.dot(ax);
    let radial = unit(rel - ax * along)?;
    let touch = axis_point + ax * along + radial * radius;
    Some(Placement {
        origin: touch.to_array(),
        normal: radial.to_array(),
        xdir: ax.to_array(),
    })
}

fn v3(v: &Vec3) -> DVec3 {
    DVec3::new(v[0].get(), v[1].get(), v[2].get())
}

fn nearest_cylinder_face(part: &Shape, sel: &Value) -> Option<Shape> {
    let pt = sel
        .as_object()
        .and_then(|m| m.get("point"))
        .and_then(Value::as_array)
        .filter(|a| a.len() <= 3)
        .and_then(|a| {
            let mut out = [0.0; 3];
            for (slot, x) in out.iter_mut().zip(a) {
                *slot = x.as_f64()?;
            }
            Some(out)
        });
    let mut best: Option<(f64, Shape)> = None;
    for face in sa::items(part, ItemKind::Face) {
        let Some(probe) = sa::face_probe(&face) else {
            continue;
        };
        if probe.surface != sa::SurfaceType::Cylinder {
            continue;
        }
        let d = pt
            .and_then(|p| kernel::distance_to_point(&face, p))
            .unwrap_or(0.0);
        if best.as_ref().map_or(true, |(b, _)| d < *b) {
            best = Some((d, face));
        }
    }
    best.map(|b| b.1)
}

fn cylinder_axis(face: &Shape) -> Option<(DVec3, DVec3, f64)> {
    let mut o = [0.0; 7];
    match ffi::sk_cylinder_axis(face.raw(), &mut o) {
        Ok(true) => Some((
            DVec3::new(o[0], o[1], o[2]),
            DVec3::new(o[3], o[4], o[5]),
            o[6],
        )),
        _ => None,
    }
}

/// The plane of the face `face` names, re-resolved against the bodies now, or
/// `None` to keep the cached `plane`. A face that stopped resolving is never an
/// error, only a diagnostic.
pub fn face_anchor_plane(
    ctx: &mut Ctx,
    id: &str,
    face: Option<&Selector>,
    at: Option<&Vec3>,
    plane: &PlaneSpec,
    label: &str,
) -> Option<Placement> {
    let sel = face?;
    let PlaneSpec::Def(cached) = plane else {
        return None;
    };
    let sel = serde_json::to_value(sel).ok()?;
    if sel.is_null() || sel.as_object().is_some_and(serde_json::Map::is_empty) {
        return None;
    }
    let shapes = ctx.shapes();
    if shapes.is_empty() {
        return None;
    }
    let part = if shapes.len() == 1 {
        shapes[0].clone()
    } else {
        kernel::compound(shapes.iter().copied())
    };
    let cached_normal = v3(&cached.normal);
    let mut scratch = Vec::new();
    let found = Resolver::new(Some(&mut scratch), Some(id)).face_on_plane(
        Some(&part),
        &sel,
        cached_normal.to_array(),
        label,
    );
    if let Some(f) = found {
        let probe = sa::face_probe(&f);
        let centre = probe.and_then(|p| p.centre).map(DVec3::from_array)?;
        let normal = probe
            .and_then(|p| p.normal)
            .map_or(DVec3::ZERO, DVec3::from_array);
        let p = plane_from_point_normal(centre, normal)?;
        let p = with_x_dir(p, v3(&cached.xdir));
        return Some(agree_with(p, cached_normal));
    }
    if let Some(at) = at.filter(|_| CYLINDER_ARM) {
        if let Some(cyl) = nearest_cylinder_face(&part, &sel) {
            if let Some((loc, dir, r)) = cylinder_axis(&cyl) {
                if let Some(p) = tangent_plane_on_cylinder(loc, dir, r, v3(at)) {
                    return Some(agree_with(p, cached_normal));
                }
            }
        }
    }
    ctx.diagnostics.extend(scratch);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_origin_is_the_world_origin_projected() {
        let p = plane_from_point_normal(DVec3::new(3.0, 2.0, 10.0), DVec3::Z).unwrap();
        assert_eq!(p.origin, [0.0, 0.0, 10.0]);
        assert_eq!(p.xdir, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn a_flipped_face_keeps_the_accepted_direction() {
        let p = plane_from_point_normal(DVec3::new(0.0, 0.0, 5.0), -DVec3::Z).unwrap();
        let q = agree_with(p, DVec3::Z);
        assert_eq!(q.normal, [0.0, 0.0, 1.0]);
    }
}
