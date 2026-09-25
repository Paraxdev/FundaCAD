//! `by:"tracked"`: a flat face kept by its outward normal, found again however
//! far a change upstream moves it.
//!
//! The pick point is carried onto each flat face still facing the stored way
//! as if that face were the one moved, and only a face the carried point lands
//! on can be it. Of those, a face still under the pick point itself is
//! preferred over one that is not, then whichever carried the point least far.
//! A tie is refused, never guessed.
//!
//! How a point is carried: with an `extent`, each in-plane coordinate keeps its
//! offset from whichever of that axis's min, middle or max it was nearest when
//! written, so a hole by a corner stays by that corner as the face grows and a
//! centred one stays centred. A face whose outline is a circle, and was a
//! circle when written (a square extent), anchors in polar terms about its
//! centre instead: a point keeps its angle, and its offset from whichever of
//! the centre or the rim it was nearer, so a hole by the rim stays by the rim
//! where two independent axes would carry it off the face. With only a
//! `center`, the older form, everything moves with the outline's centre. With
//! neither, only along the normal.

use glam::{DVec2, DVec3};
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, CurveType, SurfaceType};
use serde_json::{Map, Value};

use super::entity::{edges_of, faces_of, need, num, unit, vector, FaceEnt, Key};
use super::{Kind, Resolver, REFERENCE_NOT_FOUND};
use crate::builder::{FResult, Fail};
use crate::kernel;

/// 1 - dot of a face normal against the stored one, about 2.6 degrees.
const ANG_TOL: f64 = 1e-3;
/// How far from a face's outline a carried point may land and still be on it.
const ON_FACE_TOL: f64 = 1e-3;

pub const REASON_SPLIT: &str = "the face this was on was split or reshaped and no face facing that way lies where its pick point went, re-pick the face";

/// The in-plane axes of a face with outward normal `n`, fixed by `n` alone so
/// a face that only moved has the same frame every build.
pub fn frame(n: DVec3) -> (DVec3, DVec3) {
    let reference = if n.z.abs() < 0.9 { DVec3::Z } else { DVec3::X };
    let u = unit(reference - n * n.dot(reference));
    (u, n.cross(u))
}

/// `[umin, umax, vmin, vmax]` of the face's outer boundary in the frame of `n`.
pub fn outline_extent(face: &Shape, n: DVec3) -> Option<[f64; 4]> {
    let (u, v) = frame(n);
    kernel::outline_extent(face, u.to_array(), v.to_array())
}

enum Written {
    Extent([f64; 4]),
    Center(DVec3),
    Normal,
}

/// What a tracked selector stored about its face when it was written.
pub struct Tracking {
    n: DVec3,
    written: Written,
}

/// A face measured once, to carry points written against the stored face onto it.
pub struct Onto {
    n: DVec3,
    plane_point: DVec3,
    plane_normal: DVec3,
    /// The face's own extent now, what a selector written today would store.
    pub extent: Option<[f64; 4]>,
    step: Step,
}

enum Step {
    Anchored { was: [f64; 4], now: [f64; 4] },
    Polar { was: [f64; 4], now: [f64; 4] },
    Shift(DVec3),
    Normal,
}

fn extent_of(v: &Value) -> FResult<[f64; 4]> {
    let type_error = || Fail::Internal("TypeError".into());
    let Value::Array(items) = v else {
        return Err(type_error());
    };
    if items.len() != 4 {
        return Err(type_error());
    }
    let mut out = [0.0; 4];
    for (slot, item) in out.iter_mut().zip(items) {
        *slot = num(item).filter(|x| x.is_finite()).ok_or_else(type_error)?;
    }
    Ok(out)
}

/// `c` kept at its offset from the nearest of the middle, min and max of
/// `[lo, hi]`, moved onto the same one of `[lo2, hi2]`.
fn anchored(c: f64, lo: f64, hi: f64, lo2: f64, hi2: f64) -> f64 {
    let anchors = [((lo + hi) / 2.0, (lo2 + hi2) / 2.0), (lo, lo2), (hi, hi2)];
    let mut best = anchors[0];
    for a in &anchors[1..] {
        if (c - a.0).abs() < (c - best.0).abs() {
            best = *a;
        }
    }
    best.1 + (c - best.0)
}

/// `p`, in the plane of the circle whose extent was `was`, kept at its angle
/// and at its offset from the nearer of that circle's centre and rim, moved
/// onto the circle whose extent is `now`. A tie prefers the centre.
fn polar(p: DVec2, was: [f64; 4], now: [f64; 4]) -> DVec2 {
    let circle = |e: [f64; 4]| (DVec2::new(e[0] + e[1], e[2] + e[3]) / 2.0, (e[1] - e[0]) / 2.0);
    let ((c0, r0), (c1, r1)) = (circle(was), circle(now));
    let d = p - c0;
    let rho = d.length();
    let moved = if rho <= r0 - rho { rho } else { (r1 - (r0 - rho)).max(0.0) };
    c1 + d.normalize_or_zero() * moved
}

fn square(e: [f64; 4]) -> bool {
    ((e[1] - e[0]) - (e[3] - e[2])).abs() <= ON_FACE_TOL
}

