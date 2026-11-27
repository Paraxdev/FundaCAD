//! The ground grid and the origin triad as FundaCAD 1 draws them: scene.ts's AdaptiveGrid, a shader plane with soft
//! one pixel lines fading out toward its edge, and originTriad.ts's muted axis hairlines.

#[cfg(test)]
mod tests;

use glam::Vec3;

use super::datums::draw::{self, View};
use super::look;
use super::renderer::DatumVertex;

/// planeGrid.ts GRID_CELL_PX, the size a minor cell aims for on screen.
pub const GRID_CELL_PX: f32 = 64.0;
const GRID_MAJOR_EVERY: f32 = 5.0;
const GROUND_COVER: f32 = 3.0;
const MIN_GROUND_CELLS: f32 = 40.0;
const MAX_GROUND_CELLS: f32 = 600.0;
/// scene.ts's fallbacks for --grid-minor and --grid-major, which the theme never set.
pub const GRID_MINOR: u32 = 0x3a414d;
pub const GRID_MAJOR: u32 = 0x5c6b7a;
/// How far the major lines lean toward the accent.
const MAJOR_ACCENT: f32 = 0.4;

/// RGB for XYZ, fixed on purpose rather than themed.
pub const AXIS_COLOR: [u32; 3] = [0xff5a5a, 0x46d97a, 0x4d8dff];
pub const TRIAD_LENGTH_PX: f32 = 64.0;
const MIN_TRIAD_SCALE: f32 = 0.3;
const LINE_RADIUS_PX: f32 = 0.85;
const DOT_RADIUS_PX: f32 = 2.6;
pub const TRIAD_OPACITY: f32 = 0.8;
/// The part of an arm inside the model, faint so the origin is still findable inside a primitive centred on it.
pub const TRIAD_OCCLUDED_OPACITY: f32 = 0.2;
/// Alpha at an arm's far end, as a share of its root's.
const TIP_FADE: f32 = 0.2;
const AXIS_MUTE: f32 = 0.3;
/// The --text-mute the dot takes.
pub const DOT_COLOR: u32 = 0x7d7590;
/// gizmoScale.ts: a glyph may cover this much of the model on screen before it shrinks.
const GLYPH_MODEL_FRACTION: f32 = 0.45;

/// units.ts niceStep: `rough` rounded to 1, 2 or 5 times a power of ten.
pub fn nice_step(rough: f32) -> f32 {
    if !(rough > 0.0 && rough.is_finite()) {
        return 1.0;
    }
    let exp = rough.log10().floor();
    let base = rough / 10f32.powf(exp);
    let nice = if base < 1.5 {
        1.0
    } else if base < 3.5 {
        2.0
    } else if base < 7.5 {
        5.0
    } else {
        10.0
    };
    nice * 10f32.powf(exp)
}

/// The minor grid step in millimetres for `per_px` millimetres a pixel.
pub fn cell(per_px: f32) -> f32 {
    nice_step(per_px * GRID_CELL_PX)
}

/// scene.ts groundGridCells: enough cells to cover a grazing view, in whole major cells.
pub fn ground_cells(per_px: f32, diagonal_px: f32, cell: f32) -> f32 {
    let want = per_px * diagonal_px * GROUND_COVER / cell;
    let cells = if want.is_finite() && want > 0.0 { want.ceil() } else { MIN_GROUND_CELLS };
    (cells.clamp(MIN_GROUND_CELLS, MAX_GROUND_CELLS) / GRID_MAJOR_EVERY).ceil() * GRID_MAJOR_EVERY
}

/// The ground grid for one frame, its floor left to the renderer, which knows the bodies' bounds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Grid {
    pub centre: [f32; 2],
    pub half: f32,
    pub cell: f32,
    pub minor: [f32; 4],
    pub major: [f32; 4],
}

impl Grid {
    /// Recentred on the target in whole major cells, so the lines stay put while the target moves.
    pub fn at(target: Vec3, per_px: f32, diagonal_px: f32, accent: u32) -> Self {
        let cell = cell(per_px);
        let major = cell * GRID_MAJOR_EVERY;
        let snap = |v: f32| (v / major).round() * major;
        let (minor_c, major_c, accent) =
            (look::linear(GRID_MINOR, 1.0), look::linear(GRID_MAJOR, 1.0), look::linear(accent, 1.0));
        let major_c = std::array::from_fn(|i| major_c[i] + (accent[i] - major_c[i]) * MAJOR_ACCENT);
        Self {
            centre: [snap(target.x), snap(target.y)],
            half: cell * ground_cells(per_px, diagonal_px, cell) * 0.5,
            cell,
            minor: shown_raw(minor_c),
            major: shown_raw(major_c),
        }
    }

