//! A G2 or G3 fillet blend, a freeform round rather than a circle, resized as the fillet it came from: the corner
//! it rounds is restored and filleted again at the new radius, so the blend stays tangent to both walls.

use std::cell::RefCell;

use glam::DVec3;
use opencascade::primitives::{Shape, SurfaceType};
use opencascade::progress::ProgressRange;

use super::blend::ops as blend_ops;
use super::blend::SectionErr;
use super::solid_ops::surface_type;
use crate::builder::{FResult, Fail};
use crate::kernel::{self, Kind};
use crate::mesh::edges::SMOOTH_EDGE_DEG;
use crate::select::entity::{EdgeEnt, FaceEnt};
use crate::topo::FaceAdjacency;

/// How far a probe's area and removed volume may stray from the blend's and still be the same round.
const MATCH: f64 = 0.02;

const KEEP: usize = 4;

/// A body's (uid, generation), which `Ctx::set_shape` renews on every change, and a face's index in it. A rebuild
/// resumed from RAM hands each drag tick a copy of the same body, so the shape itself is new every time.
type Key = ((u64, u64), usize);

thread_local! {
    static FOUND: RefCell<Vec<(Key, Option<Blend>)>> = const { RefCell::new(Vec::new()) };
}

/// Drops the blends this thread has kept.
pub fn forget() {
    FOUND.with(|m| m.borrow_mut().clear());
}

#[derive(Clone)]
pub struct Blend {
    /// The body with the blend taken off and its corner sharp again.
    pub corner: Shape,
    /// The sharp edge's index among the corner's edges, so a copy of the corner finds it.
    edge: usize,
    pub radius: f64,
    pub continuity: i32,
    /// The blend fills an inside corner, so a larger radius adds material.
    pub concave: bool,
    pub axis: (DVec3, DVec3),
}

fn valid(s: &Shape) -> bool {
    s.is_valid().unwrap_or(false)
}

fn one_solid(s: &Shape) -> Option<Shape> {
    let s = kernel::unwrap_compound(s);
    (valid(&s) && kernel::count(&s, Kind::Solid) == 1).then_some(s)
}

fn near(face: &Shape, p: DVec3, tol: f64) -> bool {
    kernel::distance_to_point(face, p.to_array()).is_some_and(|d| d < tol)
}

fn fillet(corner: &Shape, edge: &Shape, radius: f64, continuity: i32) -> Option<Shape> {
    let edges = std::slice::from_ref(edge);
    let out = blend_ops::section(corner, edges, false, &[radius], None, radius, continuity, false, 0.0).ok()?;
    one_solid(&out)
}

/// The freeform face of `out` the fillet made, the one nearest `at`.
fn new_blend(out: &Shape, at: DVec3) -> Option<Shape> {
    kernel::subshapes(out, Kind::Face)
        .into_iter()
        .filter(|f| surface_type(f) == Some(SurfaceType::BSplineSurface))
        .filter_map(|f| kernel::distance_to_point(&f, at.to_array()).map(|d| (d, f)))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, f)| f)
}

fn freeform(face: &Shape) -> bool {
    matches!(
        surface_type(face),
        Some(SurfaceType::BSplineSurface | SurfaceType::BezierSurface | SurfaceType::SurfaceOfExtrusion)
    )
}

/// The blend `face` belongs to, with any freeform face that carries it on smoothly, as a push of a face beside it
/// leaves one, and a point on each of the two walls it runs smoothly into.
fn blend_faces(part: &Shape, face: &Shape) -> Option<(Vec<Shape>, [DVec3; 2])> {
    let adj = FaceAdjacency::new(part);
    let mut group = vec![adj.index_of(face)];
    let mut walls: Vec<(usize, DVec3)> = Vec::new();
    let mut k = 0;
    while k < group.len() {
        for (j, edge) in adj.walk(group[k]) {
            let smooth = blend_ops::dihedral_deg(part, &edge).is_some_and(|a| a.min(180.0 - a) < SMOOTH_EDGE_DEG);
            if !smooth || group.contains(&j) || walls.iter().any(|w| w.0 == j) {
                continue;
            }
            if freeform(&adj.face(j)) {
                group.push(j);
            } else {
                walls.push((j, EdgeEnt::new(edge).ok()?.mid));
            }
        }
        k += 1;
    }
    let [(_, a), (_, b)]: [(usize, DVec3); 2] = walls.try_into().ok()?;
    Some((group.into_iter().map(|i| adj.face(i)).collect(), [a, b]))
}

/// The sharp edge where the two walls meet once the blend is gone: the one whose faces hold both seams.
fn corner_edge(corner: &Shape, seams: [DVec3; 2], face: &Shape) -> Option<Shape> {
    let adj = FaceAdjacency::new(corner);
    kernel::subshapes(corner, Kind::Edge)
        .into_iter()
        .filter(|e| {
            let fs = adj.faces_of_edge(e);
            fs.len() == 2 && fs[0] != fs[1] && {
                let (f, g) = (adj.face(fs[0]), adj.face(fs[1]));
                let tol = 1e-5;
                (near(&f, seams[0], tol) && near(&g, seams[1], tol))
                    || (near(&f, seams[1], tol) && near(&g, seams[0], tol))
            }
        })
        .filter_map(|e| EdgeEnt::new(e.clone()).ok().map(|en| (en.mid, e)))
        .filter_map(|(m, e)| kernel::distance_to_point(face, m.to_array()).map(|d| (d, e)))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, e)| e)
}