/// Whether the face's outer boundary is one whole circle, however many arcs
/// it is cut into.
fn round(face: &Shape) -> bool {
    let Some(edges) = kernel::outer_wire(face).and_then(|w| edges_of(&w).ok()) else {
        return false;
    };
    let Some((r0, c0)) = edges.first().and_then(|e| Some((e.radius()?, e.centre()?))) else {
        return false;
    };
    edges.iter().all(|e| {
        e.curve == CurveType::Circle
            && e.radius().is_some_and(|r| (r - r0).abs() <= ON_FACE_TOL)
            && e.centre().is_some_and(|c| c.distance(c0) <= ON_FACE_TOL)
    })
}

impl Tracking {
    pub fn of(m: &Map<String, Value>) -> FResult<Tracking> {
        let n = unit(vector(need(m, "normal")?)?);
        let present = |k: &str| m.get(k).filter(|v| !v.is_null());
        let written = if let Some(e) = present("extent") {
            Written::Extent(extent_of(e)?)
        } else if let Some(c) = present("center") {
            Written::Center(vector(c)?)
        } else {
            Written::Normal
        };
        Ok(Tracking { n, written })
    }

    /// None when the face cannot be measured the way the stored one was.
    pub fn onto(&self, face: &FaceEnt) -> Option<Onto> {
        let extent = outline_extent(&face.shape, self.n);
        let step = match &self.written {
            Written::Extent(was) => {
                let now = extent?;
                if square(*was) && square(now) && round(&face.shape) {
                    Step::Polar { was: *was, now }
                } else {
                    Step::Anchored { was: *was, now }
                }
            }
            Written::Center(c) => Step::Shift(
                kernel::outline_center(&face.shape).map_or(face.centroid(), DVec3::from_array) - *c,
            ),
            Written::Normal => Step::Normal,
        };
        Some(Onto {
            n: self.n,
            plane_point: face.centroid(),
            plane_normal: face.normal(),
            extent,
            step,
        })
    }
}

impl Onto {
    /// `p`, written against the stored face, where it is on this one.
    pub fn carry(&self, p: DVec3) -> DVec3 {
        let q = match &self.step {
            Step::Anchored { was, now } => {
                let (u, v) = frame(self.n);
                u * anchored(p.dot(u), was[0], was[1], now[0], now[1])
                    + v * anchored(p.dot(v), was[2], was[3], now[2], now[3])
                    + self.n * self.n.dot(p)
            }
            Step::Polar { was, now } => {
                let (u, v) = frame(self.n);
                let q = polar(DVec2::new(p.dot(u), p.dot(v)), *was, *now);
                u * q.x + v * q.y + self.n * self.n.dot(p)
            }
            Step::Shift(d) => p + *d,
            Step::Normal => p,
        };
        self.flatten(q)
    }

    fn flatten(&self, q: DVec3) -> DVec3 {
        let n = self.plane_normal;
        q - n * (n.dot(q) - n.dot(self.plane_point))
    }
}

/// Whether `q` lies within the face's outer boundary, openings in it counted
/// as face: a cut made upstream right under a pick point is not a new face.
fn covers(outline: &Shape, q: DVec3) -> bool {
    sa::distance_to_point(outline, q.to_array()).is_some_and(|(d, _)| d <= ON_FACE_TOL)
}

fn filled(face: &FaceEnt) -> Shape {
    kernel::outer_wire(&face.shape)
        .and_then(|w| kernel::face_from_wire(&w).ok())
        .unwrap_or_else(|| face.shape.clone())
}

pub(super) fn resolve(r: &mut Resolver, part: &Shape, m: &Map<String, Value>) -> FResult<Vec<FaceEnt>> {
    let p = vector(need(m, "point")?)?;
    let tracking = Tracking::of(m)?;
    let cands: Vec<FaceEnt> = faces_of(part)?
        .into_iter()
        .filter(|f| f.surface == SurfaceType::Plane && f.normal().dot(tracking.n) >= 1.0 - ANG_TOL)
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
    // (candidate, travel, still under the pick point)
    let mut pool: Vec<(usize, f64, bool)> = Vec::new();
    for (i, f) in cands.iter().enumerate() {
        let Some(onto) = tracking.onto(f) else { continue };
        let outline = filled(f);
        let q = onto.carry(p);
        if covers(&outline, q) {
            pool.push((i, (q - p).length(), covers(&outline, onto.flatten(p))));
        }
    }
    if pool.is_empty() {
        r.push("face", 0, 0.0, true, Some(REASON_SPLIT.into()), m.get("point"), None, Some(REFERENCE_NOT_FOUND));
        return Err(Fail::Value {
            message: REASON_SPLIT.into(),
            code: Some(REFERENCE_NOT_FOUND),
        });
    }
    if pool.iter().any(|c| c.2) {
        pool.retain(|c| c.2);
    }
    let costs: Vec<f64> = pool.iter().map(|c| c.1).collect();
    let keys: Vec<Key> = pool.iter().map(|c| cands[c.0].canonical_key()).collect();
    let pick = r.nearest_one(Kind::Face, m, &costs, &keys, |i| cands[pool[i].0].describe(), |_| None)?;
    Ok(cands.into_iter().nth(pool[pick.index].0).into_iter().collect())
}
