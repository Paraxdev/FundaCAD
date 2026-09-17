//! Which faces of a body are pieces of ONE surface that B-rep cannot store as
//! one, sidecar/face_bands.py.
//!
//! Two faces join only when they touch (a shared edge, or a gap no wider than
//! the clearance the kernel inserts between screw turns) and sit on the same
//! analytic surface seen from the same side. Splines and surfaces of
//! revolution are never joined.

use std::collections::{BTreeMap, HashMap, HashSet};

use opencascade::primitives::{Shape, ShapeType};
use opencascade::select_access::{self as sa, ItemKind};
use opencascade_sys::face_query as fq;

pub const LIN_TOL: f64 = 1e-7;
pub const ANG_TOL: f64 = 1e-9;
pub const GAP_ABS: f64 = 1e-3;
pub const GAP_REL: f64 = 1e-4;
/// Above this many faces a body is a dense import, not a split repair missed.
pub const MAX_BAND_FACES: usize = 3000;

type V3 = [f64; 3];

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

fn scale(a: V3, k: f64) -> V3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

fn same_dir(a: V3, b: V3) -> bool {
    dot(a, b) > 1.0 - ANG_TOL
}

fn on_axis(pa: V3, pb: V3, d: V3) -> bool {
    norm(cross(sub(pa, pb), d)) <= LIN_TOL
}

/// `_canon_dir`: an axis LINE's direction with its sign normalised away.
fn canon_dir(d: V3) -> V3 {
    for c in d {
        if c.abs() > ANG_TOL {
            return if c > 0.0 { d } else { scale(d, -1.0) };
        }
    }
    d
}

/// A face's analytic surface with its outward side baked in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Surface {
    Plane { normal: V3, offset: f64 },
    Cylinder { dir: V3, loc: V3, radius: f64, side: f64 },
    Cone { dir: V3, apex: V3, semi_angle: f64, flip: f64 },
    Sphere { centre: V3, radius: f64, flip: f64 },
    Torus { dir: V3, loc: V3, major: f64, minor: f64, side: f64 },
}

/// `_outward_at_middle`: (point, unit normal) at the parametric middle.
fn outward_at_middle(face: &Shape) -> Result<Option<(V3, V3)>, cxx::Exception> {
    let mut o = [0.0; 6];
    fq::FQ_mid_normal(face.raw(), &mut o)?;
    let n = [o[3], o[4], o[5]];
    let m = norm(n);
    if m <= 0.0 {
        return Ok(None);
    }
    Ok(Some(([o[0], o[1], o[2]], scale(n, 1.0 / m))))
}

fn radial_side(face: &Shape, dir: V3, loc: V3) -> Result<f64, cxx::Exception> {
    let Some((point, normal)) = outward_at_middle(face)? else {
        return Ok(0.0);
    };
    let rel = sub(point, loc);
    let radial = sub(rel, scale(dir, dot(rel, dir)));
    let m = norm(radial);
    if m <= LIN_TOL {
        return Ok(0.0);
    }
    Ok(if dot(normal, scale(radial, 1.0 / m)) > 0.0 { 1.0 } else { -1.0 })
}

fn torus_side(face: &Shape, dir: V3, loc: V3, major: f64) -> Result<f64, cxx::Exception> {
    let Some((point, normal)) = outward_at_middle(face)? else {
        return Ok(0.0);
    };
    let rel = sub(point, loc);
    let planar = sub(rel, scale(dir, dot(rel, dir)));
    let m = norm(planar);
    if m <= LIN_TOL {
        return Ok(0.0);
    }
    let centre: V3 = std::array::from_fn(|k| loc[k] + planar[k] * (major / m));
    let r = sub(point, centre);
    let rm = norm(r);
    if rm <= LIN_TOL {
        return Ok(0.0);
    }
    Ok(if dot(normal, scale(r, 1.0 / rm)) > 0.0 { 1.0 } else { -1.0 })
}

/// `surface_of`: `Ok(None)` for a kind this module will not judge.
pub fn surface_of(face: &Shape) -> Result<Option<Surface>, cxx::Exception> {
    let mut o = [0.0; 13];
    let kind = fq::FQ_surface(face.raw(), &mut o)?;
    let flip = if o[0] != 0.0 { -1.0 } else { 1.0 };
    let dir = [o[1], o[2], o[3]];
    let loc = [o[4], o[5], o[6]];
    Ok(match kind {
        0 => {
            let normal = scale(dir, flip);
            Some(Surface::Plane { normal, offset: dot(normal, loc) })
        }
        1 => {
            let d = canon_dir(dir);
            Some(Surface::Cylinder { dir: d, loc, radius: o[7], side: radial_side(face, d, loc)? })
        }
        2 => Some(Surface::Cone { dir, apex: [o[9], o[10], o[11]], semi_angle: o[7], flip }),
        3 => Some(Surface::Sphere { centre: loc, radius: o[7], flip }),
        4 => {
            let d = canon_dir(dir);
            Some(Surface::Torus {
                dir: d,
                loc,
                major: o[7],
                minor: o[8],
                side: torus_side(face, d, loc, o[7])?,
            })
        }
        _ => None,
    })
}

