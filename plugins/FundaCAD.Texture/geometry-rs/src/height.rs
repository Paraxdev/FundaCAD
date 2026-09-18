//! texture_height.py: the height fields a printed texture is made of. (u, v)
//! in millimetres in, a [0, 1] field out, and nothing here knows what a face or
//! a triangulation is.
//!
//! The default profile is hard surface: triangle and trapezoid waves, terraced
//! plateaus, a sharpness that shapes the facet rather than bending it.

use std::f64::consts::PI;

use crate::np::fmod;
use crate::spec::Spec;
use crate::{mathx, nearest, rng};

pub fn rotate(u: f64, v: f64, angle_deg: f64) -> (f64, f64) {
    let (ca, sa) = mathx::cos_sin_deg(angle_deg);
    (u * ca - v * sa, u * sa + v * ca)
}

fn tri_wave(x: f64, period: f64) -> f64 {
    let t = fmod(x, period) / period;
    1.0 - (2.0 * t - 1.0).abs()
}

/// `_sharpen` over a whole field at once, `h ** (1 + 4 s)` through libm.
fn sharpen_all(h: Vec<f64>, sharpness: f64) -> Vec<f64> {
    mathx::pow_scalar(&h, 1.0 + 4.0 * sharpness.clamp(0.0, 1.0))
}

fn clip01(x: f64) -> f64 {
    // np.clip keeps a NaN
    if x.is_nan() {
        x
    } else {
        x.clamp(0.0, 1.0)
    }
}

/// Triangle wave with a flat LAND of width `land` at both crest and trough.
pub fn trapezoid(x: f64, period: f64, land: f64) -> f64 {
    let t = fmod(x, period) / period;
    let tri = 1.0 - (2.0 * t - 1.0).abs();
    let k = land.clamp(0.0, 0.98);
    if k <= 1e-9 {
        return tri;
    }
    clip01((tri - k * 0.5) / (1.0 - k).max(1e-9))
}

fn terrace(h: f64, steps: i64) -> f64 {
    let n = steps.max(2) as f64;
    let q = (clip01(h) * n).floor().min(n - 1.0);
    q / (n - 1.0)
}

fn steps_from(sharpness: f64) -> i64 {
    (2.0 + sharpness.clamp(0.0, 1.0) * 10.0).round_ties_even() as i64
}

/// Knurl before any sharpening: the facet itself, or the round product.
fn knurl(u: f64, v: f64, scale: f64, angle: f64, sharp: f64, facet: bool) -> f64 {
    let (_, v1) = rotate(u, v, angle);
    let (_, v2) = rotate(u, v, angle + 90.0);
    if facet {
        return trapezoid(v1, scale, sharp).min(trapezoid(v2, scale, sharp));
    }
    tri_wave(v1, scale) * tri_wave(v2, scale)
}

pub fn hex_dirs() -> [[f64; 2]; 6] {
    let mut d = [[0.0; 2]; 6];
    for (k, e) in d.iter_mut().enumerate() {
        let (c, s) = mathx::cos_sin_deg(60.0 * k as f64);
        *e = [c, s];
    }
    d
}

pub fn hex_corners() -> [[f64; 2]; 6] {
    let mut d = [[0.0; 2]; 6];
    for (k, e) in d.iter_mut().enumerate() {
        let (c, s) = mathx::cos_sin_deg(30.0 + 60.0 * k as f64);
        *e = [c, s];
    }
    d
}

pub fn hex_wall_width(scale: f64, sharpness: f64) -> f64 {
    let s = sharpness.clamp(0.0, 1.0);
    (0.14 + 0.31 * (1.0 - s)) * (scale * 0.5)
}

fn hex_nearest_site(u: f64, v: f64, a: f64) -> (f64, f64) {
    let root3 = 3f64.sqrt();
    let jf = v / (a * root3 * 0.5);
    let i_f = u / a - jf * 0.5;
    let (i0, j0) = (i_f.floor(), jf.floor());
    let mut best: Option<(f64, f64, f64)> = None;
    for di in [0.0, 1.0] {
        for dj in [0.0, 1.0] {
            let sx = (i0 + di) * a + (j0 + dj) * a * 0.5;
            let sy = (j0 + dj) * a * root3 * 0.5;
            let d2 = (u - sx).powi(2) + (v - sy).powi(2);
            match best {
                Some((_, _, bd)) if !(d2 < bd) => {}
                _ => best = Some((sx, sy, d2)),
            }
        }
    }
    let b = best.expect("four candidates");
    (b.0, b.1)
}

