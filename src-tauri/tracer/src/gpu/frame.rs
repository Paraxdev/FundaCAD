use std::time::{Duration, Instant};

use crate::bloom::{self, Bloom, Chain};

use super::{bytes, FrameKey, Held, Tracer};

/// What one dispatch aims for, short enough that the compositor and
/// the WebGPU viewport keep their frames, long enough to amortise a submit.
pub const BAND_TARGET: Duration = Duration::from_millis(10);

/// The next band after one of `rows` took `took`: scaled towards `target`,
/// at most doubling per step so one fast band over the sky cannot jump to a
/// full frame over the model, in multiples of the workgroup's 8 rows. Never
/// under MIN_BAND_PATHS: on a GPU shared with another app a band's time is
/// mostly waiting for its turn, and smaller bands only add submits.
pub fn adapt_rows(rows: u32, width: u32, height: u32, took: Duration, target: Duration) -> u32 {
    let ratio = (target.as_secs_f64() / took.as_secs_f64().max(1e-6)).clamp(0.25, 2.0);
    let want = (rows as f64 * ratio).round() as u32;
    let top = height.next_multiple_of(8).max(8);
    let floor = (MIN_BAND_PATHS / width.max(1)).clamp(8, top);
    want.clamp(floor, top).next_multiple_of(8)
}

pub const MIN_BAND_PATHS: u32 = 65_536;

