//! texture_mesh.py's charts: the face's surface as the kernel describes it,
//! (u, v) parameters to millimetres, the planar chart of a freeform face, the
//! triplanar weights, the slope mask and the per vertex surface frame.

use std::f64::consts::PI;

use crate::fundacad::plugin::types::SurfaceFrame;
use crate::height::pairwise_sum;
use crate::mathx;
use crate::spec::Spec;
use crate::v3::{self, V};
use crate::Shape;

pub struct Surf<'a> {
    pub face: &'a Shape,
    pub frame: SurfaceFrame,
}

pub struct Sample {
    pub point: V,
    pub du: V,
    pub dv: V,
    pub normal: Option<V>,
}

fn t3(v: (f64, f64, f64)) -> V {
    [v.0, v.1, v.2]
}

impl<'a> Surf<'a> {
    pub fn new(face: &'a Shape) -> Option<Surf<'a>> {
        Some(Surf {
            face,
            frame: face.surface_frame()?,
        })
    }

    /// `_surface_kind`: the surfaces the chart is exact on.
    pub fn kind(&self) -> Option<&str> {
        match self.frame.kind.as_str() {
            k @ ("plane" | "cylinder" | "cone") => Some(k),
            _ => None,
        }
    }

    pub fn samples(&self, uv: &[[f64; 2]]) -> Vec<Sample> {
        let flat: Vec<f64> = uv.iter().flat_map(|p| [p[0], p[1]]).collect();
        self.face
            .surface_samples(&flat, 1e-6)
            .into_iter()
            .map(|s| Sample {
                point: t3(s.point),
                du: t3(s.du),
                dv: t3(s.dv),
                normal: s.normal.map(t3),
            })
            .collect()
    }

    pub fn x_dir(&self) -> V {
        t3(self.frame.x_dir)
    }
    pub fn y_dir(&self) -> V {
        t3(self.frame.y_dir)
    }
    pub fn z_dir(&self) -> V {
        t3(self.frame.z_dir)
    }
    pub fn origin(&self) -> V {
        t3(self.frame.origin)
    }

    /// Closed in u: a cylinder or cone whose parameter span is a full turn.
    pub fn full_turn(&self) -> bool {
        matches!(self.kind(), Some("cylinder" | "cone"))
            && ((self.frame.u_last - self.frame.u_first) - 2.0 * PI).abs() < 1e-6
    }
}

/// `_revolved_reference_radius`.
fn reference_radius(s: &Surf) -> f64 {
    if s.frame.kind == "cone" {
        let v_mid = 0.5 * (s.frame.v_first + s.frame.v_last);
        return (s.frame.radius + v_mid * mathx::sin1(s.frame.semi_angle)).abs().max(1e-9);
    }
    s.frame.radius.max(1e-9)
}

/// `_turn_mm`: the arc length of one full turn, at the reference radius and a
/// whole number of periods.
pub fn turn_mm(s: &Surf, period: f64) -> f64 {
    let circ = 2.0 * PI * reference_radius(s);
    if !(period > 0.0) {
        return circ;
    }
    ((circ / period).round_ties_even() as i64).max(1) as f64 * period
}

pub fn mean(v: impl Iterator<Item = f64>) -> f64 {
    let a: Vec<f64> = v.collect();
    pairwise_sum(&a) / a.len() as f64
}

/// `_face_uv_to_mm`.
pub fn uv_to_mm(s: &Surf, uv: &[[f64; 2]], period: f64) -> (Vec<f64>, Vec<f64>) {
    match s.kind() {
        Some("plane") => (uv.iter().map(|p| p[0]).collect(), uv.iter().map(|p| p[1]).collect()),
        Some(_) => {
            let k = turn_mm(s, period) / (2.0 * PI);
            (uv.iter().map(|p| p[0] * k).collect(), uv.iter().map(|p| p[1]).collect())
        }
        None => {
            let u0 = mean(uv.iter().map(|p| p[0]));
            let v0 = mean(uv.iter().map(|p| p[1]));
            let at = s.samples(&[[u0, v0]]);
            let (su, sv) = at
                .first()
                .map_or((1e-9, 1e-9), |a| (v3::norm(a.du).max(1e-9), v3::norm(a.dv).max(1e-9)));
            (
                uv.iter().map(|p| (p[0] - u0) * su).collect(),
                uv.iter().map(|p| (p[1] - v0) * sv).collect(),
            )
        }
    }
}

/// The axis-0 mean of rows, accumulated row by row as numpy reduces a
/// non-contiguous axis.
pub fn mean_rows(rows: &[V]) -> V {
    let mut acc = rows.first().copied().unwrap_or([0.0; 3]);
    for r in rows.iter().skip(1) {
        for k in 0..3 {
            acc[k] += r[k];
        }
    }
    let n = rows.len().max(1) as f64;
    [acc[0] / n, acc[1] / n, acc[2] / n]
}

/// `_planar_chart`: (u_mm, v_mm, t_u, t_v) for a face the chart cannot
/// measure, laid out in the plane of its mean normal.
pub fn planar_chart(pts: &[V], normals: &[V]) -> (Vec<f64>, Vec<f64>, Vec<V>, Vec<V>) {
    let axis_raw = mean_rows(normals);
    let mag = v3::norm(axis_raw);
    let axis = if mag < 1e-9 { [0.0, 0.0, 1.0] } else { v3::scale(axis_raw, 1.0 / mag) };
    let abs = [axis[0].abs(), axis[1].abs(), axis[2].abs()];
    let mut arg = 0;
    for k in 1..3 {
        if abs[k] < abs[arg] {
            arg = k;
        }
    }
    let mut seed = [0.0; 3];
    seed[arg] = 1.0;
    let mut t = v3::sub(seed, v3::scale(axis, v3::dot(seed, axis)));
    let tn = v3::norm(t).max(1e-9);
    t = v3::scale(t, 1.0 / tn);
    let b = v3::cross(axis, t);
    let c = mean_rows(pts);
    let mut u_mm = Vec::with_capacity(pts.len());
    let mut v_mm = Vec::with_capacity(pts.len());
    for p in pts {
        let d = v3::sub(*p, c);
        u_mm.push(v3::dot(d, t));
        v_mm.push(v3::dot(d, b));
    }
    let mut t_u = Vec::with_capacity(pts.len());
    let mut t_v = Vec::with_capacity(pts.len());
    for n in normals {
        let n = v3::scale(*n, 1.0 / v3::norm(*n).max(1e-12));
        let mut tu = v3::sub(t, v3::scale(n, v3::dot(n, t)));
        let tv0 = v3::sub(b, v3::scale(n, v3::dot(n, b)));
        let mut lu = v3::norm(tu);
        if lu < 1e-6 {
            tu = v3::cross(tv0, n);
            lu = v3::norm(tu);
        }
        tu = v3::scale(tu, 1.0 / lu.max(1e-12));
        t_v.push(v3::cross(n, tu));
        t_u.push(tu);
    }
    (u_mm, v_mm, t_u, t_v)
}

/// `_tp_exponent`.
pub fn tp_exponent(spec: &Spec) -> f64 {
    if spec.projection == "box" {
        let band = spec.seam_band.clamp(0.0, 1.0);
        return 4.0 + 36.0 * (1.0 - band);
    }
    let blend = spec.seam_blend.clamp(0.0, 1.0);
    1.0 + 7.0 * (1.0 - blend)
}

fn smoothstep(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// `_slope_mask`: 0..1 per vertex, none when the band is the full 0..180.
pub fn slope_mask(normals: &[V], spec: &Spec) -> Option<Vec<f64>> {
    let (lo, hi) = (spec.slope_min, spec.slope_max);
    if lo <= 1e-9 && hi >= 180.0 - 1e-9 {
        return None;
    }
    let b: f64 = 15.0f64.max(1e-3);
    let nz: Vec<f64> = normals
        .iter()
        .map(|n| (n[2] / v3::norm(*n).max(1e-12)).clamp(-1.0, 1.0))
        .collect();
    Some(
        mathx::acos(&nz)
            .into_iter()
            .map(|a| {
                let ang = a.to_degrees();
                let m_lo = smoothstep(((ang - (lo - b)) / b).clamp(0.0, 1.0));
                let m_hi = smoothstep((((hi + b) - ang) / b).clamp(0.0, 1.0));
                m_lo.min(m_hi).clamp(0.0, 1.0)
            })
            .collect(),
    )
}

/// `_tp_weights`: (|nx|, |ny|, |nz|)^k normalised to one.
pub fn tp_weights(normals: &[V], k: f64) -> Vec<V> {
    let abs: Vec<f64> = normals.iter().flat_map(|n| [n[0].abs(), n[1].abs(), n[2].abs()]).collect();
    let p = mathx::pow_scalar(&abs, k);
    p.chunks_exact(3)
        .map(|a| {
            let mut s = a[0] + a[1] + a[2];
            if s < 1e-12 {
                s = 1.0;
            }
            [a[0] / s, a[1] / s, a[2] / s]
        })
        .collect()
}

/// `_face_frame`: per vertex normal (face orientation applied) and unit
/// tangents along u and v.
pub fn face_frame(s: &Surf, uv: &[[f64; 2]], flip: bool) -> (Vec<V>, Vec<V>, Vec<V>) {
    let n = uv.len();
    let mut normals = vec![[0.0; 3]; n];
    let mut tu = vec![[0.0; 3]; n];
    let mut tv = vec![[0.0; 3]; n];
    let sign = if flip { -1.0 } else { 1.0 };
    let frame_of = |smp: &Sample| -> Option<(V, V, V)> {
        let nv = smp.normal?;
        let lu = match v3::norm(smp.du) {
            x if x == 0.0 => 1.0,
            x => x,
        };
        let lv = match v3::norm(smp.dv) {
            x if x == 0.0 => 1.0,
            x => x,
        };
        Some((v3::scale(nv, sign), v3::scale(smp.du, 1.0 / lu), v3::scale(smp.dv, 1.0 / lv)))
    };
    let kind = s.frame.kind.as_str();
    if kind == "plane" || kind == "cylinder" {
        let um = mean(uv.iter().map(|p| p[0]));
        let vm = mean(uv.iter().map(|p| p[1]));
        let got = s.samples(&[[um, vm]]).first().and_then(frame_of);
        let Some(got) = got else {
            return (normals, tu, tv);
        };
        if kind == "plane" {
            return (vec![got.0; n], vec![got.1; n], vec![got.2; n]);
        }
        let (x, y, z) = (s.x_dir(), s.y_dir(), s.z_dir());
        let n_ref = v3::add(v3::scale(x, mathx::cos1(um)), v3::scale(y, mathx::sin1(um)));
        let sg = if v3::dot(got.0, n_ref) >= 0.0 { 1.0 } else { -1.0 };
        let us: Vec<f64> = uv.iter().map(|p| p[0]).collect();
        let (cs, ss) = (mathx::cos(&us), mathx::sin(&us));
        for i in 0..uv.len() {
            let (cu, su) = (cs[i], ss[i]);
            let radial = v3::add(v3::scale(x, cu), v3::scale(y, su));
            normals[i] = v3::scale(radial, sg);
            tu[i] = v3::add(v3::scale(x, -su), v3::scale(y, cu));
            tv[i] = z;
        }
        return (normals, tu, tv);
    }
    for (i, smp) in s.samples(uv).iter().enumerate() {
        if let Some(f) = frame_of(smp) {
            normals[i] = f.0;
            tu[i] = f.1;
            tv[i] = f.2;
        }
    }
    (normals, tu, tv)
}

/// `_uncharter`: mm back to (uv, xyz) in closed form on a cylinder or cone;
/// none on a plane, whose chart is affine.
pub fn uncharter<'a>(s: &'a Surf, period: f64) -> Option<impl Fn(&[[f64; 2]]) -> (Vec<[f64; 2]>, Vec<V>) + 'a> {
    let kind = s.kind()?;
    if kind == "plane" {
        return None;
    }
    let (radius, half) = if kind == "cylinder" {
        (s.frame.radius, 0.0)
    } else {
        (s.frame.radius, s.frame.semi_angle)
    };
    let (loc, xd, yd, zd) = (s.origin(), s.x_dir(), s.y_dir(), s.z_dir());
    let (sin_a, cos_a) = (mathx::sin1(half), mathx::cos1(half));
    let per_turn = turn_mm(s, period);
    Some(move |mm: &[[f64; 2]]| {
        let mut uv = Vec::with_capacity(mm.len());
        let mut xyz = Vec::with_capacity(mm.len());
        let us: Vec<f64> = mm.iter().map(|p| p[0] * (2.0 * PI) / per_turn).collect();
        let (cs, ss) = (mathx::cos(&us), mathx::sin(&us));
        for (k, p) in mm.iter().enumerate() {
            let v = p[1];
            let u = us[k];
            let r = radius + v * sin_a;
            let (cu, su) = (cs[k], ss[k]);
            let mut q = [0.0; 3];
            for k in 0..3 {
                q[k] = loc[k] + (r * cu) * xd[k] + (r * su) * yd[k] + (v * cos_a) * zd[k];
            }
            uv.push([u, v]);
            xyz.push(q);
        }
        (uv, xyz)
    })
}
