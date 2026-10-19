//! The denoise at the sample cap, on a worker thread, tone mapped with
//! resolve.wgsl's curve: Open Image Denoise when it is installed, the edge
//! aware a-trous filter otherwise.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Off,
    #[default]
    Standard,
    High,
}

/// Khronos PBR Neutral, as resolve.wgsl.
fn neutral(c: [f32; 3]) -> [f32; 3] {
    let start = 0.8 - 0.04;
    let x = c[0].min(c[1]).min(c[2]);
    let off = if x < 0.08 { x - 6.25 * x * x } else { 0.04 };
    let c = c.map(|v| v - off);
    let peak = c[0].max(c[1]).max(c[2]);
    if peak < start {
        return c;
    }
    let d = 1.0 - start;
    let np = 1.0 - d * d / (peak + d - start);
    let g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
    c.map(|v| {
        let v = v * np / peak;
        v + (np - v) * g
    })
}

fn srgb(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Exposed linear colour to sRGB RGBA8, the way resolve.wgsl packs it.
pub fn tone_map(hdr: &[[f32; 3]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(hdr.len() * 4);
    for &c in hdr {
        let c = neutral(c);
        for v in c {
            out.push((srgb(v.clamp(0.0, 1.0)).clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        out.push(255);
    }
    out
}

pub struct Input {
    pub width: usize,
    pub height: usize,
    pub color: Vec<f32>,
    pub albedo: Vec<f32>,
    pub normal: Vec<f32>,
    /// View depth, 0 where no surface was hit.
    pub depth: Vec<f32>,
    /// The samples behind `color`, which set the filter's luminance stop.
    pub samples: u32,
}

/// What cleans the picture at the cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Denoiser {
    Oidn,
    Filter,
}

pub fn active() -> Denoiser {
    if crate::oidn::api().is_some() {
        Denoiser::Oidn
    } else {
        Denoiser::Filter
    }
}

/// Open Image Denoise when loaded, the filter when it is not or it failed.
pub(crate) fn run(input: &Input, quality: Quality) -> (Vec<f32>, Denoiser, Option<String>) {
    let mut note = None;
    if let Some(api) = crate::oidn::api() {
        match api.denoise(input, quality) {
            Ok(c) => return (c, Denoiser::Oidn, None),
            Err(e) => note = Some(e),
        }
    }
    (crate::atrous::filter(input, input.samples), Denoiser::Filter, note)
}
