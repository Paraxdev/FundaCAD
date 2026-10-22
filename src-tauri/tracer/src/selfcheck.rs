//! A tracer that checks itself: golden_small (a ball on a floor, 96x64, 64 spp)
//! traced on a tracer of its own, on the same path as the viewport's, against
//! the committed converged reference.

use std::time::Instant;

use crate::{BodyDesc, Camera, Look, Mesh, PageMaterial, Path, Tracer, TracerOptions};

pub const W: u32 = 96;
pub const H: u32 = 64;
pub const SPP: u32 = 64;
const REFERENCE: &[u8] = include_bytes!("../tests/refs/golden.png");

/// Noise is read off the two halves of the samples, and the difference of a
/// picture from its reference may be this many noises, plus a floor of 2/255.
const NOISE_FACTOR: f64 = 4.0;
const FLOOR: f64 = 2.0;
const BLOCK: usize = 4;

pub fn sphere(r: f32, su: u32, sv: u32) -> Mesh {
    let mut m = Mesh::default();
    for j in 0..=sv {
        let th = std::f32::consts::PI * j as f32 / sv as f32;
        for i in 0..=su {
            let ph = std::f32::consts::TAU * i as f32 / su as f32;
            let n = [th.sin() * ph.cos(), th.sin() * ph.sin(), th.cos()];
            m.positions.push(n.map(|c| c * r));
            m.normals.push(n);
        }
    }
    for j in 0..sv {
        for i in 0..su {
            let a = j * (su + 1) + i;
            let b = a + su + 1;
            m.indices.extend([a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    m
}

pub fn floor(s: f32) -> Mesh {
    Mesh {
        positions: vec![[-s, -s, 0.0], [s, -s, 0.0], [s, s, 0.0], [-s, s, 0.0]],
        normals: vec![[0.0, 0.0, 1.0]; 4],
        indices: vec![0, 1, 2, 0, 2, 3],
        ..Default::default()
    }
}

/// Khronos PBR Neutral then sRGB, the same as resolve.wgsl, as 16 bit.
pub fn display16(c: [f32; 3]) -> [u16; 3] {
    let start = 0.8 - 0.04;
    let x = c[0].min(c[1]).min(c[2]);
    let off = if x < 0.08 { x - 6.25 * x * x } else { 0.04 };
    let mut c = c.map(|v| v - off);
    let peak = c[0].max(c[1]).max(c[2]);
    if peak >= start {
        let d = 1.0 - start;
        let np = 1.0 - d * d / (peak + d - start);
        c = c.map(|v| v * np / peak);
        let g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
        c = c.map(|v| v + (np - v) * g);
    }
    c.map(|v| {
        let v = v.clamp(0.0, 1.0);
        let s = if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        (s * 65535.0).round() as u16
    })
}

fn matte(color: [f32; 3]) -> PageMaterial {
    PageMaterial { color: Some(color), roughness: Some(1.0), ..Default::default() }
}

fn place(id: &str, at: [f32; 3], mat: PageMaterial) -> BodyDesc {
    let mut matrix = [0.0; 16];
    matrix[0] = 1.0;
    matrix[5] = 1.0;
    matrix[10] = 1.0;
    matrix[15] = 1.0;
    matrix[12..15].copy_from_slice(&at);
    BodyDesc { id: id.into(), key: format!("{id}.1"), matrix, visible: true, materials: vec![mat] }
}

/// The golden scene at 96x64, committed. The sample cap is the caller's.
pub fn build_golden(t: &mut Tracer) {
    t.resize(W, H);
    t.set_camera(Camera {
        eye: [4.0, -6.0, 3.0],
        target: [0.0, 0.0, 0.8],
        up: [0.0, 0.0, 1.0],
        fov: 40.0,
        ..Default::default()
    });
    t.set_look(Look { sun_dir: [0.4, -0.3, 1.0], sun_color: [2.0; 3], ..Look::default() });
    let bodies =
        vec![place("ball", [0.0, 0.0, 1.0], matte([0.8, 0.3, 0.2])), place("floor", [0.0; 3], matte([0.7; 3]))];
    for key in t.set_bodies(bodies) {
        t.add_mesh(&key, if key.starts_with("floor") { floor(20.0) } else { sphere(1.0, 48, 24) });
    }
    t.apply();
}

/// The converged picture as rgb in 0..255 floats.
pub struct Reference {
    pub rgb: Vec<f32>,
}

impl Reference {
    pub fn golden() -> Reference {
        let mut r = png::Decoder::new(REFERENCE).read_info().expect("the committed reference decodes");
        let mut buf = vec![0; r.output_buffer_size()];
        let info = r.next_frame(&mut buf).expect("the committed reference decodes");
        assert_eq!((info.width, info.height, info.bit_depth), (W, H, png::BitDepth::Sixteen));
        let rgb = buf[..info.buffer_size()]
            .chunks_exact(2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]) as f32 / 257.0)
            .collect();
        Reference { rgb }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheck {
    /// Mean absolute difference of the 4x4 downsampled pictures, of 255.
    pub diff: f64,
    pub threshold: f64,
    /// What the two halves of the samples say the 64 spp picture is off by.
    pub noise: f64,
    pub ms: f64,
    pub path: Path,
    pub passed: bool,
}

fn down(rgb: &[f32]) -> Vec<f32> {
    let (bw, bh) = (W as usize / BLOCK, H as usize / BLOCK);
    let mut out = vec![0.0; bw * bh * 3];
    for y in 0..H as usize {
        for x in 0..W as usize {
            for k in 0..3 {
                out[((y / BLOCK) * bw + x / BLOCK) * 3 + k] += rgb[(y * W as usize + x) * 3 + k];
            }
        }
    }
    out.iter().map(|v| v / (BLOCK * BLOCK) as f32).collect()
}

fn mean_abs(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs() as f64).sum::<f64>() / a.len() as f64
}

fn tone(hdr: &[[f32; 3]]) -> Vec<f32> {
    hdr.iter().flat_map(|c| display16(*c)).map(|v| v as f32 / 257.0).collect()
}

/// `picture` is the resolved RGBA8 of all samples, `first` and `all` the mean
/// of the first half and of every sample, linear. The second half's mean is
/// what is left of `all`, and the two halves differ by twice the noise of
/// `all`.
fn judge(picture: &[u8], first: &[[f32; 3]], all: &[[f32; 3]], reference: &Reference) -> (f64, f64) {
    let second: Vec<[f32; 3]> =
        first.iter().zip(all).map(|(a, m)| [0, 1, 2].map(|k| (2.0 * m[k] - a[k]).max(0.0))).collect();
    let noise = mean_abs(&down(&tone(first)), &down(&tone(&second))) / 2.0;
    let rgb: Vec<f32> = picture.chunks_exact(4).flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    (mean_abs(&down(&rgb), &down(&reference.rgb)), noise)
}

impl Tracer {
    pub fn self_check(&self) -> Result<SelfCheck, String> {
        self.self_check_against(&Reference::golden())
    }

    pub fn self_check_against(&self, reference: &Reference) -> Result<SelfCheck, String> {
        let start = Instant::now();
        let mut t = Tracer::new(TracerOptions { software: self.path() == Path::Software, ..Default::default() })
            .map_err(|e| e.to_string())?;
        build_golden(&mut t);
        t.set_cap(SPP);
        t.render_samples(SPP / 2);
        let first = t.read_hdr();
        t.render_samples(SPP);
        let all = t.read_hdr();
        let picture = t.resolve();
        if let Some(f) = t.fault() {
            return Err(format!("the self check's own tracer failed: {f}"));
        }
        let (diff, noise) = judge(&picture, &first, &all, reference);
        let threshold = NOISE_FACTOR * noise + FLOOR;
        Ok(SelfCheck {
            diff,
            threshold,
            noise,
            ms: start.elapsed().as_secs_f64() * 1e3,
            path: t.path(),
            passed: diff <= threshold,
        })
    }
}