/// The round hex: a three direction cosine interference sum.
fn hex_round(u: &[f64], v: &[f64], scale: f64) -> Vec<f64> {
    let root3 = 3f64.sqrt();
    let a = mathx::cos(&u.iter().map(|&x| 2.0 * PI * x / scale).collect::<Vec<_>>());
    let b = mathx::cos(
        &u.iter()
            .zip(v)
            .map(|(&x, &y)| 2.0 * PI * (x * 0.5 - y * root3 * 0.5) / scale)
            .collect::<Vec<_>>(),
    );
    let c = mathx::cos(
        &u.iter()
            .zip(v)
            .map(|(&x, &y)| 2.0 * PI * (x * 0.5 + y * root3 * 0.5) / scale)
            .collect::<Vec<_>>(),
    );
    (0..u.len()).map(|i| clip01((a[i] + b[i] + c[i]) / 3.0 * 0.5 + 0.5)).collect()
}

fn hex(u: f64, v: f64, scale: f64, sharp: f64) -> f64 {
    let (sx, sy) = hex_nearest_site(u, v, scale);
    let (du, dv) = (u - sx, v - sy);
    let d_edge = hex_dirs()
        .iter()
        .map(|d| scale * 0.5 - (du * d[0] + dv * d[1]))
        .fold(f64::INFINITY, |m, x| if x < m || x.is_nan() { x } else { m });
    clip01(d_edge / hex_wall_width(scale, sharp).max(1e-9))
}

const WAVE_JOINS: usize = 8;

pub fn wave_levels() -> [f64; WAVE_JOINS] {
    thread_local! {
        static LEVELS: std::cell::OnceCell<[f64; WAVE_JOINS]> = const { std::cell::OnceCell::new() };
    }
    LEVELS.with(|l| {
        *l.get_or_init(|| {
            let args: Vec<f64> = (0..WAVE_JOINS).map(|i| 2.0 * PI * i as f64 / WAVE_JOINS as f64).collect();
            let s = mathx::sin(&args);
            let mut out = [0.0; WAVE_JOINS];
            for (o, x) in out.iter_mut().zip(s) {
                *o = 0.5 + 0.5 * x;
            }
            out
        })
    })
}

pub fn wave_phases() -> Vec<f64> {
    let lv = wave_levels();
    let n = WAVE_JOINS;
    let d: Vec<f64> = (0..n).map(|i| lv[(i + 1) % n] - lv[i]).collect();
    (0..n)
        .filter(|&i| (d[(i + n - 1) % n] - d[i]).abs() > 1e-12)
        .map(|i| i as f64 / n as f64)
        .collect()
}

fn facet_wave(x: f64, period: f64) -> f64 {
    let lv = wave_levels();
    let n = WAVE_JOINS as f64;
    let t = fmod(x, period) / period * n;
    let i = t.floor();
    let f = t - i;
    let i = (fmod(i, n)) as usize % WAVE_JOINS;
    let lo = lv[i];
    lo + (lv[(i + 1) % WAVE_JOINS] - lo) * f
}

/// `0.5 + 0.5 sin(2 pi u1 / scale)` over the field, the round wave and the
/// round stripe before sharpening.
fn sine_bands(u: &[f64], v: &[f64], scale: f64, angle: f64) -> Vec<f64> {
    let args: Vec<f64> = u
        .iter()
        .zip(v)
        .map(|(&a, &b)| 2.0 * PI * rotate(a, b, angle).0 / scale)
        .collect();
    mathx::sin(&args).into_iter().map(|s| 0.5 + 0.5 * s).collect()
}

fn waves(u: f64, v: f64, scale: f64, angle: f64) -> f64 {
    facet_wave(rotate(u, v, angle).0, scale)
}

/// Ribs before sharpening: the facet, or the round triangle wave.
fn ribs(u: f64, v: f64, scale: f64, angle: f64, sharp: f64, facet: bool) -> f64 {
    let (u1, _) = rotate(u, v, angle);
    if facet {
        return trapezoid(u1, scale, sharp);
    }
    tri_wave(u1, scale)
}

/// `_hash01`: a [0, 1) value from a cell index, int64 wrapping as numpy's.
pub fn hash01(i: i64, j: i64, seed: i64, salt: i64) -> f64 {
    let mut h = i.wrapping_mul(73_856_093)
        ^ j.wrapping_mul(19_349_663)
        ^ seed.wrapping_mul(83_492_791)
        ^ salt.wrapping_mul(2_971_215_073);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    (h & 0xFF_FFFF) as f64 / f64::from(0x100_0000)
}

