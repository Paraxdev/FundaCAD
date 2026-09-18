//! scr_thread.py: modelled helical threads, cut with the kernel's helical
//! sweep (a revolve that climbs).
//!
//! The groove is the 60 degree triangle src/features/threadMath.ts draws: ISO
//! 68-1's basic depth of 0.6134 P, pushed past the cylinder it cuts so the
//! boolean is never tangent. It is cut into a plain cylinder one turn per tool,
//! all tools in one boolean: a long helical tool running nearly parallel to the
//! cylinder defeats the kernel, the cut reports success and removes nothing.

use std::f64::consts::PI;

use crate::fundacad::plugin::types::{BooleanOp, BooleanOptions, Fuzzy};
use crate::kernel;
use crate::shapes::R;
use crate::Shape;

const DEPTH: f64 = 0.6134;
const BREAKOUT_RATIO: f64 = 0.15;
const BREAKOUT_FLOOR: f64 = 0.02;
const MINOR_OFFSET: f64 = 0.54127;

fn half_width() -> f64 {
    DEPTH * (PI / 6.0).tan()
}

fn groove(radius: f64, pitch: f64, external: bool, z0: f64) -> R<Shape> {
    let depth = pitch * DEPTH;
    let half = pitch * half_width();
    let breakout = BREAKOUT_FLOOR.max(depth * BREAKOUT_RATIO);
    let apex = if external { radius - depth } else { radius + depth };
    let base = if external { radius + breakout } else { radius - breakout };
    kernel::polygon_face(&[(base, 0.0, z0 - half), (base, 0.0, z0 + half), (apex, 0.0, z0)])
}

fn tools(radius: f64, pitch: f64, bottom: f64, top: f64, external: bool, left: bool, per_tool: f64) -> R<Vec<Shape>> {
    let total = (top - bottom) / pitch;
    let mut out = Vec::new();
    let mut done = 0.0;
    while done < total - 1e-9 {
        let turns = per_tool.min(total - done);
        let (z0, climb) = if left {
            (top - done * pitch, -pitch)
        } else {
            (bottom + done * pitch, pitch)
        };
        let face = groove(radius, pitch, external, z0)?;
        out.push(kernel::helical_sweep(&face, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 360.0 * turns, climb)?);
        done += turns;
    }
    Ok(out)
}

/// What the groove should take out of `span` mm of cylinder: the part of the
/// triangle inside the material, swept round its centroid.
fn groove_volume(radius: f64, pitch: f64, external: bool, span: f64) -> f64 {
    let depth = pitch * DEPTH;
    let breakout = BREAKOUT_FLOOR.max(depth * BREAKOUT_RATIO);
    let half_at_surface = pitch * half_width() * depth / (depth + breakout);
    let centroid = if external { radius - depth / 3.0 } else { radius + depth / 3.0 };
    depth * half_at_surface * 2.0 * PI * centroid * span / pitch
}

/// (turns per tool, phase in pitches). Measured on M1.6 to M24: one turn per
/// tool cut every case cleanly; the others rescue the rare case it does not.
const STRATEGIES: [(f64, f64); 3] = [(1.0, 0.0), (2.0, 0.0), (2.0, 0.37)];

fn serial_cut(body: &Shape, tools: &[Shape]) -> R<Shape> {
    let refs: Vec<&Shape> = tools.iter().collect();
    kernel::boolean_with(
        BooleanOp::Cut,
        body,
        &refs,
        BooleanOptions {
            parallel: false,
            fuzzy: Fuzzy::Picked,
            clean: true,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn cut_groove(body: &Shape, radius: f64, pitch: f64, z_from: f64, z_to: f64, external: bool, left: bool, span: f64) -> R<Shape> {
    let want = groove_volume(radius, pitch, external, span);
    let before = body.volume();
    for (per_tool, phase) in STRATEGIES {
        let bottom = z_from - pitch * (1.0 + phase);
        let top = z_to + pitch * phase;
        let Ok(out) = tools(radius, pitch, bottom, top, external, left, per_tool).and_then(|t| serial_cut(body, &t)) else {
            continue;
        };
        let solids = out.solids();
        if solids.len() != 1 || !out.is_valid() {
            continue;
        }
        if ((before - out.volume()) - want).abs() <= 0.1 * want {
            return Ok(solids.into_iter().next().expect("one solid"));
        }
    }
    Err("Fastener: the kernel could not cut this modelled thread, use a simplified thread".into())
}

pub fn cut_external(body: &Shape, d: f64, pitch: f64, z_from: f64, z_to: f64, left: bool) -> R<Shape> {
    cut_groove(body, d / 2.0, pitch, z_from, z_to, true, left, z_to - z_from)
}

pub fn minor_radius(d: f64, pitch: f64) -> f64 {
    d / 2.0 - MINOR_OFFSET * pitch
}

pub fn cut_internal(body: &Shape, d: f64, pitch: f64, z_from: f64, z_to: f64, left: bool) -> R<Shape> {
    cut_groove(body, minor_radius(d, pitch), pitch, z_from, z_to + pitch, false, left, z_to - z_from)
}