impl Tracer {
    fn write_uniform(&self, rows: u32) {
        let c = &self.camera;
        let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        let norm = |a: [f32; 3]| {
            let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-20);
            [a[0] / l, a[1] / l, a[2] / l]
        };
        let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        let fwd = norm(sub(c.target, c.eye));
        let right = norm(cross(fwd, c.up));
        let up = cross(right, fwd);
        let th = (c.fov.to_radians() * 0.5).tan();
        let aspect = self.w as f32 / self.h as f32;
        let l = &self.look;
        let sun_on = (l.sun_dir.iter().any(|x| *x != 0.0) && l.sun_color.iter().any(|x| *x > 0.0)) as u32 as f32;
        let ints = [self.w, self.h, self.sample, self.row0, rows, self.n_inst, l.bounces.max(1), (self.sample == 0) as u32];
        let mut data: Vec<f32> = ints.map(f32::from_bits).to_vec();
        let v4 = |v: [f32; 3], w: f32| [v[0], v[1], v[2], w];
        for v in [
            v4(c.eye, 0.0),
            v4(fwd, 0.0),
            v4(right.map(|x| x * th * aspect), 0.0),
            v4(up.map(|x| x * th), 0.0),
            v4(l.sky_top, l.env_intensity),
            v4(l.sky_bottom, 0.0),
            v4(norm(l.sun_dir), sun_on),
            v4(l.sun_color, 0.0),
            [l.exposure, 0.0, 0.0, 0.0],
        ] {
            data.extend(v);
        }
        self.queue.write_buffer(&self.uniform, 0, bytes(&data));
    }

    /// One dispatch over a band of rows. False once the sample cap is reached.
    pub fn step(&mut self) -> bool {
        if self.sample >= self.cap {
            return false;
        }
        let rows = self.rows.min(self.h - self.row0);
        self.write_uniform(rows);
        let bind = self.bind_group();
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipes.trace);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(self.w.div_ceil(8), rows.div_ceil(8), 1);
        }
        self.queue.submit([enc.finish()]);
        self.row0 += rows;
        if self.row0 >= self.h {
            self.row0 = 0;
            self.sample += 1;
        }
        true
    }

    /// Dispatches until `budget` has passed or the cap is reached; answers the
    /// samples completed.
    pub fn trace_for(&mut self, budget: Duration) -> u32 {
        let start = Instant::now();
        let before = self.sample;
        loop {
            let t = Instant::now();
            if start.elapsed() >= budget || self.fault().is_some() || !self.step() {
                break;
            }
            self.wait();
            self.rows = adapt_rows(self.rows, self.w, self.h, t.elapsed(), BAND_TARGET);
        }
        self.sample - before
    }

    /// One frame for the transport: applies pending scene changes, traces for
    /// `budget` and resolves. At the cap it hands out the held frame without
    /// touching the GPU, and the denoised one once it lands; below it a
    /// software band that ends mid sample still traces on, so the sample count
    /// is no sign of a finished picture. Black once the device faulted.
    pub fn frame(&mut self, w: u32, h: u32, budget: Duration) -> Vec<u8> {
        if self.fault().is_some() {
            return vec![0; w.max(1) as usize * h.max(1) as usize * 4];
        }
        self.resize(w, h);
        self.apply();
        if self.done() && self.held.as_ref().is_some_and(|h| h.key == self.key()) {
            self.collect_denoise();
            self.rebloom_held();
            return self.held.as_ref().map(|h| h.pixels.clone()).unwrap_or_default();
        }
        self.trace_for(budget);
        let pixels = self.resolve();
        self.held = Some(Held { key: self.key(), pixels: pixels.clone(), denoised: false, bloom: self.bloom, denoise: None });
        if self.done() {
            self.start_denoise();
        }
        pixels
    }

    pub(super) fn key(&self) -> FrameKey {
        (self.generation(), self.sample, (self.w, self.h))
    }
    /// Rows per dispatch.
    pub fn band(&self) -> u32 {
        self.rows
    }

    pub fn render_samples(&mut self, n: u32) {
        while self.sample < n.min(self.cap) && self.step() {
            self.wait();
        }
    }

    pub fn wait(&self) {
        let _ = self.device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None });
    }

    fn read(&self, src: &wgpu::Buffer, size: u64) -> Vec<u8> {
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(src, 0, &staging, 0, size);
        self.queue.submit([enc.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r.is_ok());
        });
        self.wait();
        if !rx.try_recv().unwrap_or(false) || self.fault().is_some() {
            return vec![0; size as usize];
        }
        let Ok(v) = staging.slice(..).get_mapped_range().map(|r| r.to_vec()) else {
            return vec![0; size as usize];
        };
        staging.unmap();
        v
    }

    /// The accumulated image tone mapped to sRGB RGBA8, rows top first.
    pub fn resolve(&mut self) -> Vec<u8> {
        self.resolve_from(false)
    }

    /// The threshold kept above the sky as the trace draws it, the background
    /// times the brightness: the page raised it above the background alone,
    /// so a brightness above 1 could bloom the whole sky.
    fn bloom_threshold(&self, b: &Bloom) -> f32 {
        let l = &self.look;
        let sky = bloom::luma(l.sky_top).max(bloom::luma(l.sky_bottom)) * l.env_intensity;
        b.threshold.max(sky + 0.05)
    }

    pub(super) fn resolve_from(&mut self, denoised: bool) -> Vec<u8> {
        let Some(b) = self.bloom else { return self.resolve_plain() };
        let r = [self.w, self.h, self.look.exposure.to_bits(), 0];
        self.queue.write_buffer(&self.resolve_uniform, 0, bytes(&r));
        let threshold = self.bloom_threshold(&b);
        let src = if denoised { &self.hdr } else { &self.accum };
        let chain = self.chain.get_or_insert_with(|| Chain::new(&self.device));
        let mut enc = self.device.create_command_encoder(&Default::default());
        let (glow, size) = chain.encode(&self.device, &self.queue, &mut enc, src, (self.w, self.h), &b, threshold);
        self.queue.write_buffer(&self.glow_uniform, 0, bytes(&[size.0, size.1, 0, 0]));
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.pipes.glow_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.resolve_uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: src.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: glow.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: self.glow_uniform.as_entire_binding() },
            ],
        });
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipes.glow);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(self.w.div_ceil(8), self.h.div_ceil(8), 1);
        }
        self.queue.submit([enc.finish()]);
        self.read(&self.out, self.w as u64 * self.h as u64 * 4)
    }

    fn resolve_plain(&mut self) -> Vec<u8> {
        let r = [self.w, self.h, self.look.exposure.to_bits(), 0];
        self.queue.write_buffer(&self.resolve_uniform, 0, bytes(&r));
        let bind = match &self.resolve_bind {
            Some(b) => b.clone(),
            None => {
                let b = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.pipes.resolve_bgl,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: self.resolve_uniform.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: self.accum.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 2, resource: self.out.as_entire_binding() },
                    ],
                });
                self.resolve_bind = Some(b.clone());
                b
            }
        };
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipes.resolve);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(self.w.div_ceil(8), self.h.div_ceil(8), 1);
        }
        self.queue.submit([enc.finish()]);
        self.read(&self.out, self.w as u64 * self.h as u64 * 4)
    }

    /// The accumulation as exposed linear rgb, rows top first: what resolve.wgsl
    /// tone maps.
    pub fn read_hdr(&self) -> Vec<[f32; 3]> {
        let raw = self.read(&self.accum, self.w as u64 * self.h as u64 * 16);
        let e = self.look.exposure;
        raw.chunks_exact(16)
            .map(|c| {
                let f = |k: usize| f32::from_le_bytes(c[k * 4..k * 4 + 4].try_into().unwrap());
                let n = f(3).max(1.0);
                [f(0) / n * e, f(1) / n * e, f(2) / n * e]
            })
            .collect()
    }

    /// Two vec4 per pixel from the first sample after a reset: albedo and view
    /// depth, then world normal and coverage. What the denoiser reads.
    pub fn read_aovs(&self) -> Vec<[f32; 4]> {
        let raw = self.read(&self.aov, self.w as u64 * self.h as u64 * 32);
        raw.chunks_exact(16)
            .map(|c| [0, 1, 2, 3].map(|k| f32::from_le_bytes(c[k * 4..k * 4 + 4].try_into().unwrap())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_software_band_follows_the_dispatch_time() {
        let ms = Duration::from_millis;
        assert_eq!(adapt_rows(272, 1920, 1080, ms(30), ms(10)), 96);
        assert_eq!(adapt_rows(96, 1920, 1080, ms(10), ms(10)), 96);
        assert_eq!(adapt_rows(96, 1920, 1080, ms(1), ms(10)), 192);
        assert_eq!(adapt_rows(1080, 1920, 1080, ms(1), ms(10)), 1080);
        assert_eq!(adapt_rows(100, 1920, 1080, Duration::ZERO, ms(10)), 200);
        // 65536 paths at 1920 wide is 34 rows, 40 on the workgroup grid.
        assert_eq!(adapt_rows(48, 1920, 1080, ms(400), ms(10)), 40);
        assert_eq!(adapt_rows(8, 64, 48, ms(400), ms(10)), 48);
    }
}
