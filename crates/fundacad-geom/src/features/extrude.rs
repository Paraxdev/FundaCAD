//! Extrude, the Python engine's `builder.py` `_handle_extrude` with build123d's `extrude`
//! and `Solid.extrude_taper`.

use std::collections::HashSet;

use fundacad_core::schema::{Extrude, Num, PointRef, Selector};
use glam::{dvec3, DVec3};
use opencascade::primitives::Shape;

use super::combine;
use super::extent;
use super::sketch::{frame_for_normal, region_target, require};
use crate::builder::{py_g, Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind, Kind};

/// How far one side of an extrude travels.
#[derive(Clone, Copy)]
pub enum Amount {
    /// Along each profile face's own normal.
    AlongFace(f64),
    /// Along this axis whichever way a face points.
    AlongAxis(f64, [f64; 3]),
}

#[derive(Clone, Copy)]
pub struct Side {
    pub amount: Amount,
    pub taper: f64,
}

/// build123d `extrude(target, amount, both, taper)`: every planar face along
/// its own normal, both ways when symmetric, each result cleaned.
pub fn prisms(target: &Shape, amount: f64, both: bool, taper: f64) -> FResult<Shape> {
    let one = Side { amount: Amount::AlongFace(amount), taper };
    let other = Side { amount: Amount::AlongFace(-amount), taper };
    if both {
        prisms_sided(target, &[one, other])
    } else {
        prisms_sided(target, &[one])
    }
}

/// [`prisms`] with each side's own amount and taper, the sides fused.
pub fn prisms_sided(target: &Shape, sides: &[Side]) -> FResult<Shape> {
    let faces = kernel::subshapes(target, Kind::Face);
    let mut solids: Vec<Shape> = Vec::new();
    for face in &faces {
        if !kernel::face_is_planar(face) {
            return Err(Fail::msg("dir must be provided when extruding non-planar faces"));
        }
        let Some(n) = kernel::face_plane_normal(face) else {
            return Err(Fail::msg("dir must be provided when extruding non-planar faces"));
        };
        for side in sides {
            let taper = side.taper;
            let s = match side.amount {
                Amount::AlongFace(a) => a,
                Amount::AlongAxis(a, ax) => {
                    if n[0] * ax[0] + n[1] * ax[1] + n[2] * ax[2] < 0.0 {
                        -a
                    } else {
                        a
                    }
                }
            };
            let d = [n[0] * s, n[1] * s, n[2] * s];
            let solid = if taper == 0.0 {
                kernel::prism(face, d)?
            } else {
                let normal_mid = kernel::face_normal_mid(face).unwrap_or(n);
                let len = s.abs();
                let unit = [d[0] / len, d[1] / len, d[2] / len];
                let aligned = (0..3).all(|k| (unit[k] - normal_mid[k]).abs() <= 1e-6);
                let dprism = aligned && n[2] > 0.0 && taper > 0.0 && !kernel::face_has_holes(face);
                let origin = kernel::face_area_centre(face).map_or([0.0; 3], |a| [a[1], a[2], a[3]]);
                kernel::prism_taper(face, d, taper, &frame_for_normal(origin, n), dprism)?
            };
            solids.push(solid);
        }
    }
    if sides.len() > 1 && solids.len() > 1 {
        let last = solids.pop().ok_or_else(|| Fail::Internal("IndexError".into()))?;
        let tools: Vec<&Shape> = solids.iter().collect();
        let fused = kernel::boolean_op(&last, &tools, BoolKind::Fuse)?;
        solids = if kernel::shape_type(&fused) == Some(kernel::ShapeType::Compound) {
            kernel::children(&fused)
        } else {
            vec![fused]
        };
    }
    let mut out: Vec<Shape> = Vec::new();
    for s in &solids {
        let cleaned = kernel::clean(s)?;
        out.extend(kernel::subshapes(&cleaned, Kind::Solid));
    }
    Ok(kernel::compound(&out))
}

fn checked_taper(ctx: &Ctx, n: Option<&Num>) -> FResult<f64> {
    let taper = ctx.val_or(n, 0.0)?;
    if taper != 0.0 && !(-89.0 < taper && taper < 89.0) {
        return Err(Fail::msg(format!("Extrude: taper must be between -89 and 89 degrees (got {})", py_g(taper))));
    }
    Ok(taper)
}

/// One side's end target, as the fields name it.
struct End<'a> {
    kind: Option<&'a str>,
    face: Option<&'a Selector>,
    plane: Option<&'a str>,
    point: Option<&'a PointRef>,
    offset: Option<&'a Num>,
}

impl End<'_> {
    fn kind(&self) -> &str {
        self.kind.filter(|k| !k.is_empty()).unwrap_or("distance")
    }
}

