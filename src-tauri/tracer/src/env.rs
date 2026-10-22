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
    fn halves_round_trip() {
        for v in [0.0, 1.0, 0.5, 2.0, 100.0, 0.001, 1e-6, 65504.0, 0.333] {
            let back = f16_to_f32(f32_to_f16(v));
            assert!((back - v).abs() <= v * 1e-3 + 1e-7, "{v} -> {back}");
        }
    }

    #[test]
    fn the_pdf_integrates_to_one() {
        for up in [Up::Y, Up::Z] {
            let mut s = 7u64;
            let vals: Vec<f32> = (0..64 * 32).map(|_| rng(&mut s) * 4.0 + 0.01).collect();
            let e = Environment::from_rgb("r", 64, 32, up, |c, r| [vals[(r * 64 + c) as usize]; 3]);
            let t = e.tables();
            let smp = Sampler { up, t: &t };
            let mut sum = 0f64;
            for row in 0..32 {
                for col in 0..64 {
                    let (u, v) = ((col as f32 + 0.5) / 64.0, (row as f32 + 0.5) / 32.0);
                    let omega = 2.0 * PI / 64.0 * PI / 32.0 * (v * PI).sin();
                    sum += (smp.pdf(direction(up, u, v)) * omega) as f64;
                }
            }
            assert!((sum - 1.0).abs() < 1e-3, "{up:?}: {sum}");
        }
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

    #[test]
    fn directions_round_trip_the_fixture() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/env_directions.json");
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let pairs = doc["pairs"].as_array().unwrap();
        assert!(pairs.len() >= 8);
        for p in pairs {
            let up: Up = serde_json::from_value(p["layout"].clone()).unwrap();
            let (u, v) = (p["u"].as_f64().unwrap() as f32, p["v"].as_f64().unwrap() as f32);
            let want: Vec<f32> = p["dir"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
            let d = direction(up, u, v);
            for k in 0..3 {
                assert!((d[k] - want[k]).abs() < 1e-5, "{p}: {d:?}");
            }
            let (bu, bv) = uv(up, want.clone().try_into().unwrap());
            assert!((bu - u).abs() < 1e-5 && (bv - v).abs() < 1e-5, "{p}: back to {bu}, {bv}");
        }
    }

    #[test]
    fn the_tables_leave_room_after_them() {
        let e = Environment::from_rgb("k", 8, 4, Up::Y, |_, _| [1.0; 3]);
        let t = e.tables();
        assert_eq!(t[1][1] as usize, t.len());
        assert!((t[1][0] - 1.0).abs() < 4e-2, "a white sphere has mean radiance 1, got {}", t[1][0]);
    }

    #[test]
    fn the_up_irradiance_follows_the_layout() {
        for up in [Up::Y, Up::Z] {
            let white = Environment::from_rgb("w", 64, 32, up, |_, _| [1.0; 3]).tables()[1][2];
            assert!((white - PI).abs() < 1e-2, "{up:?}: a white sphere gives an up face pi, got {white}");
            let sky = Environment::from_rgb("s", 64, 32, up, |c, r| {
                if direction(up, (c as f32 + 0.5) / 64.0, (r as f32 + 0.5) / 32.0)[2] > 0.0 {
                    [0.0; 3]
                } else {
                    [1.0; 3]
                }
            });
            assert_eq!(sky.tables()[1][2], 0.0, "{up:?}: light from below reaches an up face");
        }
    }
}