fn voronoi_sites(scale: f64, seed: i64, lo_u: f64, hi_u: f64, lo_v: f64, hi_v: f64) -> Vec<[f64; 2]> {
    let i0 = (lo_u / scale).floor() as i64 - 1;
    let i1 = (hi_u / scale).ceil() as i64 + 1;
    let j0 = (lo_v / scale).floor() as i64 - 1;
    let j1 = (hi_v / scale).ceil() as i64 + 1;
    let mut out = Vec::new();
    for i in i0..=i1 {
        for j in j0..=j1 {
            let ju = 0.2 + 0.6 * hash01(i, j, seed, 1);
            let jv = 0.2 + 0.6 * hash01(i, j, seed, 2);
            out.push([(i as f64 + ju) * scale, (j as f64 + jv) * scale]);
        }
    }
    out
}

fn voronoi(u: &[f64], v: &[f64], scale: f64, seed: i64, sharp: f64, facet: bool) -> Vec<f64> {
    if u.is_empty() {
        return Vec::new();
    }
    let (ulo, uhi) = crate::np::min_max(u.iter().copied());
    let (vlo, vhi) = crate::np::min_max(v.iter().copied());
    let sites = voronoi_sites(scale, seed, ulo - 3.0 * scale, uhi + 3.0 * scale, vlo - 3.0 * scale, vhi + 3.0 * scale);
    let tree = nearest::Tree::new(sites.iter().map(|s| vec![s[0], s[1]]).collect());
    let k = 0.15 + 0.45 * (1.0 - sharp.clamp(0.0, 1.0));
    u.iter()
        .zip(v)
        .map(|(&a, &b)| {
            let d = tree.nearest(&[a, b]);
            let h = clip01(d / (scale * 0.5));
            if facet {
                clip01(h / k.max(1e-9))
            } else {
                h
            }
        })
        .collect()
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + t * (b - a)
}

fn grad(h: i64, gx: f64, gy: f64) -> f64 {
    let h = h & 3;
    let sx = if h & 1 == 0 { 1.0 } else { -1.0 };
    let sy = if h & 2 == 0 { 1.0 } else { -1.0 };
    sx * gx + sy * gy
}

fn perlin2(x: f64, y: f64, perm: &[i64]) -> f64 {
    let xi = (x.floor() as i64) & 255;
    let yi = (y.floor() as i64) & 255;
    let xf = x - x.floor();
    let yf = y - y.floor();
    let u = xf * xf * xf * (xf * (xf * 6.0 - 15.0) + 10.0);
    let v = yf * yf * yf * (yf * (yf * 6.0 - 15.0) + 10.0);
    let p = |i: i64| perm[i as usize];
    let aa = p(p(xi) + yi);
    let ba = p(p(xi + 1) + yi);
    let ab = p(p(xi) + yi + 1);
    let bb = p(p(xi + 1) + yi + 1);
    let x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u);
    let x2 = lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u);
    lerp(x1, x2, v)
}

