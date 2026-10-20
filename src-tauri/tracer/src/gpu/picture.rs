//! A still at its own size beside the viewport. It owns a second
//! accumulation, swapped into the tracer for each slice of tracing and out
//! again, so the viewport keeps its samples and its frame size.

use std::time::Duration;

use crate::bloom::{Bloom, Chain};
use crate::denoise::{self, Denoiser, Quality};

use super::frame::MIN_BAND_PATHS;
use super::{storage, Camera, Held, Job, Look, Tracer};

/// Bytes per pixel in the largest buffer a trace binds: the AOVs, two vec4.
const AOV_BYTES: u64 = 32;
/// accum 16, aov 32, out 4, hdr 16.
const TARGET_BYTES: u64 = 68;

/// Everything one accumulation owns. The tracer's own fields hold the active one.
pub(super) struct Target {
    accum: wgpu::Buffer,
    aov: wgpu::Buffer,
    out: wgpu::Buffer,
    hdr: wgpu::Buffer,
    w: u32,
    h: u32,
    sample: u32,
    row0: u32,
    rows: u32,
    cap: u32,
    bind: Option<wgpu::BindGroup>,
    resolve_bind: Option<wgpu::BindGroup>,
    chain: Option<Chain>,
    held: Option<Held>,
    job: Option<Job>,
    camera: Camera,
    look: Look,
    bloom: Option<Bloom>,
    quality: Quality,
    denoise_error: Option<String>,
}

pub struct Picture {
    target: Target,
    generation: u64,
    input: Option<denoise::Input>,
    denoised: Option<(Vec<f32>, Denoiser)>,
}

impl Picture {
    pub fn samples(&self) -> u32 {
        self.target.sample
    }
    pub fn total(&self) -> u32 {
        self.target.cap
    }
    pub fn size(&self) -> (u32, u32) {
        (self.target.w, self.target.h)
    }
    pub fn done(&self) -> bool {
        self.target.sample >= self.target.cap
    }
    /// What cleaned it, once `denoise` ran.
    pub fn denoised_by(&self) -> Option<Denoiser> {
        self.denoised.as_ref().map(|d| d.1)
    }

    /// Open Image Denoise when loaded, else the filter, once at the end. Needs
    /// no tracer, so the frames layer runs it outside the tracer's lock.
    pub fn denoise(&mut self) {
        if let Some(input) = self.input.take() {
            let (c, by, _) = denoise::run(&input, self.target.quality);
            self.denoised = Some((c, by));
        }
    }
}

/// Why a `w` x `h` picture cannot be traced in buffers of at most `limit`
/// bytes each, or None when it can.
pub fn picture_refusal(w: u32, h: u32, limit: u64) -> Option<String> {
    let px = w as u64 * h as u64;
    let need = px * AOV_BYTES;
    (need > limit).then(|| {
        let mib = |b: u64| b as f64 / (1024.0 * 1024.0);
        let side = ((limit / AOV_BYTES) as f64 / px as f64).sqrt();
        format!(
            "a {w}x{h} picture needs a {:.0} MiB buffer ({:.0} MiB in all) and this GPU binds at most {:.0} MiB, take it at {}x{} or smaller",
            mib(need),
            mib(px * TARGET_BYTES),
            mib(limit),
            (w as f64 * side).floor() as u32,
            (h as f64 * side).floor() as u32,
        )
    })
}

impl Tracer {
    /// The largest buffer this device binds for a trace.
    pub fn buffer_limit(&self) -> u64 {
        self.buffer_limit
    }
    #[doc(hidden)]
    pub fn limit_buffers_for_test(&mut self, bytes: u64) {
        self.buffer_limit = bytes;
    }

    /// A second accumulation at `w` x `h` for the current scene, camera, look
    /// and bloom, traced to `samples` and denoised with `quality`. Refused
    /// with the reason when its buffers exceed what the device binds.
    pub fn begin_picture(&mut self, w: u32, h: u32, samples: u32, quality: Quality) -> Result<Picture, String> {
        if let Some(f) = self.fault() {
            return Err(format!("the native tracer stopped: {f}"));
        }
        let (w, h) = (w.max(1), h.max(1));
        if let Some(why) = picture_refusal(w, h, self.buffer_limit) {
            return Err(why);
        }
        let px = w as u64 * h as u64;
        let accum = storage(&self.device, px * 16, wgpu::BufferUsages::COPY_SRC);
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.clear_buffer(&accum, 0, None);
        self.queue.submit([enc.finish()]);
        // The first band traces about what the viewport's does, so a 4K
        // picture never starts with a whole frame in one dispatch.
        let paths = (self.rows as u64 * self.w as u64).max(MIN_BAND_PATHS as u64);
        let rows = ((paths / w as u64) as u32).clamp(8, h.next_multiple_of(8)).next_multiple_of(8);
        let target = Target {
            accum,
            aov: storage(&self.device, px * 32, wgpu::BufferUsages::COPY_SRC),
            out: storage(&self.device, px * 4, wgpu::BufferUsages::COPY_SRC),
            hdr: storage(&self.device, px * 16, wgpu::BufferUsages::empty()),
            w,
            h,
            sample: 0,
            row0: 0,
            rows,
            cap: samples.max(1),
            bind: None,
            resolve_bind: None,
            chain: None,
            held: None,
            job: None,
            camera: self.camera,
            look: self.look,
            bloom: self.bloom,
            quality,
            denoise_error: None,
        };
        // Note (tracer-relief): the ray cone pixel spread is to be set per
        // render size, so a picture larger than the view filters its textures
        // and relief at its own pixel size.
        Ok(Picture { target, generation: self.generation(), input: None, denoised: None })
    }