/// `same_surface`: one surface, seen from the same side.
pub fn same_surface(a: Option<&Surface>, b: Option<&Surface>) -> bool {
    use Surface as S;
    match (a, b) {
        (Some(S::Plane { normal: n1, offset: o1 }), Some(S::Plane { normal: n2, offset: o2 })) => {
            same_dir(*n1, *n2) && (o1 - o2).abs() <= LIN_TOL
        }
        (
            Some(S::Cylinder { dir: d1, loc: l1, radius: r1, side: s1 }),
            Some(S::Cylinder { dir: d2, loc: l2, radius: r2, side: s2 }),
        ) => s1 == s2 && (r1 - r2).abs() <= LIN_TOL && same_dir(*d1, *d2) && on_axis(*l1, *l2, *d1),
        (
            Some(S::Cone { dir: d1, apex: a1, semi_angle: t1, flip: f1 }),
            Some(S::Cone { dir: d2, apex: a2, semi_angle: t2, flip: f2 }),
        ) => f1 == f2 && (t1 - t2).abs() <= ANG_TOL && same_dir(*d1, *d2) && norm(sub(*a1, *a2)) <= LIN_TOL,
        (
            Some(S::Sphere { centre: c1, radius: r1, flip: f1 }),
            Some(S::Sphere { centre: c2, radius: r2, flip: f2 }),
        ) => f1 == f2 && (r1 - r2).abs() <= LIN_TOL && norm(sub(*c1, *c2)) <= LIN_TOL,
        (
            Some(S::Torus { dir: d1, loc: l1, major: m1, minor: n1, side: s1 }),
            Some(S::Torus { dir: d2, loc: l2, major: m2, minor: n2, side: s2 }),
        ) => {
            s1 == s2
                && (m1 - m2).abs() <= LIN_TOL
                && (n1 - n2).abs() <= LIN_TOL
                && same_dir(*d1, *d2)
                && norm(sub(*l1, *l2)) <= LIN_TOL
        }
        _ => false,
    }
}

/// `_bucket`: a deliberately coarse key, rounded to 6 decimals.
fn bucket(s: &Surface) -> (u8, Vec<u64>) {
    let key = |xs: &[f64]| -> Vec<u64> {
        xs.iter()
            .map(|&x| {
                let r = crate::select::entity::py_round(x, 6);
                (if r == 0.0 { 0.0 } else { r }).to_bits()
            })
            .collect()
    };
    match *s {
        Surface::Plane { normal: n, offset } => (0, key(&[n[0], n[1], n[2], offset])),
        Surface::Cylinder { dir: d, loc: l, radius, side } => {
            (1, key(&[d[0], d[1], d[2], l[0], l[1], l[2], radius, side]))
        }
        Surface::Cone { dir: d, apex: a, semi_angle, flip } => {
            (2, key(&[d[0], d[1], d[2], a[0], a[1], a[2], semi_angle, flip]))
        }
        Surface::Sphere { centre: c, radius, flip } => (3, key(&[c[0], c[1], c[2], radius, flip])),
        Surface::Torus { dir: d, loc: l, major, minor, side } => {
            (4, key(&[d[0], d[1], d[2], l[0], l[1], l[2], major, minor, side]))
        }
    }
}

fn bbox(shape: &Shape, optimal: bool) -> Option<[f64; 6]> {
    let mut o = [0.0; 6];
    matches!(fq::FQ_bbox(shape.raw(), optimal, &mut o), Ok(true)).then_some(o)
}

fn diag(b: Option<[f64; 6]>) -> f64 {
    b.map_or(0.0, |b| norm([b[3] - b[0], b[4] - b[1], b[5] - b[2]]))
}

/// `gap_tolerance`: how wide a gap may still count as touching.
pub fn gap_tolerance(shape: &Shape) -> f64 {
    GAP_ABS.max(GAP_REL * diag(bbox(shape, true)))
}