/// `face` as the G2 or G3 fillet of one sharp edge, with the radius and continuity it was built at. None for any
/// other face: one that is analytic, does not run smoothly into exactly two walls, or no probe fillet matches.
/// Kept by `body`, the identity of the body whose shape `part` is, since a drag asks again at every tick.
pub fn blend_of(part: &Shape, face: &Shape, body: Option<(u64, u64)>) -> Option<Blend> {
    if !freeform(face) {
        return None;
    }
    let key = body.zip(kernel::subshapes(part, Kind::Face).iter().position(|f| f.is_same(face)));
    let Some(key) = key else {
        return crate::bench::phase("blend_of", || find(part, face));
    };
    if let Some(b) = FOUND.with(|m| m.borrow().iter().find(|(k, _)| *k == key).map(|e| e.1.clone())) {
        return b;
    }
    let b = crate::bench::phase("blend_of", || find(part, face));
    FOUND.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= KEEP {
            m.remove(0);
        }
        m.push((key, b.clone()));
    });
    b
}

fn find(part: &Shape, face: &Shape) -> Option<Blend> {
    let (group, seams) = blend_faces(part, face)?;
    let faces: Vec<_> = group.iter().filter_map(Shape::as_face).collect();
    let refs: Vec<_> = faces.iter().collect();
    let removed = part.remove_features(&refs, true, &ProgressRange::detached()).ok()?.shape;
    let corner = one_solid(&removed)?;
    if kernel::count(&corner, Kind::Face) >= kernel::count(part, Kind::Face) {
        return None;
    }
    let edge = corner_edge(&corner, seams, face)?;
    let e = EdgeEnt::new(edge.clone()).ok()?;
    let (s, t) = e.ends?;
    let axis = (e.mid, (t - s).normalize_or_zero());
    let (v_corner, v_part) = (kernel::volume(&corner), kernel::volume(part));
    let concave = v_corner < v_part;
    let (gone, area) = ((v_corner - v_part).abs(), group.iter().map(kernel::area).sum::<f64>());
    let at = FaceEnt::new(face.clone()).ok()?.centroid();
    // A smooth blend sets back about one and a half times its radius on a square corner.
    let probe = seams.iter().map(|p| p.distance(e.mid)).fold(f64::INFINITY, f64::min) / 1.5;
    // A straight corner scales with the radius: the blend's area linearly, the volume it takes off squared.
    let fit = |c: i32, r: f64| -> Option<(f64, f64)> {
        let out = fillet(&corner, &edge, r, c)?;
        let a = kernel::area(&new_blend(&out, at)?);
        let size = r * area / a;
        let v = (v_corner - kernel::volume(&out)).abs() * (size / r).powi(2);
        Some((size, (v - gone).abs() / gone))
    };
    let (continuity, radius, _) = [3, 2]
        .into_iter()
        .filter_map(|c| {
            let (r, miss) = fit(c, probe)?;
            if (r - probe).abs() < 1e-3 * r {
                return Some((c, r, miss));
            }
            let (again, miss) = fit(c, r)?;
            Some((c, again, miss))
        })
        .filter(|(_, _, miss)| *miss < MATCH)
        .min_by(|a, b| a.2.total_cmp(&b.2))?;
    let radius = (radius * 1e3).round() / 1e3;
    let edge = kernel::subshapes(&corner, Kind::Edge).iter().position(|e| e.is_same(&edge))?;
    Some(Blend { corner, edge, radius, continuity, concave, axis })
}

/// `face` pushed `d` along its normal, positive adding material, as its fillet rebuilt at the radius that takes:
/// smaller on an outside corner, larger on an inside one. None when `face` is not such a blend.
pub fn regrow(part: &Shape, face: &Shape, d: f64, body: Option<(u64, u64)>) -> Option<FResult<Shape>> {
    let b = blend_of(part, face, body)?;
    Some(b.rebuilt(d))
}

impl Blend {
    fn radius_after(&self, d: f64) -> f64 {
        self.radius + if self.concave { d } else { -d }
    }

    fn rebuilt(&self, d: f64) -> FResult<Shape> {
        let r = self.radius_after(d);
        if r < -1e-6 {
            return Err(Fail::msg("that push runs the round past the sharp corner it rounds, try a smaller distance"));
        }
        // A kept corner is handed to every tick, and OCCT writes p-curves and tolerances into what it is given.
        let corner = kernel::copy_topology(&self.corner)?;
        if r.abs() < 1e-6 {
            return Ok(corner);
        }
        let Some(edge) = kernel::subshapes(&corner, Kind::Edge).into_iter().nth(self.edge) else {
            return Err(Fail::msg("the corner's edge is gone"));
        };
        let edges = std::slice::from_ref(&edge);
        let built = blend_ops::section(&corner, edges, false, &[r], None, r, self.continuity, false, 0.0);
        if let Some(out) = built.as_ref().ok().and_then(one_solid) {
            return Ok(out);
        }
        let why = match built {
            Err(SectionErr::Blend(m)) => Some(m),
            _ => None,
        };
        let head = format!("can't round this corner again at R{}", crate::builder::py_g(r));
        Err(Fail::msg(why.map_or(head.clone(), |m| format!("{head}, {m}"))))
    }
}
