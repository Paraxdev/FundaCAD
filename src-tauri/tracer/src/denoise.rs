//! The denoise at the sample cap: Open Image Denoise on the CPU (feature
//! `oidn`), on a worker thread, tone mapped with resolve.wgsl's curve.

use serde::Deserialize;

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
}

/// Why the denoise cannot run here, or Ok once the library loaded.
pub fn available() -> Result<(), String> {
    imp::available()
}

pub(crate) fn run(input: &Input, quality: Quality) -> Result<Vec<f32>, String> {
    imp::run(input, quality)
}

#[cfg(not(feature = "oidn"))]
mod imp {
    use super::*;

    pub fn available() -> Result<(), String> {
        Err("this build has no denoiser (feature oidn)".into())
    }

    pub fn run(_: &Input, _: Quality) -> Result<Vec<f32>, String> {
        available().map(|_| Vec::new())
    }
}

#[cfg(feature = "oidn")]
mod imp {
    use super::*;
    use std::sync::OnceLock;

    /// The app delay loads OpenImageDenoise.dll (src-tauri/build.rs), so a
    /// missing library must be found here, before the first call faults.
    #[cfg(windows)]
    fn load() -> Result<(), String> {
        #[link(name = "kernel32")]
        extern "system" {
            fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
        }
        let name: Vec<u16> = "OpenImageDenoise.dll\0".encode_utf16().collect();
        if unsafe { LoadLibraryW(name.as_ptr()) }.is_null() {
            return Err(format!("OpenImageDenoise.dll did not load ({})", std::io::Error::last_os_error()));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn load() -> Result<(), String> {
        Ok(())
    }

    pub fn available() -> Result<(), String> {
        static LOADED: OnceLock<Result<(), String>> = OnceLock::new();
        LOADED
            .get_or_init(|| {
                load()?;
                oidn::Device::cpu().map(drop).map_err(|e| format!("no CPU denoise device: {e:?}"))
            })
            .clone()
    }

    pub fn run(input: &Input, quality: Quality) -> Result<Vec<f32>, String> {
        available()?;
        let device = oidn::Device::cpu().map_err(|e| format!("{e:?}"))?;
        let mut out = vec![0.0; input.color.len()];
        let mut f = oidn::RayTracing::try_new(&device).map_err(|e| format!("{e:?}"))?;
        f.srgb(false)
            .hdr(true)
            .clean_aux(true)
            .image_dimensions(input.width, input.height)
            .filter_quality(match quality {
                Quality::High => oidn::Quality::High,
                _ => oidn::Quality::Balanced,
            })
            .albedo_normal(&input.albedo, &input.normal);
        f.filter(&input.color, &mut out).map_err(|e| format!("{e:?}"))?;
        device.get_error().map_err(|e| format!("{e:?}"))?;
        Ok(out)
    }
}