/// `_adjacent_pairs`: face positions that share an edge, keyed by TShape.
fn adjacent_pairs(shape: &Shape, faces: &[Shape]) -> HashSet<(usize, usize)> {
    let amap = shape.ancestor_map(ShapeType::Edge, ShapeType::Face);
    let mut where_: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, f) in faces.iter().enumerate() {
        where_.entry(fq::FQ_tshape(f.raw())).or_default().push(i);
    }
    let mut seen = HashSet::new();
    for e in 1..=amap.len() {
        let owners: Vec<usize> = amap
            .ancestors_at(e)
            .iter()
            .flat_map(|f| where_.get(&fq::FQ_tshape(f.raw())).cloned().unwrap_or_default())
            .collect();
        for a in 0..owners.len() {
            for b in a + 1..owners.len() {
                let (lo, hi) = (owners[a].min(owners[b]), owners[a].max(owners[b]));
                if lo != hi {
                    seen.insert((lo, hi));
                }
            }
        }
    }
    seen
}

/// `_near_pairs`: same-surface faces within the gap tolerance, no shared edge.
fn near_pairs(
    faces: &[Shape],
    surf: &[Option<Surface>],
    shape: &Shape,
    already: &HashSet<(usize, usize)>,
) -> HashSet<(usize, usize)> {
    let mut buckets: BTreeMap<(u8, Vec<u64>), Vec<usize>> = BTreeMap::new();
    for (i, d) in surf.iter().enumerate() {
        if let Some(d) = d {
            buckets.entry(bucket(d)).or_default().push(i);
        }
    }
    let groups: Vec<&Vec<usize>> = buckets.values().filter(|g| g.len() >= 2).collect();
    let mut out = HashSet::new();
    if groups.is_empty() {
        return out;
    }
    let screen = GAP_ABS.max(GAP_REL * diag(bbox(shape, false)));
    let mut exact: Option<f64> = None;
    for group in groups {
        let boxes: HashMap<usize, [f64; 6]> =
            group.iter().filter_map(|&i| Some((i, bbox(&faces[i], false)?))).collect();
        for a in 0..group.len() {
            for b in a + 1..group.len() {
                let (i, j) = (group[a], group[b]);
                let pair = (i.min(j), i.max(j));
                if already.contains(&pair) {
                    continue;
                }
                let (Some(bi), Some(bj)) = (boxes.get(&i), boxes.get(&j)) else {
                    continue;
                };
                let t = screen;
                if bi[0] > bj[3] + t
                    || bj[0] > bi[3] + t
                    || bi[1] > bj[4] + t
                    || bj[1] > bi[4] + t
                    || bi[2] > bj[5] + t
                    || bj[2] > bi[5] + t
                {
                    continue;
                }
                if !same_surface(surf[i].as_ref(), surf[j].as_ref()) {
                    continue;
                }
                let Ok(d) = faces[i].distance(&faces[j], 0.0) else {
                    continue;
                };
                let gap = d.value;
                if gap > screen {
                    continue;
                }
                if gap > GAP_ABS {
                    let tol = *exact.get_or_insert_with(|| gap_tolerance(shape));
                    if gap > tol {
                        continue;
                    }
                }
                out.insert(pair);
            }
        }
    }
    out
}

/// `face_bands`: runs of two or more face positions (`shape.faces()` order)
/// that are pieces of one surface, each sorted, ordered by first member.
pub fn face_bands(shape: &Shape) -> Vec<Vec<usize>> {
    let faces = sa::items(shape, ItemKind::Face);
    face_bands_capped(shape, &faces, MAX_BAND_FACES)
}

pub fn face_bands_capped(shape: &Shape, faces: &[Shape], cap: usize) -> Vec<Vec<usize>> {
    if faces.len() < 2 || faces.len() > cap {
        return Vec::new();
    }
    let mut pairs = adjacent_pairs(shape, faces);
    let Ok(surf) = faces.iter().map(surface_of).collect::<Result<Vec<_>, _>>() else {
        return Vec::new();
    };
    let near = near_pairs(faces, &surf, shape, &pairs);
    pairs.extend(near);
    if pairs.is_empty() {
        return Vec::new();
    }
    let mut parent: Vec<usize> = (0..faces.len()).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut ordered: Vec<(usize, usize)> = pairs.iter().copied().collect();
    ordered.sort_unstable();
    for &(lo, hi) in &ordered {
        if same_surface(surf[lo].as_ref(), surf[hi].as_ref()) {
            let (a, b) = (find(&mut parent, lo), find(&mut parent, hi));
            if a != b {
                parent[a.max(b)] = a.min(b);
            }
        }
    }
    let wanted: std::collections::BTreeSet<usize> = pairs.iter().flat_map(|&(a, b)| [a, b]).collect();
    let mut runs: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in wanted {
        let root = find(&mut parent, i);
        runs.entry(root).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = runs.into_values().filter(|v| v.len() > 1).collect();
    out.sort_by_key(|v| v[0]);
    out
}
