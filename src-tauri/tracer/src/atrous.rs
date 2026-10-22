//! The edge aware a-trous filter of src/viewport/pathtrace/atrous.ts on the
//! CPU, the denoise at the cap when Open Image Denoise is not installed. Same
//! constants, same trust mask, same demodulation by albedo.

use crate::denoise::Input;

const STEPS: [i32; 5] = [1, 2, 4, 8, 16];
const KERNEL: [f32; 3] = [3.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0];
const DEPTH_SIGMA: f32 = 0.02;
const DEPTH_REACH: f32 = 8.0;
const LUMA_SIGMA: f32 = 4.0;
const EDGE_DEPTH: f32 = 0.05;
const MIN_ALBEDO: f32 = 0.02;

fn luma(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn albedo_at(a: &[f32], i: usize) -> [f32; 3] {
    let c = [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
    if (c[0] + c[1] + c[2]) / 3.0 <= MIN_ALBEDO {
        return [1.0; 3];
    }
    c.map(|v| v.max(MIN_ALBEDO))
}

fn trust(w: usize, h: usize, depth: &[f32]) -> Vec<bool> {
    let mut t = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let zp = depth[y * w + x];
            let mut ok = zp > 0.0;
            'n: for j in -1i32..=1 {
                for i in -1i32..=1 {
                    let qy = (y as i32 + j).clamp(0, h as i32 - 1) as usize;
                    let qx = (x as i32 + i).clamp(0, w as i32 - 1) as usize;
                    let zq = depth[qy * w + qx];
                    ok = ok && zq > 0.0 && (zp - zq).abs() <= EDGE_DEPTH * zp.min(zq);
                    if !ok {
                        break 'n;
                    }
                }
            }
            t[y * w + x] = ok;
        }
    }
    t
}

fn pass(
    w: usize,
    h: usize,
    rows: std::ops::Range<usize>,
    cur: &[[f32; 3]],
    input: &Input,
    trust: &[bool],
    step: i32,
    sigma: f32,
    out: &mut [[f32; 3]],
) {
    let (n, d) = (&input.normal, &input.depth);
    for y in rows.clone() {
        for x in 0..w {
            let p = y * w + x;
            let o = &mut out[(y - rows.start) * w + x];
            *o = cur[p];
            if !trust[p] {
                continue;
            }
            let zp = d[p];
            let lp = luma(cur[p]);
            let (mut s, mut ws) = ([0.0f32; 3], 0.0f32);
            for j in -2i32..=2 {
                for i in -2i32..=2 {
                    let qx = (x as i32 + i * step).clamp(0, w as i32 - 1) as usize;
                    let qy = (y as i32 + j * step).clamp(0, h as i32 - 1) as usize;
                    let q = qy * w + qx;
                    if !trust[q] {
                        continue;
                    }
                    let zq = d[q];
                    let dot = n[p * 3] * n[q * 3] + n[p * 3 + 1] * n[q * 3 + 1] + n[p * 3 + 2] * n[q * 3 + 2];
                    let wn = dot.max(0.0).powi(64);
                    let reach = (step as f32 * ((i * i + j * j) as f32).sqrt()).min(DEPTH_REACH);
                    let wz = (-(zp - zq).abs() / (DEPTH_SIGMA * zp.min(zq) * reach + 1e-4)).exp();
                    let lq = luma(cur[q]);
                    let wl = (-(lp - lq).abs() / ((lp.max(lq) + 1e-3) * sigma)).exp();
                    let wt = KERNEL[i.unsigned_abs() as usize] * KERNEL[j.unsigned_abs() as usize] * wn * wz * wl;
                    for k in 0..3 {
                        s[k] += cur[q][k] * wt;
                    }
                    ws += wt;
                }
            }
            if ws > 0.0 {
                *o = s.map(|v| v / ws);
            }
        }
    }
}

/// The page's stop is meant for a few samples and fades out before its cap,
/// where it blurs shading the noise no longer hides; here the stop is held to
/// a few times the noise measured in the picture itself.
const NOISE_STOPS: f32 = 3.0;