/// How far the farthest corner of the target bodies lies from `o` along `dir`.
fn reach(ctx: &Ctx, f: &Extrude, o: DVec3, dir: DVec3) -> f64 {
    let wanted: Option<HashSet<&str>> = f.targets.as_ref().map(|t| t.iter().map(String::as_str).collect());
    ctx.bodies
        .iter()
        .filter(|b| wanted.as_ref().map_or(true, |w| w.contains(b.id.as_str())))
        .filter_map(|b| kernel::bbox(b.shape()))
        .flat_map(|b| {
            (0..8usize).map(move |i| dvec3(b[(i & 1) * 3], b[1 + ((i >> 1) & 1) * 3], b[2 + ((i >> 2) & 1) * 3]))
        })
        .map(|c| (c - o).dot(dir))
        .fold(f64::NEG_INFINITY, f64::max)
}

/// A distance along the faces, or the travel from `o` along `n` to a target.
/// `way` is the side's direction along `n` when `distance` gives none.
fn end(ctx: &mut Ctx, f: &Extrude, e: End<'_>, distance: f64, way: f64, o: DVec3, n: DVec3) -> FResult<Amount> {
    let axis = n.to_array();
    let way = if distance != 0.0 { distance.signum() } else { way };
    let kind = e.kind();
    let raw = match kind {
        "distance" => {
            if distance == 0.0 {
                return Err(Fail::msg("Extrude: distance must not be 0"));
            }
            return Ok(Amount::AlongFace(distance));
        }
        "throughAll" => {
            let r = reach(ctx, f, o, n * way);
            if r <= 0.0 {
                return Err(Fail::msg("Extrude: through all finds no body ahead of the start to go through"));
            }
            return Ok(Amount::AlongAxis(way * (r + 1.0), axis));
        }
        "upToFace" | "upToPlane" => {
            let (p, m) = if kind == "upToFace" {
                let sel = e.face.ok_or_else(|| Fail::msg("Extrude: up to face needs a face"))?;
                let fallback = ctx.bodies.len().checked_sub(1);
                let shape = extent::face(ctx, &f.id, "Extrude", sel, fallback)?;
                extent::flat_face_plane(&shape, "Extrude")?
            } else {
                let name = e.plane.ok_or_else(|| Fail::msg("Extrude: up to plane needs a plane"))?;
                extent::datum_plane(ctx, name)?
            };
            let denom = n.dot(m);
            if denom.abs() < 1e-6 {
                return Err(Fail::msg(
                    "Extrude: the up to target runs along the extrude direction, it is never reached",
                ));
            }
            if denom.abs() < 1.0 - 1e-6 {
                return Err(Fail::msg("Extrude: the up to target must be parallel to the sketch for now"));
            }
            (p - o).dot(m) / denom
        }
        "upToPoint" => {
            let pr = e.point.ok_or_else(|| Fail::msg("Extrude: up to point needs a point"))?;
            (extent::point(ctx, "Extrude", pr)? - o).dot(n)
        }
        other => return Err(Fail::msg(format!("Extrude: unknown end type {other}"))),
    };
    let off = ctx.val_or(e.offset, 0.0)?;
    if raw.abs() < 1e-9 && off <= 0.0 {
        return Err(Fail::msg("Extrude: the up to target lies on the start, there is nothing to extrude"));
    }
    let toward = if raw.abs() < 1e-9 { way } else { raw.signum() };
    let a = raw + toward * off;
    if a * toward < 1e-9 {
        return Err(Fail::msg("Extrude: the end offset reaches back past the start"));
    }
    Ok(Amount::AlongAxis(a, axis))
}