fn noise(u: &[f64], v: &[f64], scale: f64, seed: i64, octaves: i64) -> Result<Vec<f64>, String> {
    if seed < 0 {
        return Err("expected non-negative integer".into());
    }
    let p = rng::permutation(seed as u64, 256);
    let perm: Vec<i64> = p.iter().chain(p.iter()).copied().collect();
    let mut out = Vec::with_capacity(u.len());
    for (&a, &b) in u.iter().zip(v) {
        let mut total = 0.0;
        let (mut amp, mut freq, mut max_amp) = (1.0, 1.0, 0.0);
        for _ in 0..octaves.max(0) {
            total += amp * perlin2(a / scale * freq, b / scale * freq, &perm);
            max_amp += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        out.push(clip01((total / max_amp) * 0.5 + 0.5));
    }
    Ok(out)
}

fn ridge(x: f64, period: f64, width: f64) -> f64 {
    let t = fmod(x, period) / period;
    let d = t.min(1.0 - t) * 2.0;
    clip01(1.0 - d / width.max(1e-6))
}

fn ridge_width(sharpness: f64) -> f64 {
    0.2 + 0.5 * (1.0 - sharpness.clamp(0.0, 1.0))
}

fn smooth01(h: f64) -> f64 {
    let h = clip01(h);
    h * h * (3.0 - 2.0 * h)
}

fn stripes(u: f64, v: f64, scale: f64, angle: f64, sharp: f64) -> f64 {
    trapezoid(rotate(u, v, angle).0, scale, sharp.max(0.6))
}

fn grid(u: f64, v: f64, scale: f64, angle: f64, sharp: f64, facet: bool) -> f64 {
    let (u1, v1) = rotate(u, v, angle);
    let w = ridge_width(sharp);
    let h = ridge(u1, scale, w).max(ridge(v1, scale, w));
    if facet {
        h
    } else {
        smooth01(h)
    }
}

fn dots(u: f64, v: f64, scale: f64, angle: f64, sharp: f64, facet: bool) -> f64 {
    let (u1, v1) = rotate(u, v, angle);
    let du = fmod(u1 / scale + 0.5, 1.0) - 0.5;
    let dv = fmod(v1 / scale + 0.5, 1.0) - 0.5;
    let r = (du * du + dv * dv).sqrt() * 2.0;
    let radius = 0.5 + 0.45 * (1.0 - sharp.clamp(0.0, 1.0));
    let h = clip01(1.0 - r / radius.max(1e-6));
    if facet {
        h
    } else {
        smooth01(h)
    }
}

fn brick(u: f64, v: f64, scale: f64, angle: f64, sharp: f64, facet: bool) -> f64 {
    let (u1, v1) = rotate(u, v, angle);
    let (bw, bh) = (scale * 2.0, scale);
    let row = (v1 / bh).floor();
    let uoff = u1 + fmod(row, 2.0) * bw * 0.5;
    let mortar = scale * (0.10 + 0.18 * (1.0 - sharp.clamp(0.0, 1.0)));
    let dv = fmod(v1, bh).min(bh - fmod(v1, bh));
    let du = fmod(uoff, bw).min(bw - fmod(uoff, bw));
    let h = clip01(du.min(dv) / mortar.max(1e-6));
    if facet {
        h
    } else {
        smooth01(h)
    }
}

fn strands(u1: f64, v1: f64, scale: f64) -> (f64, f64) {
    (
        1.0 - (fmod(u1 / scale, 1.0) - 0.5).abs() * 2.0,
        1.0 - (fmod(v1 / scale, 1.0) - 0.5).abs() * 2.0,
    )
}

fn basket(u: f64, v: f64, scale: f64, angle: f64, facet: bool) -> f64 {
    let (u1, v1) = rotate(u, v, angle);
    let ci = (u1 / scale).floor();
    let cj = (v1 / scale).floor();
    let horiz = fmod(ci + cj, 2.0) < 1.0;
    let (su, sv) = strands(u1, v1, scale);
    let h = if horiz { sv } else { su };
    if facet {
        h
    } else {
        smooth01(h)
    }
}

fn carbon(u: f64, v: f64, scale: f64, angle: f64, facet: bool) -> f64 {
    let (u1, v1) = rotate(u, v, angle);
    let ci = (u1 / scale).floor();
    let cj = (v1 / scale).floor();
    let over = fmod((ci - cj).floor(), 4.0) < 2.0;
    let (su, sv) = strands(u1, v1, scale);
    let h = if over { sv } else { su };
    if facet {
        h
    } else {
        smooth01(h)
    }
}

fn isogrid(u: f64, v: f64, scale: f64, angle: f64, sharp: f64, facet: bool) -> f64 {
    let w = ridge_width(sharp);
    let mut h: Option<f64> = None;
    for a in [0.0, 60.0, 120.0] {
        let (ua, _) = rotate(u, v, angle + a);
        let r = ridge(ua, scale, w);
        h = Some(match h {
            None => r,
            Some(m) => m.max(r),
        });
    }
    let h = h.unwrap_or(0.0);
    if facet {
        h
    } else {
        smooth01(h)
    }
}

fn grip(u: f64, v: f64, scale: f64, angle: f64, sharp: f64, facet: bool) -> f64 {
    let (u1, v1) = rotate(u, v, angle);
    let zig = (1.0 - (fmod(v1 / (scale * 2.0), 1.0) * 2.0 - 1.0).abs()) * scale;
    let x = u1 + zig;
    if facet {
        return trapezoid(x, scale, sharp);
    }
    tri_wave(x, scale)
}

fn leather(u: &[f64], v: &[f64], scale: f64, seed: i64, octaves: i64, facet: bool) -> Result<Vec<f64>, String> {
    let coarse = noise(u, v, scale, seed, octaves.max(3))?;
    let fine = noise(u, v, scale * 0.4, seed + 7, 3)?;
    Ok(coarse
        .iter()
        .zip(&fine)
        .map(|(c, f)| {
            let h = clip01(0.6 * c + 0.4 * f);
            if facet {
                terrace(h, steps_from(0.6))
            } else {
                h
            }
        })
        .collect())
}

/// The image a heightmap texture reads, as L (0..255) rows, top row first.
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub px: Vec<f64>,
}