/// The relative noise of the demodulated colour: the median of each surface
/// pixel's luminance off its four neighbours' mean, on flat stretches, as a
/// standard deviation (MAD times 1.4826, over sqrt(1.25) for the mean).
fn noise(w: usize, h: usize, c: &[[f32; 3]], trust: &[bool], n: &[f32]) -> f32 {
    let mut r = Vec::new();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w - 1 {
            let p = y * w + x;
            let q = [p - 1, p + 1, p - w, p + w];
            let flat = |q: usize| {
                trust[q] && n[p * 3] * n[q * 3] + n[p * 3 + 1] * n[q * 3 + 1] + n[p * 3 + 2] * n[q * 3 + 2] > 0.99
            };
            if !trust[p] || !q.iter().all(|&q| flat(q)) {
                continue;
            }
            let lp = luma(c[p]);
            let mean = q.iter().map(|&q| luma(c[q])).sum::<f32>() / 4.0;
            r.push((lp - mean).abs() / (lp.max(mean) + 1e-3));
        }
    }
    if r.is_empty() {
        return f32::INFINITY;
    }
    let mid = r.len() / 2;
    let (_, m, _) = r.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    *m * 1.4826 / 1.25f32.sqrt()
}

/// Five passes over the linear colour, `samples` setting the luminance stop.
pub fn filter(input: &Input, samples: u32) -> Vec<f32> {
    let (w, h) = (input.width, input.height);
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let trust = trust(w, h, &input.depth);
    let mut cur: Vec<[f32; 3]> = (0..w * h)
        .map(|i| {
            let c = [input.color[i * 3], input.color[i * 3 + 1], input.color[i * 3 + 2]];
            if !trust[i] {
                return c;
            }
            let a = albedo_at(&input.albedo, i);
            [c[0] / a[0], c[1] / a[1], c[2] / a[2]]
        })
        .collect();
    let sigma =
        (LUMA_SIGMA / (samples.max(1) as f32).sqrt()).min(NOISE_STOPS * noise(w, h, &cur, &trust, &input.normal));
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(h);
    let band = h.div_ceil(threads);
    for step in STEPS {
        let mut next = vec![[0.0f32; 3]; w * h];
        std::thread::scope(|sc| {
            for (b, chunk) in next.chunks_mut(band * w).enumerate() {
                let rows = b * band..(b * band + band).min(h);
                let (cur, trust) = (&cur, &trust);
                sc.spawn(move || pass(w, h, rows, cur, input, trust, step, sigma, chunk));
            }
        });
        cur = next;
    }
    let mut out = Vec::with_capacity(w * h * 3);
    for (i, c) in cur.iter().enumerate() {
        let a = if trust[i] { albedo_at(&input.albedo, i) } else { [1.0; 3] };
        out.extend([c[0] * a[0], c[1] * a[1], c[2] * a[2]]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: usize, h: usize, noise: bool) -> Input {
        let mut color = Vec::new();
        let mut seed = 12345u32;
        for _ in 0..w * h {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let v = if noise { 0.1 + 0.8 * (seed >> 8) as f32 / (1u32 << 24) as f32 } else { 0.5 };
            color.extend([v, v, v]);
        }
        Input {
            width: w,
            height: h,
            color,
            albedo: vec![0.5; w * h * 3],
            normal: [0.0, 0.0, 1.0].repeat(w * h),
            depth: vec![5.0; w * h],
            samples: 64,
        }
    }

    #[test]
    fn a_flat_surface_keeps_its_colour() {
        let out = filter(&flat(16, 12, false), 64);
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-4), "{:?}", &out[..6]);
    }

    #[test]
    fn noise_on_one_surface_is_smoothed_toward_its_mean() {
        let input = flat(32, 32, true);
        let out = filter(&input, 64);
        let rms = |v: &[f32]| (v.iter().map(|x| (x - 0.5) * (x - 0.5)).sum::<f32>() / v.len() as f32).sqrt();
        assert!(rms(&out) < rms(&input.color) * 0.5, "rms {} from {}", rms(&out), rms(&input.color));
    }

    #[test]
    fn the_background_stays_as_traced() {
        let mut input = flat(16, 16, true);
        input.depth = vec![0.0; 16 * 16];
        assert_eq!(filter(&input, 64), input.color);
    }
}