    /// The shader's `grid` (centre, floor, half side) and `grid_cell` (minor and major step).
    pub fn uniform(&self, floor: f32) -> [[f32; 4]; 2] {
        [[self.centre[0], self.centre[1], floor, self.half], [self.cell, self.cell * GRID_MAJOR_EVERY, 0.0, 0.0]]
    }
}

/// Note: scene.ts's grid is a raw ShaderMaterial, so three.js never encodes its output and the linear colours reach
/// the screen as if they were sRGB, far darker than their hex. This decodes them once more so the shader's encode
/// lands on those same values.
fn shown_raw(c: [f32; 4]) -> [f32; 4] {
    let d = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    [d(c[0]), d(c[1]), d(c[2]), c[3]]
}

/// `hex` pulled `amount` of the way to the grey of its own luminance.
pub fn muted(hex: u32, amount: f32) -> u32 {
    let [r, g, b] = [16, 8, 0].map(|s| ((hex >> s) & 0xff) as f32);
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let mix = |c: f32| (c + (y - c) * amount).round() as u32;
    (mix(r) << 16) | (mix(g) << 8) | mix(b)
}

/// gizmoScale.ts glyphScale: 1, or less once the glyph would cover too much of a model small on screen.
pub fn glyph_scale(glyph_px: f32, model_diagonal: Option<f32>, per_px: f32, min_scale: f32) -> f32 {
    let Some(diag) = model_diagonal.filter(|d| d.is_finite() && *d > 0.0) else { return 1.0 };
    if !(per_px.is_finite() && per_px > 0.0) {
        return 1.0;
    }
    let allowed = diag / per_px * GLYPH_MODEL_FRACTION;
    (allowed / glyph_px).clamp(min_scale, 1.0)
}

/// The triad as two triangle lists: the occluded ghost drawn over the model, and the solid part tested against it.
pub fn triad(view: &View, model_diagonal: Option<f32>) -> [Vec<DatumVertex>; 2] {
    let per_px = view.px(Vec3::ZERO);
    if !(per_px.is_finite() && per_px > 0.0) {
        return Default::default();
    }
    let unit = per_px * glyph_scale(TRIAD_LENGTH_PX, model_diagonal, per_px, MIN_TRIAD_SCALE);
    [TRIAD_OCCLUDED_OPACITY, TRIAD_OPACITY].map(|opacity| {
        let mut out = Vec::new();
        for (axis, hex) in AXIS_COLOR.into_iter().enumerate() {
            let tip = Vec3::AXES[axis] * TRIAD_LENGTH_PX * unit;
            let colour = muted(hex, AXIS_MUTE);
            let ends = [look::linear(colour, opacity), look::linear(colour, opacity * TIP_FADE)];
            strip(&mut out, view, Vec3::ZERO, tip, LINE_RADIUS_PX * unit, ends);
        }
        let dot_px = DOT_RADIUS_PX * unit / per_px;
        draw::disc(&mut out, view, Vec3::ZERO, dot_px, look::linear(DOT_COLOR, opacity));
        out
    })
}

/// A strip `radius` world units either side of `a` to `b`, facing the eye, its colour running from one end's to the
/// other's.
fn strip(out: &mut Vec<DatumVertex>, view: &View, a: Vec3, b: Vec3, radius: f32, ends: [[f32; 4]; 2]) {
    let side = |p: Vec3| (b - a).cross(p - view.eye()).normalize_or_zero() * radius;
    let (sa, sb) = (side(a), side(b));
    let v = |p: Vec3, color| DatumVertex { position: p.into(), color };
    out.extend([v(a - sa, ends[0]), v(b - sb, ends[1]), v(b + sb, ends[1])]);
    out.extend([v(a - sa, ends[0]), v(b + sb, ends[1]), v(a + sa, ends[0])]);
}

impl super::Viewport {
    /// The grid and the triad this frame draws, each under its overlay switch.
    pub(super) fn ground(&self, accent: u32) -> (Option<Grid>, [Vec<DatumVertex>; 2]) {
        use super::display::OverlayKind;
        let size = self.bounds.size;
        let (w, h) = (size.width.as_f32(), size.height.as_f32());
        let grid = self.display.shows(OverlayKind::Grid).then(|| {
            Grid::at(self.camera.target, self.camera.per_pixel(h), w.hypot(h), accent)
        });
        let triad = if self.display.shows(OverlayKind::Origin) {
            let diagonal = (!self.scene.bodies.is_empty()).then_some(self.radius * 2.0);
            triad(&View::new(&self.camera, h), diagonal)
        } else {
            Default::default()
        };
        (grid, triad)
    }
}