fn image(u: &[f64], v: &[f64], img: &Gray, ur: (f64, f64), vr: (f64, f64)) -> Vec<f64> {
    let (w, h) = (img.w as i64, img.h as i64);
    let at = |y: i64, x: i64| img.px[(y * w + x) as usize];
    u.iter()
        .zip(v)
        .map(|(&a, &b)| {
            let uu = clip01((a - ur.0) / (ur.1 - ur.0).max(1e-9));
            let vv = clip01((b - vr.0) / (vr.1 - vr.0).max(1e-9));
            let fx = uu * (w - 1) as f64;
            let fy = (1.0 - vv) * (h - 1) as f64;
            let x0 = fx.floor() as i64;
            let x1 = (x0 + 1).clamp(0, w - 1);
            let y0 = fy.floor() as i64;
            let y1 = (y0 + 1).clamp(0, h - 1);
            let tx = fx - x0 as f64;
            let ty = fy - y0 as f64;
            let top = at(y0, x0) * (1.0 - tx) + at(y0, x1) * tx;
            let bot = at(y1, x0) * (1.0 - tx) + at(y1, x1) * tx;
            top * (1.0 - ty) + bot * ty
        })
        .collect()
}

/// `height_field`: the [0, 1] field of `kind` at every (u, v).
pub fn height_field(
    kind: &str,
    spec: &Spec,
    u: &[f64],
    v: &[f64],
    ur: Option<(f64, f64)>,
    vr: Option<(f64, f64)>,
) -> Result<Vec<f64>, String> {
    let scale = spec.scale.max(0.05);
    let (angle, sharp, facet) = (spec.angle, spec.sharpness, spec.facet());
    let per = |f: &dyn Fn(f64, f64) -> f64| -> Vec<f64> { u.iter().zip(v).map(|(&a, &b)| f(a, b)).collect() };
    let sharpened = |h: Vec<f64>| if facet { h } else { sharpen_all(h, sharp) };
    Ok(match kind {
        "knurl" => sharpened(per(&|a, b| knurl(a, b, scale, angle, sharp, facet))),
        "hex" if facet => per(&|a, b| hex(a, b, scale, sharp)),
        "hex" => hex_round(u, v, scale),
        "waves" if facet => per(&|a, b| waves(a, b, scale, angle)),
        "waves" => sharpen_all(sine_bands(u, v, scale, angle), sharp),
        "ribs" => sharpened(per(&|a, b| ribs(a, b, scale, angle, sharp, facet))),
        "voronoi" => voronoi(u, v, scale, spec.seed, sharp, facet),
        "stripes" if facet => per(&|a, b| stripes(a, b, scale, angle, sharp)),
        "stripes" => sharpen_all(sine_bands(u, v, scale, angle), sharp),
        "grid" => per(&|a, b| grid(a, b, scale, angle, sharp, facet)),
        "dots" => per(&|a, b| dots(a, b, scale, angle, sharp, facet)),
        "brick" => per(&|a, b| brick(a, b, scale, angle, sharp, facet)),
        "basket" => per(&|a, b| basket(a, b, scale, angle, facet)),
        "carbon" => per(&|a, b| carbon(a, b, scale, angle, facet)),
        "isogrid" => per(&|a, b| isogrid(a, b, scale, angle, sharp, facet)),
        "grip" => sharpened(per(&|a, b| grip(a, b, scale, angle, sharp, facet))),
        "leather" => leather(u, v, scale, spec.seed, spec.octaves, facet)?,
        "noise" => {
            let h = noise(u, v, scale, spec.seed, spec.octaves)?;
            if facet {
                let n = steps_from(sharp);
                h.into_iter().map(|x| terrace(x, n)).collect()
            } else {
                h
            }
        }
        "image" => {
            let img = spec.image.as_ref().ok_or("the texture image did not load")?;
            let h = image(u, v, img, ur.unwrap_or((0.0, 1.0)), vr.unwrap_or((0.0, 1.0)));
            if facet {
                let n = steps_from(sharp);
                h.into_iter().map(|x| terrace(x, n)).collect()
            } else {
                h
            }
        }
        other => return Err(format!("unknown texture kind: {other}")),
    })
}

