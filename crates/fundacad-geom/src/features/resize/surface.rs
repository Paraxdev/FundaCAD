//! The analytic surface a face lies on, its size, and how far a point sits
//! from its axis, centre or tube circle.

use glam::{dvec3, DVec3};
use opencascade::primitives::{Shape, ShapeType};
use opencascade::query::PointState;
use opencascade_sys::face_query as fq;

use crate::kernel;

#[derive(Clone, Copy, Debug)]
pub(super) enum Surf {
    Plane { n: DVec3, loc: DVec3 },
    Cyl { dir: DVec3, loc: DVec3, r: f64 },
    Cone { dir: DVec3, semi: f64, apex: DVec3 },
    Sphere { c: DVec3, r: f64 },
    Torus { dir: DVec3, loc: DVec3, big: f64, small: f64 },
    Other,
}

pub(super) fn surf(face: &Shape) -> Surf {
    let mut o = [0.0; 13];
    let Ok(k) = fq::FQ_surface(face.raw(), &mut o) else {
        return Surf::Other;
    };
    let d = dvec3(o[1], o[2], o[3]).normalize_or_zero();
    let l = dvec3(o[4], o[5], o[6]);
    match k {
        0 => Surf::Plane { n: d, loc: l },
        1 => Surf::Cyl { dir: d, loc: l, r: o[7] },
        2 => Surf::Cone { dir: d, semi: o[7], apex: dvec3(o[9], o[10], o[11]) },
        3 => Surf::Sphere { c: l, r: o[7] },
        4 => Surf::Torus { dir: d, loc: l, big: o[7], small: o[8] },
        _ => Surf::Other,
    }
}

pub(super) fn faces_of(s: &Shape) -> Vec<Shape> {
    s.shape_map(ShapeType::Face).iter().collect()
}

pub(super) fn radial(dir: DVec3, loc: DVec3, p: DVec3) -> DVec3 {
    let q = p - loc;
    q - dir * q.dot(dir)
}

/// The cone's axis turned toward the nappe `p` is on.
pub(super) fn nappe(dir: DVec3, apex: DVec3, p: DVec3) -> DVec3 {
    if (p - apex).dot(dir) >= 0.0 {
        dir
    } else {
        -dir
    }
}

pub(super) fn parallel(a: DVec3, b: DVec3) -> bool {
    a.cross(b).length() < 1e-6
}

impl Surf {
    /// The radius, the tube radius, or 0 for a cone, whose size is its normal offset.
    pub(super) fn size(&self) -> f64 {
        match *self {
            Surf::Cyl { r, .. } | Surf::Sphere { r, .. } => r,
            Surf::Torus { small, .. } => small,
            _ => 0.0,
        }
    }

    /// The size of the same family surface through `p`.
    pub(super) fn size_at(&self, p: DVec3) -> f64 {
        match *self {
            Surf::Cyl { dir, loc, .. } => radial(dir, loc, p).length(),
            Surf::Sphere { c, .. } => (p - c).length(),
            Surf::Torus { dir, loc, big, .. } => {
                let e = radial(dir, loc, p).normalize_or_zero();
                (p - (loc + e * big)).length()
            }
            Surf::Cone { dir, semi, apex } => {
                let a = nappe(dir, apex, p);
                let al = semi.abs();
                let t = (p - apex).dot(a);
                (radial(a, apex, p).length() - t * al.tan()) * al.cos()
            }
            _ => 0.0,
        }
    }

    /// Unit direction at `p` away from the axis, centre or tube circle.
    pub(super) fn away(&self, p: DVec3) -> DVec3 {
        match *self {
            Surf::Cyl { dir, loc, .. } => radial(dir, loc, p).normalize_or_zero(),
            Surf::Sphere { c, .. } => (p - c).normalize_or_zero(),
            Surf::Torus { dir, loc, big, .. } => {
                let e = radial(dir, loc, p).normalize_or_zero();
                (p - (loc + e * big)).normalize_or_zero()
            }
            Surf::Cone { dir, semi, apex } => {
                let a = nappe(dir, apex, p);
                let e = radial(a, apex, p).normalize_or_zero();
                let al = semi.abs();
                (e * al.cos() - a * al.sin()).normalize_or_zero()
            }
            _ => DVec3::ZERO,
        }
    }

