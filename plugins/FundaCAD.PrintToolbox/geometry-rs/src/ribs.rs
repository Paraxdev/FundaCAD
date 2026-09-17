//! ptb_ribs.py: thin axial ridges inside a round hole for a self-tapping screw.

use std::f64::consts::PI;

use crate::g::{self, py_g};
use crate::read::{end_is_open, holes_from_faces, picked_faces};
use crate::{feature, F};

pub fn thread_ribs(f: &F) -> Result<(), String> {
    let label = "Thread-forming ribs";
    let raw_count = f.num("ribCount", 3.0)?;
    let count = raw_count.round_ties_even() as i64;
    if (raw_count - count as f64).abs() > 1e-9 || !(3..=8).contains(&count) {
        return Err(format!(
            "{label}: the rib count must be a whole number from 3 to 8 (got {})",
            py_g(raw_count)
        ));
    }
    let width = f.num("ribWidth", 0.6)?;
    if width <= 0.0 {
        return Err(format!("{label}: the rib width must be greater than 0 (got {})", py_g(width)));
    }
    let core_d = f.num("coreDiameter", 0.0)?;
    if core_d < 0.0 {
        return Err(format!("{label}: the core diameter cannot be negative"));
    }
    let start_depth = f.num("startDepth", 0.5)?;
    if start_depth < 0.0 {
        return Err(format!("{label}: the start depth cannot be negative"));
    }

    let mut staged = Vec::new();
    for (body, shape, faces) in picked_faces(label)? {
        let mut tools = Vec::new();
        for hole in holes_from_faces(&shape, &faces, label)? {
            let r = hole.radius;
            let core_r = if core_d > 0.0 { core_d / 2.0 } else { 0.8 * r };
            if !(0.0 < core_r && core_r < r) {
                return Err(format!(
                    "{label}: the core diameter must be between 0 and the hole diameter of {} mm",
                    py_g(2.0 * r)
                ));
            }
            let chord = 2.0 * r * (PI / count as f64).sin();
            if width >= chord {
                return Err(format!(
                    "{label}: {count} ribs of {} mm would overlap around a {} mm hole, use fewer ribs or a narrower width",
                    py_g(width),
                    py_g(2.0 * r)
                ));
            }
            let probe = (0.05 * r).max(0.01);
            let start = hole.t0 + if end_is_open(&shape, &hole, true, probe) { start_depth } else { 0.0 };
            let end = hole.t1 - if end_is_open(&shape, &hole, false, probe) { start_depth } else { 0.0 };
            let length = end - start;
            if length <= 0.0 {
                return Err(format!(
                    "{label}: the start depth leaves nothing of the {} mm hole to rib",
                    py_g(hole.t1 - hole.t0)
                ));
            }
            let base = g::lin(hole.origin, &[(start, hole.axis)]);
            for k in 0..count {
                let (up, side) = g::perp_frame_rotated(hole.axis, k as f64 * 2.0 * PI / count as f64);
                let pts = [
                    g::lin(base, &[(core_r, up), (-width / 2.0, side)]),
                    g::lin(base, &[(r, up), (-width / 2.0, side)]),
                    g::lin(base, &[(r, up), (width / 2.0, side)]),
                    g::lin(base, &[(core_r, up), (width / 2.0, side)]),
                ];
                tools.push(g::prism(&pts, g::mul(hole.axis, length))?);
            }
        }
        staged.push((body, g::fuse(&shape, &tools, label)?));
    }
    for (body, out) in staged {
        feature::set_body_shape(body, &out)?;
    }
    Ok(())
}
