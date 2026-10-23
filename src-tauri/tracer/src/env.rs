//! The environment map the tracer is lit by: a half float RGBA equirect and
//! the CDFs a light sample picks its texels by.

use std::f32::consts::PI;

use serde::Deserialize;

/// Which world axis the image's rows run along, and so how a texel maps to a
/// direction (tests/fixtures/env_directions.json pins both).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Up {
    /// The room equirect traceEnvironment reads back: row 0 at -Y,
    /// azimuth (u - 0.5) 2 pi from +X towards +Z.
    #[default]
    Y,
    /// An imported HDR as hdrRoom places it: row 0 at +Z, azimuth -2 pi u
    /// from +X, the rotation already shifted into the columns.
    Z,
}

impl Up {
    pub(crate) fn code(self) -> u32 {
        match self {
            Up::Y => 1,
            Up::Z => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Environment {
    pub key: String,
    pub width: u32,
    pub height: u32,
    pub up: Up,
    /// Half float bits, RGBA, row 0 first.
    pub rgba: Vec<u16>,
}

/// Two header vec4s, then the marginal CDF over rows, then each row's conditional CDF, 4 floats per vec4. Header 0:
/// width, height, marginal offset, conditional offset, in floats. Header 1: the mean radiance's luminance over the
/// sphere, the first free vec4 (where a later table starts), the luminance irradiance on a face looking up +Z.
pub const HEADER_VEC4S: usize = 2;

pub fn f16_to_f32(h: u16) -> f32 {
    let s = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = ((h >> 10) & 0x1f) as i32;
    let m = (h & 0x3ff) as f32;
    match e {
        0 => s * m * 2f32.powi(-24),
        31 => {
            if m == 0.0 {
                s * f32::INFINITY
            } else {
                f32::NAN
            }
        }
        _ => s * (1.0 + m / 1024.0) * 2f32.powi(e - 15),
    }
}

/// Round to nearest, for tests and synthetic maps.
pub fn f32_to_f16(v: f32) -> u16 {
    let b = v.to_bits();
    let s = ((b >> 16) & 0x8000) as u16;
    let e = ((b >> 23) & 0xff) as i32 - 127 + 15;
    let m = b & 0x7f_ffff;
    if v.is_nan() {
        return 0x7e00;
    }
    if e >= 31 {
        return s | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return s;
        }
        let m = (m | 0x80_0000) >> (1 - e);
        return s | ((m + 0x1000) >> 13) as u16;
    }
    let r = ((e as u32) << 10 | m >> 13) + ((m >> 12) & 1);
    s | r as u16
}

fn luminance(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

impl Environment {
    /// An image from linear RGB, row 0 first.
    pub fn from_rgb(key: &str, width: u32, height: u32, up: Up, f: impl Fn(u32, u32) -> [f32; 3]) -> Environment {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height {
            for col in 0..width {
                let c = f(col, row);
                rgba.extend([f32_to_f16(c[0]), f32_to_f16(c[1]), f32_to_f16(c[2]), f32_to_f16(1.0)]);
            }
        }
        Environment { key: key.into(), width, height, up, rgba }
    }

    /// The bytes `tables` takes for this size, about one float per texel.
    pub fn table_bytes(width: u32, height: u32) -> u64 {
        (HEADER_VEC4S as u64 * 4 + height as u64 + width as u64 * height as u64 + 3) * 4
    }

    /// Halved with a 2 x 2 box until both sides fit `max_side` and the sampling tables fit `max_table_bytes`, so a
    /// map past what the device binds is kept smaller instead of failing. The box keeps a small sun's light.
    pub fn fit(self, max_side: u32, max_table_bytes: u64) -> Environment {
        let mut e = self;
        while e.width > 1
            && e.height > 1
            && (e.width > max_side || e.height > max_side || Self::table_bytes(e.width, e.height) > max_table_bytes)
        {
            let (w, h) = (e.width / 2, e.height / 2);
            let mut rgba = Vec::with_capacity((w * h * 4) as usize);
            for r in 0..h {
                for c in 0..w {
                    let mut sum = [0f32; 3];
                    for (dc, dr) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        let t = e.texel(c * 2 + dc, r * 2 + dr);
                        for k in 0..3 {
                            sum[k] += t[k] * 0.25;
                        }
                    }
                    rgba.extend([f32_to_f16(sum[0]), f32_to_f16(sum[1]), f32_to_f16(sum[2]), f32_to_f16(1.0)]);
                }
            }
            e = Environment { key: e.key, width: w, height: h, up: e.up, rgba };
        }
        e
    }

    pub fn texel(&self, col: u32, row: u32) -> [f32; 3] {
        let i = ((row * self.width + col) * 4) as usize;
        [0, 1, 2].map(|k| f16_to_f32(self.rgba[i + k]).max(0.0))
    }

    /// Polar angle from the image's pole of row 0 at v (0 at row 0's edge).
    fn row_theta(&self, row: u32) -> f32 {
        PI * (row as f32 + 0.5) / self.height as f32
    }

    /// The light sample tables, see HEADER_VEC4S.
    pub fn tables(&self) -> Vec<[f32; 4]> {
        let (w, h) = (self.width as usize, self.height as usize);
        let marginal = HEADER_VEC4S * 4;
        let conditional = marginal + h;
        let mut f = vec![0f32; conditional + w * h];
        let mut rows = vec![0f64; h];
        let mut radiance = 0f64;
        let mut up = 0f64;
        for r in 0..h {
            let sin = self.row_theta(r as u32).sin() as f64;
            let mut acc = 0f64;
            let mut lums = vec![0f64; w];
            for c in 0..w {
                let l = luminance(self.texel(c as u32, r as u32)).max(0.0) as f64;
                radiance += l * sin;
                let z = direction(self.up, (c as f32 + 0.5) / w as f32, (r as f32 + 0.5) / h as f32)[2].max(0.0) as f64;
                up += l * z * sin;
                lums[c] = l;
                acc += l;
            }
            // A black row gets uniform columns so a search never divides by 0.
            let mut run = 0f64;
            for c in 0..w {
                run += if acc > 0.0 { lums[c] } else { 1.0 };
                f[conditional + r * w + c] = (run / if acc > 0.0 { acc } else { w as f64 }) as f32;
            }
            f[conditional + r * w + w - 1] = 1.0;
            rows[r] = acc * sin;
        }
        let total: f64 = rows.iter().sum();
        let mut run = 0f64;
        for r in 0..h {
            run += if total > 0.0 { rows[r] } else { 1.0 };
            f[marginal + r] = (run / if total > 0.0 { total } else { h as f64 }) as f32;
        }
        f[marginal + h - 1] = 1.0;
        // Mean over the sphere: sum of L sin dtheta dphi over 4 pi.
        let texel = (2.0 * PI as f64 / w as f64) * (PI as f64 / h as f64);
        let mean = radiance * texel / (4.0 * PI as f64);
        let n = f.len().div_ceil(4);
        f.resize(n * 4, 0.0);
        f[0] = w as f32;
        f[1] = h as f32;
        f[2] = marginal as f32;
        f[3] = conditional as f32;
        f[4] = mean as f32;
        f[5] = n as f32;
        f[6] = (up * texel) as f32;
        f.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect()
    }
}

/// The world direction lit from image coordinates (u, v), v in rows from row 0.
pub fn direction(up: Up, u: f32, v: f32) -> [f32; 3] {
    match up {
        Up::Y => {
            let p = (1.0 - v) * PI;
            let t = (u - 0.5) * 2.0 * PI;
            [p.sin() * t.cos(), p.cos(), p.sin() * t.sin()]
        }
        Up::Z => {
            let th = v * PI;
            let az = -2.0 * PI * u;
            [th.sin() * az.cos(), th.sin() * az.sin(), th.cos()]
        }
    }
}

/// The inverse of `direction`, u in [0, 1).
pub fn uv(up: Up, d: [f32; 3]) -> (f32, f32) {
    let fract = |x: f32| x - x.floor();
    match up {
        Up::Y => (fract(d[2].atan2(d[0]) / (2.0 * PI) + 0.5), 1.0 - d[1].clamp(-1.0, 1.0).acos() / PI),
        Up::Z => (fract((-d[1]).atan2(d[0]) / (2.0 * PI)), d[2].clamp(-1.0, 1.0).acos() / PI),
    }
}

/// What trace.wgsl does with the tables, on the CPU for the tests.
pub struct Sampler<'a> {
    pub up: Up,
    pub t: &'a [[f32; 4]],
}

impl Sampler<'_> {
    fn at(&self, i: usize) -> f32 {
        self.t[i / 4][i % 4]
    }
    fn dims(&self) -> (usize, usize, usize, usize) {
        let h = self.t[0];
        (h[0] as usize, h[1] as usize, h[2] as usize, h[3] as usize)
    }
    fn step(&self, base: usize, i: usize) -> f32 {
        self.at(base + i) - if i == 0 { 0.0 } else { self.at(base + i - 1) }
    }
    /// The first entry of n at base over r.
    fn search(&self, base: usize, n: usize, r: f32) -> usize {
        let (mut lo, mut hi) = (0, n - 1);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.at(base + mid) > r {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        lo
    }
    /// The solid angle pdf a light sample picks d with.
    pub fn pdf(&self, d: [f32; 3]) -> f32 {
        let (w, h, m, c) = self.dims();
        let (u, v) = uv(self.up, d);
        let col = ((u * w as f32) as usize).min(w - 1);
        let row = ((v * h as f32) as usize).min(h - 1);
        let p = self.step(m, row) * self.step(c + row * w, col) * (w * h) as f32;
        let sin = (v * PI).sin();
        if sin <= 0.0 {
            return 0.0;
        }
        p / (2.0 * PI * PI * sin)
    }
    /// A direction from four uniform numbers, with its texel.
    pub fn sample(&self, r: [f32; 4]) -> ([f32; 3], (usize, usize)) {
        let (w, h, m, c) = self.dims();
        let row = self.search(m, h, r[0]);
        let col = self.search(c + row * w, w, r[1]);
        let u = (col as f32 + r[2]) / w as f32;
        let v = (row as f32 + r[3]) / h as f32;
        (direction(self.up, u, v), (col, row))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> f32 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 40) as f32) / (1u64 << 24) as f32
    }

    #[test]
    fn fit_halves_a_map_past_the_device_and_keeps_its_light() {
        let (w, h) = (4096u32, 2048u32);
        let e = Environment::from_rgb("big", w, h, Up::Z, |c, r| {
            if (c / 8, r / 8) == (150, 75) {
                [5000.0; 3]
            } else {
                [if r < h / 2 { 1.0 } else { 0.25 }; 3]
            }
        });
        let mean = |e: &Environment| e.tables()[1][0];
        let before = mean(&e);
        let side = e.clone().fit(2048, u64::MAX);
        assert_eq!((side.width, side.height), (2048, 1024));
        let small = e.fit(2048, Environment::table_bytes(1024, 512));
        assert_eq!((small.width, small.height), (1024, 512));
        assert_eq!(small.rgba.len(), 1024 * 512 * 4);
        assert!((mean(&small) / before - 1.0).abs() < 0.01, "{} against {before}", mean(&small));
    }

    #[test]
    fn fit_leaves_a_map_that_fits() {
        let e = Environment::from_rgb("s", 64, 32, Up::Y, |_, _| [1.0; 3]);
        assert_eq!(e.clone().fit(8192, u64::MAX), e);
    }

    #[test]
    fn samples_follow_luminance() {
        let (w, h) = (16u32, 8u32);
        let e = Environment::from_rgb("h", w, h, Up::Z, |c, r| [if (c, r) == (5, 2) { 100.0 } else { 1.0 }; 3]);
        let t = e.tables();
        let smp = Sampler { up: Up::Z, t: &t };
        let n = 1_000_000;
        let mut hist = vec![0u32; (w * h) as usize];
        let mut s = 11u64;
        for _ in 0..n {
            let (d, _) = smp.sample([rng(&mut s), rng(&mut s), rng(&mut s), rng(&mut s)]);
            let (u, v) = uv(Up::Z, d);
            let col = ((u * w as f32) as u32).min(w - 1);
            let row = ((v * h as f32) as u32).min(h - 1);
            hist[(row * w + col) as usize] += 1;
        }
        let weight = |c: u32, r: u32| luminance(e.texel(c, r)) * e.row_theta(r).sin();
        let total: f32 = (0..h).flat_map(|r| (0..w).map(move |c| (c, r))).map(|(c, r)| weight(c, r)).sum();
        for r in 0..h {
            for c in 0..w {
                let p = (weight(c, r) / total) as f64;
                let want = p * n as f64;
                let sigma = (n as f64 * p * (1.0 - p)).sqrt();
                let got = hist[(r * w + c) as usize] as f64;
                assert!((got - want).abs() <= 3.0 * sigma + 1.0, "texel {c},{r}: {got} against {want} +- {sigma}");
            }
        }
    }
}
