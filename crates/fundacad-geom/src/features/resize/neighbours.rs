//! How a face meets the faces around it, its tangent run, and which of its
//! neighbours a size change would leave behind.

use std::collections::BTreeSet;

use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade::query::PointState;

use super::surface::{inner_points, parallel, radial, surf, Surf};
use crate::kernel::{self, Kind};
use crate::topo::FaceAdjacency;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum EdgeKind {
    SameSurface,
    Tangent,
    Convex,
    Reflex,
}

fn edge_mid_tangent(e: &Shape) -> Option<(DVec3, DVec3)> {
    let (_, [a, b]) = kernel::edge_eval(e, 0.0)?;
    let m = 0.5 * (a + b);
    let h = 1e-4 * (b - a);
    let p = DVec3::from_array(kernel::edge_eval(e, m)?.0);
    let p1 = DVec3::from_array(kernel::edge_eval(e, m + h)?.0);
    let p0 = DVec3::from_array(kernel::edge_eval(e, m - h)?.0);
    Some((p, (p1 - p0).try_normalize()?))
}

fn normal_at(face: &Shape, p: DVec3) -> Option<DVec3> {
    let f = face.as_face()?;
    let pr = f.project_point(p).ok()??;
    f.point_and_normal(pr.u, pr.v).ok().map(|(_, n)| n)
}

fn lands_in(face: &Shape, q: DVec3) -> bool {
    let Some(f) = face.as_face() else { return false };
    let Ok(Some(pr)) = f.project_point(q) else { return false };
    pr.distance < 1e-3 && f.classify_uv(pr.u, pr.v, 1e-7).ok() == Some(PointState::In)
}

/// How `face` meets `other` along `edge`, read in the material. None when a
/// step off the edge does not land inside `face`.
pub(super) fn edge_kind(face: &Shape, other: &Shape, edge: &Shape) -> Option<EdgeKind> {
    let (s, so) = (surf(face), surf(other));
    if s.offset_of(&so).is_some_and(|o| o.abs() < 1e-6) {
        return Some(EdgeKind::SameSurface);
    }
    let (p, t) = edge_mid_tangent(edge)?;
    let n1 = normal_at(face, p)?;
    let n2 = normal_at(other, p)?;
    if n1.dot(n2) > 1f64.to_radians().cos() {
        return Some(EdgeKind::Tangent);
    }
    let w0 = n1.cross(t).normalize_or_zero();
    let eps = 1e-3;
    let w = if lands_in(face, p + w0 * eps) {
        w0
    } else if lands_in(face, p - w0 * eps) {
        -w0
    } else {
        return None;
    };
    Some(if w.dot(n2) < 0.0 { EdgeKind::Convex } else { EdgeKind::Reflex })
}

pub(super) struct Nb {
    pub face: Shape,
    pub kind: Option<EdgeKind>,
}

/// The faces across the group's non seam edges, outside the group, once per
/// face; a face met both tangentially and not counts as tangent.
pub(super) fn neighbours(adj: &FaceAdjacency, group: &[Shape]) -> Vec<Nb> {
    let mut out: Vec<Nb> = Vec::new();
    for f in group {
        for e in kernel::subshapes(f, Kind::Edge) {
            if adj.is_seam(&e) {
                continue;
            }
            for j in adj.faces_of_edge(&e) {
                let other = adj.face(j);
                if j == 0 || group.iter().any(|g| g.is_same(&other)) {
                    continue;
                }
                let kind = edge_kind(f, &other, &e);
                match out.iter_mut().find(|n| n.face.is_same(&other)) {
                    Some(n) if kind == Some(EdgeKind::Tangent) => n.kind = kind,
                    Some(_) => {}
                    None => out.push(Nb { face: other, kind }),
                }
            }
        }
    }
    out
}

fn flood(adj: &FaceAdjacency, start: &[Shape], keep: impl Fn(EdgeKind) -> bool) -> Vec<Shape> {
    let mut seen: BTreeSet<usize> = start.iter().map(|f| adj.index_of(f)).filter(|&i| i != 0).collect();
    let mut todo: Vec<usize> = seen.iter().copied().collect();
    while let Some(i) = todo.pop() {
        let f = adj.face(i);
        for (j, e) in adj.walk(i) {
            if j == 0 || seen.contains(&j) || adj.is_seam(&e) {
                continue;
            }
            if edge_kind(&f, &adj.face(j), &e).is_some_and(&keep) {
                seen.insert(j);
                todo.push(j);
            }
        }
    }
    seen.into_iter().map(|i| adj.face(i)).collect()
}

