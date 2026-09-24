//! Press/pull along an axis: the face swept along the line its walls run
//! along, so a hole's wall lengthens and its end keeps its shape. Offsetting a
//! drilled hole's cone ceiling along its normal widens the cone instead, until
//! it breaks out of a thin wall.

use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use glam::{dvec3, DVec3};
use opencascade::primitives::Shape;
use opencascade::query::PointState;
use opencascade_sys::face_query as fq;
use serde_json::{json, Map, Value};

use crate::builder::{FResult, Fail, Watch};
use crate::kernel::{self, BoolKind};
use crate::select::entity::{py_round, FaceEnt};
use crate::select::Resolver;
use crate::topo::FaceAdjacency;

/// Sine of the largest angle between two directions still called parallel.
const PARALLEL: f64 = 1e-5;
/// How far off the axis line a coaxial surface's own axis may sit, mm.
const ON_AXIS: f64 = 1e-4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoleAxis {
    /// Unit, on the side the face's outward normal points to.
    pub dir: DVec3,
    /// A point on the axis.
    pub origin: DVec3,
    /// A round face on the same axis as round walls with material outside
    /// them: the cone, cap or dome at the end of a drilled hole.
    pub hole: bool,
}

enum Surf {
    Plane(DVec3),
    Cylinder(DVec3, DVec3),
    Cone(DVec3, DVec3),
    Sphere(DVec3),
    Revolution(DVec3, DVec3),
    Other,
}

fn surf(face: &Shape) -> Surf {
    let mut o = [0.0; 13];
    let Ok(kind) = fq::FQ_surface(face.raw(), &mut o) else {
        return Surf::Other;
    };
    let dir = dvec3(o[1], o[2], o[3]);
    let loc = dvec3(o[4], o[5], o[6]);
    match kind {
        0 => Surf::Plane(dir),
        1 => Surf::Cylinder(dir, loc),
        2 => Surf::Cone(dir, dvec3(o[9], o[10], o[11])),
        3 => Surf::Sphere(loc),
        4 | 5 => Surf::Revolution(dir, loc),
        _ => Surf::Other,
    }
}

fn parallel(a: DVec3, b: DVec3) -> bool {
    a.normalize_or_zero().cross(b.normalize_or_zero()).length() < PARALLEL
}

/// Sweeping along `d` keeps a point of this surface on it.
fn runs_along(s: &Surf, d: DVec3) -> bool {
    match s {
        Surf::Plane(n) => n.normalize_or_zero().dot(d).abs() < PARALLEL,
        Surf::Cylinder(a, _) => parallel(*a, d),
        _ => false,
    }
}

fn off_line(p: DVec3, origin: DVec3, dir: DVec3) -> f64 {
    let r = p - origin;
    (r - dir * r.dot(dir)).length()
}

fn centroid(face: &Shape) -> DVec3 {
    FaceEnt::new(face.clone()).map_or(DVec3::ZERO, |f| f.centroid())
}

/// +1 or -1 for the side of `d` the face looks to, read over a grid of points
/// inside it; an error when it looks sideways or both ways.
fn facing(face: &Shape, d: DVec3) -> Result<f64, &'static str> {
    const SIDEWAYS: &str = "the face runs along the axis, so moving it along the axis changes nothing";
    const FOLDS: &str = "the face turns back on itself along the axis, so it has no single side to move to";
    let f = face.as_face().ok_or(SIDEWAYS)?;
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    if let Ok(b) = f.uv_bounds() {
        const N: i32 = 7;
        for i in 0..N {
            for j in 0..N {
                let u = b.u_min + (f64::from(i) + 0.5) / f64::from(N) * (b.u_max - b.u_min);
                let v = b.v_min + (f64::from(j) + 0.5) / f64::from(N) * (b.v_max - b.v_min);
                if f.classify_uv(u, v, 1e-7).ok() != Some(PointState::In) {
                    continue;
                }
                let Ok((_, n)) = f.point_and_normal(u, v) else { continue };
                let Some(n) = n.try_normalize() else { continue };
                let k = n.dot(d);
                lo = lo.min(k);
                hi = hi.max(k);
            }
        }
    }
    if lo > hi {
        let k = kernel::face_normal_mid(face).map_or(0.0, |n| DVec3::from_array(n).dot(d));
        (lo, hi) = (k, k);
    }
    match (lo, hi) {
        (lo, hi) if hi > 1e-3 && lo > -1e-6 => Ok(1.0),
        (lo, hi) if lo < -1e-3 && hi < 1e-6 => Ok(-1.0),
        (lo, hi) if lo.abs() <= 1e-3 && hi.abs() <= 1e-3 => Err(SIDEWAYS),
        _ => Err(FOLDS),
    }
}

/// The wall's material lies outside its cylinder: it bounds a bore, not a pin.
fn bore(wall: &Shape, origin: DVec3, dir: DVec3) -> bool {
    let mut o = [0.0; 6];
    if fq::FQ_mid_normal(wall.raw(), &mut o).is_err() {
        return false;
    }
    let (p, n) = (dvec3(o[0], o[1], o[2]), dvec3(o[3], o[4], o[5]));
    let r = p - origin;
    (r - dir * r.dot(dir)).dot(n) < 0.0
}