    /// Traces the picture for about `budget`, in bands. Scene changes the
    /// viewport applies in between start its samples again. True once it has
    /// all its samples; the denoise input is read then.
    pub fn trace_picture(&mut self, p: &mut Picture, budget: Duration) -> bool {
        let c = self.apply();
        if c.reset || c.geometry || c.instances || c.blas_built > 0 || c.tlas_built || p.generation != self.generation() {
            p.generation = self.generation();
            p.target.sample = 0;
            p.target.row0 = 0;
            p.target.bind = None;
            p.input = None;
            let mut enc = self.device.create_command_encoder(&Default::default());
            enc.clear_buffer(&p.target.accum, 0, None);
            self.queue.submit([enc.finish()]);
        }
        if p.done() {
            return true;
        }
        self.swap(&mut p.target);
        self.trace_for(budget);
        let done = self.done();
        if done && self.quality != Quality::Off && p.input.is_none() {
            p.input = Some(self.denoise_input());
        }
        self.swap(&mut p.target);
        done
    }

    /// The picture as sRGB RGBA8, rows top first: the denoised colour when
    /// `denoise` ran, bloomed as the viewport blooms. Frees its buffers.
    pub fn finish_picture(&mut self, mut p: Picture) -> Vec<u8> {
        self.swap(&mut p.target);
        let px = match p.denoised.take() {
            Some((c, _)) if c.len() == self.w as usize * self.h as usize * 3 => {
                let rgb: Vec<[f32; 3]> = c.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
                if self.bloom.is_some() {
                    let e = if self.look.exposure > 0.0 { self.look.exposure } else { 1.0 };
                    let hdr: Vec<[f32; 4]> = rgb.iter().map(|p| [p[0] / e, p[1] / e, p[2] / e, 1.0]).collect();
                    self.queue.write_buffer(&self.hdr, 0, super::bytes(&hdr));
                    self.resolve_from(true)
                } else {
                    denoise::tone_map(&rgb)
                }
            }
            _ => self.resolve(),
        };
        self.swap(&mut p.target);
        for b in [&p.target.accum, &p.target.aov, &p.target.out, &p.target.hdr] {
            b.destroy();
        }
        px
    }

    /// The whole picture in one call, holding the tracer throughout.
    pub fn picture(&mut self, w: u32, h: u32, samples: u32, quality: Quality) -> Result<Vec<u8>, String> {
        let mut p = self.begin_picture(w, h, samples, quality)?;
        while !self.trace_picture(&mut p, Duration::from_millis(100)) {
            if let Some(f) = self.fault() {
                return Err(format!("the native tracer stopped: {f}"));
            }
        }
        p.denoise();
        Ok(self.finish_picture(p))
    }

    fn swap(&mut self, t: &mut Target) {
        use std::mem::swap;
        swap(&mut self.accum, &mut t.accum);
        swap(&mut self.aov, &mut t.aov);
        swap(&mut self.out, &mut t.out);
        swap(&mut self.hdr, &mut t.hdr);
        swap(&mut self.w, &mut t.w);
        swap(&mut self.h, &mut t.h);
        swap(&mut self.sample, &mut t.sample);
        swap(&mut self.row0, &mut t.row0);
        swap(&mut self.rows, &mut t.rows);
        swap(&mut self.cap, &mut t.cap);
        swap(&mut self.bind, &mut t.bind);
        swap(&mut self.resolve_bind, &mut t.resolve_bind);
        swap(&mut self.chain, &mut t.chain);
        swap(&mut self.held, &mut t.held);
        swap(&mut self.job, &mut t.job);
        swap(&mut self.camera, &mut t.camera);
        swap(&mut self.look, &mut t.look);
        swap(&mut self.bloom, &mut t.bloom);
        swap(&mut self.quality, &mut t.quality);
        swap(&mut self.denoise_error, &mut t.denoise_error);
    }
}

/// RGBA8 rows top first as a PNG file.
pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_over_the_binding_limit_is_refused_with_a_size_that_fits() {
        let limit = 128 * 1024 * 1024;
        assert_eq!(picture_refusal(1920, 1080, limit), None);
        let why = picture_refusal(3840, 2160, limit).expect("a 4K picture fits 128 MiB bindings");
        assert!(why.contains("253 MiB") && why.contains("128 MiB"), "{why}");
        let fit: Vec<u32> = why.split("take it at ").nth(1).unwrap().split(" or")
            .next().unwrap().split('x').map(|s| s.parse().unwrap()).collect();
        assert_eq!(picture_refusal(fit[0], fit[1], limit), None, "{why}");
    }
}