/// Where the profile starts, and each side's end and taper.
fn extents(ctx: &mut Ctx, f: &Extrude, target: Shape, plane: &kernel::Frame) -> FResult<(Shape, Vec<Side>)> {
    let n = dvec3(plane.z[0], plane.z[1], plane.z[2]).normalize_or_zero();
    let o = dvec3(plane.origin[0], plane.origin[1], plane.origin[2]);
    let parallel = |m: DVec3| -> FResult<()> {
        if n.dot(m).abs() < 1.0 - 1e-6 {
            return Err(Fail::msg("Extrude: the start target must be parallel to the sketch"));
        }
        Ok(())
    };
    let start = match f.start_type.as_deref().filter(|k| !k.is_empty()).unwrap_or("sketch") {
        "sketch" | "offset" => 0.0,
        "face" => {
            let sel = f.start_face.as_ref().ok_or_else(|| Fail::msg("Extrude: start at a face needs a face"))?;
            let fallback = ctx.bodies.len().checked_sub(1);
            let shape = extent::face(ctx, &f.id, "Extrude", sel, fallback)?;
            let (p, m) = extent::flat_face_plane(&shape, "Extrude")?;
            parallel(m)?;
            (p - o).dot(n)
        }
        "plane" => {
            let name = f.start_plane.as_deref().ok_or_else(|| Fail::msg("Extrude: start at a plane needs a plane"))?;
            let (p, m) = extent::datum_plane(ctx, name)?;
            parallel(m)?;
            (p - o).dot(n)
        }
        "point" => {
            let pr = f.start_point.as_ref().ok_or_else(|| Fail::msg("Extrude: start at a point needs a point"))?;
            (extent::point(ctx, "Extrude", pr)? - o).dot(n)
        }
        other => return Err(Fail::msg(format!("Extrude: unknown start type {other}"))),
    } + ctx.val_or(f.start_offset.as_ref(), 0.0)?;
    let target = if start == 0.0 { target } else { kernel::translated(&target, (n * start).to_array())? };
    let o = o + n * start;
    let both = f.symmetric.unwrap_or(false);
    let two = f.two_sided.unwrap_or(false);
    if both && two {
        return Err(Fail::msg("Extrude: symmetric and two sided cannot both be on"));
    }
    let distance = ctx.val(&f.distance)?;
    let first_end = End {
        kind: f.end_type.as_deref(),
        face: f.up_to_face.as_ref(),
        plane: f.up_to_plane.as_deref(),
        point: f.up_to_point.as_ref(),
        offset: f.end_offset.as_ref(),
    };
    let taper = checked_taper(ctx, f.taper.as_ref())?;
    if both && first_end.kind() == "throughAll" {
        let way = if distance < 0.0 { -1.0 } else { 1.0 };
        let sides: Vec<Side> = [way, -way]
            .into_iter()
            .map(|w| (w, reach(ctx, f, o, n * w)))
            .filter(|(_, r)| *r > 0.0)
            .map(|(w, r)| Side { amount: Amount::AlongAxis(w * (r + 1.0), n.to_array()), taper })
            .collect();
        if sides.is_empty() {
            return Err(Fail::msg("Extrude: through all finds no body on either side of the start to go through"));
        }
        return Ok((target, sides));
    }
    let first = Side { amount: end(ctx, f, first_end, distance, 1.0, o, n)?, taper };
    let mut sides = vec![first];
    if both {
        let amount = match first.amount {
            Amount::AlongFace(a) => Amount::AlongFace(-a),
            Amount::AlongAxis(a, ax) => Amount::AlongAxis(-a, ax),
        };
        sides.push(Side { amount, taper: first.taper });
    } else if two {
        let distance2 = ctx.val_or(f.distance2.as_ref(), 0.0)?;
        let second_end = End {
            kind: f.end_type2.as_deref(),
            face: f.up_to_face2.as_ref(),
            plane: f.up_to_plane2.as_deref(),
            point: f.up_to_point2.as_ref(),
            offset: f.end_offset2.as_ref(),
        };
        let amount = end(ctx, f, second_end, -distance2, -1.0, o, n)?;
        sides.push(Side { amount, taper: checked_taper(ctx, f.taper2.as_ref())? });
    }
    Ok((target, sides))
}

pub fn handle(ctx: &mut Ctx, f: &Extrude) -> FResult {
    let entry = require(ctx, &f.sketch, "extrude")?;
    if f.thin == Some(true) {
        let target = super::thin::wall_faces(ctx, f, entry)?;
        let plane = entry.plane;
        return push(ctx, f, target, &plane);
    }
    let Some(sk) = entry.sketch.clone() else {
        return Err(Fail::msg("sketch has no closed profile to extrude"));
    };
    let mut pts: Vec<[f64; 3]> = f.regions.iter().flatten().map(|p| [p[0].get(), p[1].get(), p[2].get()]).collect();
    if pts.is_empty() {
        if let Some(p) = &f.region {
            pts.push([p[0].get(), p[1].get(), p[2].get()]);
        }
    }
    let target = region_target(ctx, &pts, entry)?.unwrap_or(sk);
    let plane = entry.plane;
    push(ctx, f, target, &plane)
}

fn push(ctx: &mut Ctx, f: &Extrude, target: Shape, plane: &kernel::Frame) -> FResult {
    let (target, sides) = extents(ctx, f, target, plane)?;
    let solid = crate::bench::phase("prisms", || prisms_sided(&target, &sides))?;
    let hidden: Option<HashSet<String>> = f.hidden_bodies.as_ref().map(|h| h.iter().cloned().collect());
    combine(ctx, &f.id, solid, Some(&f.operation), f.targets.as_deref(), hidden, None)
}