/// The axis `face` moves along, or why it has none. Every face sharing an
/// edge with it has to be a wall that runs along one line, a cylinder parallel
/// to it or a plane containing it, so sweeping the face keeps each wall on its
/// own surface. The line is a round wall's axis, else the face's own axis (a
/// cone, torus or surface of revolution), else where two flat walls meet.
pub fn hole_axis(body: &Shape, face: &Shape) -> Result<HoleAxis, &'static str> {
    let adj = FaceAdjacency::new(body);
    let i = adj.index_of(face);
    if i == 0 {
        return Err("the face is not on this body");
    }
    let walls: Vec<Shape> = adj.neighbors(i).into_iter().map(|j| adj.face(j)).collect();
    if walls.is_empty() {
        return Err("the face has no walls around it to run along");
    }
    let wall_surfs: Vec<Surf> = walls.iter().map(surf).collect();
    let own = surf(face);
    let middle = centroid(face);
    let mut candidates: Vec<(DVec3, DVec3)> = wall_surfs
        .iter()
        .filter_map(|s| match s {
            Surf::Cylinder(d, loc) => Some((*d, *loc)),
            _ => None,
        })
        .collect();
    match own {
        Surf::Cone(d, apex) => candidates.push((d, apex)),
        Surf::Revolution(d, loc) => candidates.push((d, loc)),
        _ => {}
    }
    let flats: Vec<DVec3> = wall_surfs
        .iter()
        .filter_map(|s| match s {
            Surf::Plane(n) => Some(*n),
            _ => None,
        })
        .collect();
    if let Some(d) = flats
        .iter()
        .enumerate()
        .flat_map(|(k, a)| flats[k + 1..].iter().map(move |b| a.cross(*b)))
        .find(|c| c.length() > 1e-3)
    {
        candidates.push((d, middle));
    }
    if let Surf::Plane(n) = own {
        candidates.push((n, middle));
    }
    let (dir, origin) = candidates
        .into_iter()
        .map(|(d, o)| (d.normalize_or_zero(), o))
        .find(|(d, _)| *d != DVec3::ZERO && wall_surfs.iter().all(|s| runs_along(s, *d)))
        .ok_or("the walls around the face do not all run along one axis")?;
    let dir = dir * facing(face, dir)?;
    let on_line = |p: DVec3| off_line(p, origin, dir) < ON_AXIS;
    let round = match own {
        Surf::Cone(d, apex) => parallel(d, dir) && on_line(apex),
        Surf::Revolution(d, loc) => parallel(d, dir) && on_line(loc),
        Surf::Sphere(c) => on_line(c),
        _ => false,
    };
    let hole = round
        && walls.iter().zip(&wall_surfs).all(|(w, s)| match s {
            Surf::Cylinder(_, loc) => on_line(*loc) && bore(w, origin, dir),
            _ => false,
        });
    Ok(HoleAxis { dir, origin, hole })
}

fn refusal(why: &str) -> Fail {
    Fail::msg(format!("Press/Pull along the axis: {why}"))
}

/// `hole_axis`, refused as a feature error.
pub fn axis_of(body: &Shape, face: &Shape) -> FResult<HoleAxis> {
    hole_axis(body, face).map_err(refusal)
}

/// The face swept `d` along its axis, outward positive.
pub fn axis_prism(body: &Shape, face: &Shape, d: f64) -> FResult<Shape> {
    let axis = axis_of(body, face)?;
    let v = axis.dir * d;
    // Swept against its outward normal, a cone ceiling cuts a wall the unify
    // pass leaves as two faces, so an inward push sweeps the moved face back.
    let swept = if d < 0.0 {
        kernel::translated(face, v.to_array()).and_then(|moved| kernel::prism(&moved, (-v).to_array()))
    } else {
        kernel::prism(face, v.to_array())
    };
    let prism = swept.map_err(|_| refusal("the face does not sweep into a valid solid"))?;
    if !prism.is_valid().unwrap_or(false) {
        return Err(refusal("the face does not sweep into a valid solid"));
    }
    Ok(prism)
}

/// The face moved `d` along its axis: the sweep joined on outward, cut inward.
pub fn push_along_axis(part: &Shape, face: &Shape, d: f64) -> FResult<Shape> {
    if d.abs() < 1e-9 {
        return Ok(part.clone());
    }
    let prism = axis_prism(part, face, d)?;
    let kind = if d > 0.0 { BoolKind::Fuse } else { BoolKind::Cut };
    let out = kernel::boolean_op(part, &[&prism], kind)?;
    let (before, after) = (kernel::volume(part), kernel::volume(&out));
    if !out.is_valid().unwrap_or(false) || after <= 0.0 || (after > before) != (d > 0.0) {
        return Err(refusal("the kernel could not move the face that far"));
    }
    Ok(out)
}

fn r6(v: DVec3) -> Value {
    json!(v.to_array().map(|x| py_round(x, 6)))
}

/// The `faceAxis` op: the axis press/pull would move `face` of `body` along,
/// `{axis: {origin, dir}, hole, sameAsNormal}`, or `{reason}` when it has none.
pub fn face_axis_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let (_, built) = match crate::inspect::rebuild_request(req, watch) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Some(sel) = req.get("face") else {
        return error_result("'face'");
    };
    let wanted = req
        .get("body")
        .and_then(Value::as_str)
        .or_else(|| sel.get("body").and_then(Value::as_str));
    let found = built
        .bodies
        .iter()
        .filter(|b| wanted.map_or(true, |id| b.id == id))
        .find_map(|b| {
            let face = Resolver::new(None, None).faces(&b.shape, sel).ok()?.into_iter().next()?;
            Some((b, face))
        });
    let reply = match found {
        None => json!({"reason": "the face was not found"}),
        Some((body, face)) => match hole_axis(&body.shape, &face) {
            Ok(a) => {
                let same = matches!(surf(&face), Surf::Plane(n) if parallel(n, a.dir));
                json!({"axis": {"origin": r6(a.origin), "dir": r6(a.dir)}, "hole": a.hole, "sameAsNormal": same})
            }
            Err(why) => json!({"reason": why}),
        },
    };
    JobResult::Json(reply.as_object().cloned().unwrap_or_default())
}