fn smooth_taps() -> ([[f64; 2]; 9], [f64; 9]) {
    let mut taps = [[0.0; 2]; 9];
    let mut arg = [0.0; 9];
    let mut k = 0;
    for dy in [-1.0f64, 0.0, 1.0] {
        for dx in [-1.0f64, 0.0, 1.0] {
            taps[k] = [dx, dy];
            arg[k] = -0.5 * (dx * dx + dy * dy);
            k += 1;
        }
    }
    let mut w = [0.0; 9];
    w.copy_from_slice(&mathx::exp(&arg));
    let s: f64 = pairwise_sum(&w);
    for x in w.iter_mut() {
        *x /= s;
    }
    (taps, w)
}

/// numpy's `add.reduce` of a 1-D array: pairwise, eight accumulators per
/// block of up to 128, halves above that. Checked against `np.sum` on 3,000
/// random arrays of mixed magnitude.
pub fn pairwise_sum(a: &[f64]) -> f64 {
    let n = a.len();
    if n < 8 {
        let mut res = -0.0;
        for &x in a {
            res += x;
        }
        return res;
    }
    if n <= 128 {
        let mut r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
        let mut i = 8;
        while i < n - n % 8 {
            for k in 0..8 {
                r[k] += a[i + k];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            res += a[i];
            i += 1;
        }
        return res;
    }
    let mut n2 = n / 2;
    n2 -= n2 % 8;
    pairwise_sum(&a[..n2]) + pairwise_sum(&a[n2..])
}

fn smooth_radius(spec: &Spec) -> f64 {
    spec.smooth.clamp(0.0, 1.0) * spec.scale.max(0.05) * 0.5
}

/// `height_field_smoothed`: the field Gaussian-averaged over a 3x3 stencil of
/// mm offsets when `smooth` is on, verbatim otherwise.
pub fn height_field_smoothed(
    kind: &str,
    spec: &Spec,
    u: &[f64],
    v: &[f64],
    ur: Option<(f64, f64)>,
    vr: Option<(f64, f64)>,
) -> Result<Vec<f64>, String> {
    let r = smooth_radius(spec);
    if r <= 0.0 {
        return height_field(kind, spec, u, v, ur, vr);
    }
    let (taps, w) = smooth_taps();
    let mut acc = vec![0.0; u.len()];
    for (t, wt) in taps.iter().zip(w) {
        let uu: Vec<f64> = u.iter().map(|x| x + t[0] * r).collect();
        let vv: Vec<f64> = v.iter().map(|x| x + t[1] * r).collect();
        let h = height_field(kind, spec, &uu, &vv, ur, vr)?;
        for (a, x) in acc.iter_mut().zip(h) {
            *a += wt * x;
        }
    }
    Ok(acc.into_iter().map(clip01).collect())
}

/// `triplanar_field`: the pattern sampled in the three world planes, blended
/// per vertex by `w`.
pub fn triplanar_field(
    kind: &str,
    spec: &Spec,
    p: &[[f64; 3]],
    w: &[[f64; 3]],
    offset: f64,
) -> Result<Vec<f64>, String> {
    let col = |k: usize, add: f64| -> Vec<f64> { p.iter().map(|q| q[k] + add).collect() };
    let hx = height_field_smoothed(kind, spec, &col(1, offset), &col(2, 0.0), None, None)?;
    let hy = height_field_smoothed(kind, spec, &col(2, offset), &col(0, 0.0), None, None)?;
    let hz = height_field_smoothed(kind, spec, &col(0, offset), &col(1, 0.0), None, None)?;
    Ok((0..p.len())
        .map(|i| w[i][0] * hx[i] + w[i][1] * hy[i] + w[i][2] * hz[i])
        .collect())
}

/// `_u_period`: the pattern's period along u, what a full turn has to be a
/// whole number of; 0 for no constraint.
pub fn u_period(spec: &Spec, scale: f64) -> f64 {
    if spec.kind != "ribs" && spec.kind != "waves" {
        return scale;
    }
    let c = mathx::cos_sin_deg(spec.angle).0.abs();
    if c > 1e-6 {
        scale / c
    } else {
        0.0
    }
}
