//! Datum marks as triangles for the renderer, which tests them against the model's depth, sized in screen pixels
//! where they stand.

#[cfg(test)]
mod tests;

use glam::Vec3;

use crate::viewport::camera::Camera;
use crate::viewport::renderer::DatumVertex;

/// A long axis zoomed in close would be thousands of dashes.
const MAX_DASHES: f32 = 400.0;

pub struct View {
    eye: Vec3,
    forward: Vec3,
    right: Vec3,
    up: Vec3,
    /// World size of a pixel one unit in front of the eye.
    per_px: f32,
}

impl View {
    pub fn new(cam: &Camera, height: f32) -> Self {
        let view = cam.view();
        let eye = cam.eye();
        Self {
            eye,
            forward: (cam.target - eye).normalize_or_zero(),
            right: view.row(0).truncate(),
            up: view.row(1).truncate(),
            per_px: cam.per_pixel(height) / cam.distance.max(1e-6),
        }
    }

    pub fn px(&self, p: Vec3) -> f32 {
        self.per_px * (p - self.eye).dot(self.forward).max(1e-6)
    }
}

/// Linear colour from an sRGB hex, the shader encodes it back.
pub fn linear(hex: u32, a: f32) -> [f32; 4] {
    let c = |s: u32| ((s & 0xff) as f32 / 255.0).powf(2.2);
    [c(hex >> 16), c(hex >> 8), c(hex), a]
}

fn tri(out: &mut Vec<DatumVertex>, p: [Vec3; 3], color: [f32; 4]) {
    out.extend(p.map(|p| DatumVertex { position: p.into(), color }));
}

pub fn quad(out: &mut Vec<DatumVertex>, c: [Vec3; 4], color: [f32; 4]) {
    tri(out, [c[0], c[1], c[2]], color);
    tri(out, [c[0], c[2], c[3]], color);
}

/// A strip `width` pixels wide, turned to face the eye.
pub fn line(out: &mut Vec<DatumVertex>, view: &View, a: Vec3, b: Vec3, width: f32, color: [f32; 4]) {
    let side = |p: Vec3| (b - a).cross(p - view.eye).normalize_or_zero() * (width * 0.5 * view.px(p));
    let (sa, sb) = (side(a), side(b));
    quad(out, [a - sa, b - sb, b + sb, a + sa], color);
}

/// `on` pixels drawn and `off` left out in turn, measured at the middle of the line.
#[allow(clippy::too_many_arguments)]
pub fn dashed(out: &mut Vec<DatumVertex>, view: &View, a: Vec3, b: Vec3, width: f32, on: f32, off: f32, color: [f32; 4]) {
    let length = a.distance(b);
    let px = view.px((a + b) * 0.5);
    let period = ((on + off) * px).max(length / MAX_DASHES);
    if length <= 0.0 || period <= 0.0 {
        return;
    }
    let dir = (b - a) / length;
    let share = on / (on + off);
    let mut t = 0.0;
    while t < length {
        let end = (t + period * share).min(length);
        line(out, view, a + dir * t, a + dir * end, width, color);
        t += period;
    }
}

/// A round dot `radius` pixels across facing the eye.
pub fn disc(out: &mut Vec<DatumVertex>, view: &View, c: Vec3, radius: f32, color: [f32; 4]) {
    let r = radius * view.px(c);
    let at = |i: usize| {
        let a = i as f32 / 12.0 * std::f32::consts::TAU;
        c + (view.right * a.cos() + view.up * a.sin()) * r
    };
    for i in 0..12 {
        tri(out, [c, at(i), at(i + 1)], color);
    }
}