/// The face and every face on its own surface reached across its edges, so a
/// round face split in two moves as one.
pub(super) fn same_surface(adj: &FaceAdjacency, face: &Shape) -> Vec<Shape> {
    flood(adj, std::slice::from_ref(face), |k| k == EdgeKind::SameSurface)
}

/// Every face reached from the group across tangent or same surface edges.
pub(super) fn tangent_run(adj: &FaceAdjacency, group: &[Shape]) -> Vec<Shape> {
    flood(adj, group, |k| matches!(k, EdgeKind::Tangent | EdgeKind::SameSurface))
}

/// Where the neighbour stops meeting the face, as (on a shrink, on a grow): a
/// tangent neighbour at the face's own size, a plane along the axis at its
/// distance from it, a cylinder along the axis where the two circles touch.
/// None for a neighbour a size change can never leave behind.
fn contact(s: &Surf, nb: &Nb) -> Option<(f64, f64)> {
    if nb.kind == Some(EdgeKind::Tangent) {
        return Some((s.size(), s.size()));
    }
    let Surf::Cyl { dir, loc, .. } = *s else { return None };
    match surf(&nb.face) {
        Surf::Plane { n, loc: pl } if n.dot(dir).abs() < 1e-6 => Some(((pl - loc).dot(n).abs(), f64::INFINITY)),
        Surf::Cyl { dir: d2, loc: l2, r: rho } if parallel(dir, d2) => {
            let c = radial(dir, loc, l2).length();
            Some(((c - rho).abs(), c + rho))
        }
        _ => None,
    }
}

/// The spread of sizes the neighbour's face covers, relative to the face's.
fn spread(s: &Surf, nb: &Nb) -> Option<(f64, f64)> {
    let ss: Vec<f64> = inner_points(&nb.face, 4).into_iter().map(|p| s.size_at(p) - s.size()).collect();
    let lo = ss.iter().copied().reduce(f64::min)?;
    let hi = ss.iter().copied().reduce(f64::max)?;
    Some((lo, hi))
}

pub(super) struct Lost {
    pub face: Shape,
    pub contact: f64,
}

/// The neighbours a size change of `delta` would leave behind: ones that run
/// away from the face outward on a shrink smaller than where they meet it, or
/// inward on a grow past it.
pub(super) fn left_behind(s: &Surf, nbs: &[Nb], delta: f64) -> Vec<Lost> {
    let r2 = s.size() + delta;
    nbs.iter()
        .filter_map(|nb| {
            let (shrink, grow) = contact(s, nb)?;
            let (lo, hi) = spread(s, nb)?;
            let c = if delta < 0.0 && lo >= -1e-6 && r2 < shrink - 1e-9 {
                shrink
            } else if delta > 0.0 && hi <= 1e-6 && r2 > grow + 1e-9 {
                grow
            } else {
                return None;
            };
            Some(Lost { face: nb.face.clone(), contact: c })
        })
        .collect()
}

/// The tangent neighbours worth splitting the band along: one running inward
/// that a shrink pulls away from, like the ball under a narrowed bore. One
/// running outward is crossed by a grow and trimmed by it instead.
pub(super) fn splits_band(s: &Surf, nb: &Nb, delta: f64) -> bool {
    match nb.kind {
        Some(EdgeKind::Tangent) => delta < 0.0 && spread(s, nb).is_some_and(|(_, hi)| hi <= 1e-6),
        _ => true,
    }
}

/// Where the face would first leave a neighbour behind: the largest contact
/// on a shrink, else the smallest on a grow, with whether it is a shrink.
pub(super) fn first_contact(s: &Surf, nbs: &[Nb]) -> Option<(f64, bool)> {
    let mut shrink: Option<f64> = None;
    let mut grow: Option<f64> = None;
    for nb in nbs {
        let (Some((sc, gc)), Some((lo, hi))) = (contact(s, nb), spread(s, nb)) else { continue };
        if lo >= -1e-6 && sc <= s.size() + 1e-9 {
            shrink = Some(shrink.map_or(sc, |m| m.max(sc)));
        }
        if hi <= 1e-6 && gc >= s.size() - 1e-9 {
            grow = Some(grow.map_or(gc, |m| m.min(gc)));
        }
    }
    shrink.map(|c| (c, true)).or(grow.map(|c| (c, false)))
}