    /// How far `other` sits from this surface along its own size, when it is
    /// the same family on the same axis or centre.
    pub(super) fn offset_of(&self, other: &Surf) -> Option<f64> {
        let on_line = |p: DVec3, dir: DVec3, loc: DVec3| radial(dir, loc, p).length() < 1e-5;
        match (*self, *other) {
            (Surf::Cyl { dir, loc, r }, Surf::Cyl { dir: d2, loc: l2, r: r2 }) if parallel(dir, d2) && on_line(l2, dir, loc) => {
                Some(r2 - r)
            }
            (Surf::Sphere { c, r }, Surf::Sphere { c: c2, r: r2 }) if (c - c2).length() < 1e-5 => Some(r2 - r),
            (Surf::Torus { dir, loc, big, small }, Surf::Torus { dir: d2, loc: l2, big: b2, small: s2 })
                if parallel(dir, d2) && (loc - l2).length() < 1e-5 && (big - b2).abs() < 1e-5 =>
            {
                Some(s2 - small)
            }
            (Surf::Cone { dir, semi, apex }, Surf::Cone { dir: d2, semi: s2, apex: a2 })
                if parallel(dir, d2) && (semi.abs() - s2.abs()).abs() < 1e-7 && on_line(a2, dir, apex) =>
            {
                Some((apex - a2).dot(dir) * semi.signum() * semi.abs().sin())
            }
            _ => None,
        }
    }

    pub(super) fn axis(&self) -> Option<(DVec3, DVec3)> {
        match *self {
            Surf::Cyl { dir, loc, .. } | Surf::Torus { dir, loc, .. } => Some((loc, dir)),
            Surf::Cone { dir, apex, .. } => Some((apex, dir)),
            _ => None,
        }
    }

    pub(super) fn analytic_curved(&self) -> bool {
        matches!(self, Surf::Cyl { .. } | Surf::Cone { .. } | Surf::Sphere { .. } | Surf::Torus { .. })
    }
}

/// A point inside the face's trimmed boundary and the outward normal there.
pub(super) fn inner_point(face: &Shape) -> Option<(DVec3, DVec3)> {
    let f = face.as_face()?;
    let b = f.uv_bounds().ok()?;
    let at = |s: f64, t: f64| (b.u_min + s * (b.u_max - b.u_min), b.v_min + t * (b.v_max - b.v_min));
    let grid = (0..7).flat_map(|i| (0..7).map(move |j| ((f64::from(i) + 0.5) / 7.0, (f64::from(j) + 0.5) / 7.0)));
    std::iter::once((0.5, 0.5)).chain(grid).find_map(|(s, t)| {
        let (u, v) = at(s, t);
        (f.classify_uv(u, v, 1e-7).ok()? == PointState::In)
            .then(|| f.point_and_normal(u, v).ok())
            .flatten()
    })
}

/// Points strictly inside the face's trimmed boundary, from an `n` by `n` grid over its UV box.
pub(super) fn inner_points(face: &Shape, n: i32) -> Vec<DVec3> {
    let Some(f) = face.as_face() else { return vec![] };
    let Ok(b) = f.uv_bounds() else { return vec![] };
    let mut out = Vec::new();
    for i in 0..n {
        for j in 0..n {
            let u = b.u_min + (f64::from(i) + 0.37) / f64::from(n) * (b.u_max - b.u_min);
            let v = b.v_min + (f64::from(j) + 0.61) / f64::from(n) * (b.v_max - b.v_min);
            if f.classify_uv(u, v, 1e-7).ok() == Some(PointState::In) {
                if let Ok((p, _)) = f.point_and_normal(u, v) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// The outward normal looks at the axis, centre or tube circle: the material lies away from it.
pub(super) fn concave(face: &Shape, s: &Surf) -> Option<bool> {
    let (p, n) = inner_point(face)?;
    Some(n.dot(s.away(p)) < 0.0)
}

/// Every face of `body` on the same family surface as `s`, offset by `size`.
pub(super) fn faces_at(body: &Shape, s: &Surf, size: f64) -> Vec<Shape> {
    faces_of(body)
        .into_iter()
        .filter(|f| s.offset_of(&surf(f)).is_some_and(|o| (o - size).abs() < 1e-4))
        .collect()
}

pub(super) fn area_at(body: &Shape, s: &Surf, size: f64) -> f64 {
    faces_at(body, s, size).iter().map(kernel::area).sum()
}
